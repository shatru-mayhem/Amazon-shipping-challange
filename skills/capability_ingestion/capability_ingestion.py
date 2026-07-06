"""capability_ingestion — proposes updates to Amazon's OWN ground-truth
amazon_capability_profile from an internal policy document (e.g. an Ops
capability-change memo: "we can now cover France"), using the same
FAISS-gated matching approach retrieval.py uses for tender_constraints —
just pointed at Amazon's own capability instead of a client's stated
requirement.

Never writes to amazon_capability_profile directly. A wrong
tender_constraints extraction only affects one opportunity; a wrong
capability_profile update would silently corrupt every future
opportunity's compliance/risk/pricing checks against that constraint
type — the exact mistake the hard-blocker system exists to catch. So
every proposal lands in amazon_capability_update_queue (status=
'pending') and only an explicit approve_proposal() call — a human
action — commits it.

    from capability_ingestion import (
        run_demo_ingestion, list_pending_proposals, approve_proposal, reject_proposal,
    )

run_demo_ingestion() is the only entrypoint that ever runs this pipeline
in the demo — nothing happens automatically or on a schedule; it only
executes when explicitly invoked (e.g. a UI button click), against a
hardcoded internal memo tagged is_demo=true, never a real upload.
"""

import os
import sys
import json
import hashlib
from psycopg2.extras import Json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "retrieval"))

from _db import run_sql, run_sql_one  # noqa: E402
from _ingestion_db import write_sql, write_sql_one  # noqa: E402
from _llm import generate_json  # noqa: E402
from vector_store import VectorStore  # noqa: E402

SKILL_NAME = "capability_ingestion"
RELEVANCE_THRESHOLD = 0.35  # same bar as retrieval.py's tender_constraints
RETRIEVAL_K = 3
CHUNK_MAX_CHARS = 2000

DEMO_MEMO_TEXT = """Ops Capability Update — Effective 1 August 2026

Amazon Shipping is expanding delivery coverage. Effective 1 August 2026, mainland France is now covered under standard service, at a 1.2x cost multiplier versus domestic Spanish Peninsula rates.

This expansion does NOT yet include Portugal, the Canary Islands, Ceuta, or Melilla, which remain out of scope for standard service.

All other terms of the existing Delivery region capability profile remain unchanged."""


def _chunk_text(text: str, max_chars: int = CHUNK_MAX_CHARS) -> list:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, current = [], ""
    for p in paragraphs:
        if current and len(current) + len(p) + 2 > max_chars:
            chunks.append(current)
            current = p
        else:
            current = current + "\n\n" + p if current else p
    if current:
        chunks.append(current)
    return chunks or [text.strip()]


def _ingest_memo_document(memo_text: str, filename: str, is_demo: bool) -> dict:
    """Writes the memo as a core.documents row (source_type=
    'internal_policy', opportunity_id=NULL — this isn't about one
    opportunity) + its chunks, via the same app_ingestion write path
    tender_ingestion.ts uses."""
    file_hash = hashlib.sha256(memo_text.encode()).hexdigest()
    document = write_sql_one(
        """INSERT INTO documents (opportunity_id, filename, source_type, blob_url, file_hash)
           VALUES (NULL, %s, 'internal_policy', %s, %s)
           RETURNING *""",
        (filename, f"{'demo' if is_demo else 'internal'}/{filename}", file_hash),
    )
    chunks = [
        write_sql_one(
            """INSERT INTO document_chunks (document_id, section_heading, page_number, raw_text)
               VALUES (%s, NULL, %s, %s)
               RETURNING *""",
            (document["document_id"], i + 1, text),
        )
        for i, text in enumerate(_chunk_text(memo_text))
    ]
    return {"document": document, "chunks": chunks}


def _propose_updates_from_chunks(chunks: list, source_document_id, is_demo: bool) -> list:
    """FAISS-gated, same shape as retrieval.py's _retrieve_tender_constraints:
    only ask the LLM about a catalog constraint type if the memo actually
    has text relevant to it — never send the whole memo blind to every
    constraint type."""
    catalog = run_sql("SELECT constraint_type_id, name, description FROM constraint_catalog WHERE active = TRUE")
    store = VectorStore(chunks, text_key="raw_text", id_key="chunk_id")

    written = []
    for row in catalog:
        query = f"{row['name']}: {row['description'] or ''}"
        hits = store.search(query, k=RETRIEVAL_K)
        if not hits or hits[0]["score"] < RELEVANCE_THRESHOLD:
            continue

        seen_ids = set()
        relevant_text = []
        for hit in hits:
            if hit["item"]["chunk_id"] in seen_ids:
                continue
            seen_ids.add(hit["item"]["chunk_id"])
            relevant_text.append(hit["item"]["raw_text"])

        # constraint_compliance.py's _evaluate() reads structured_value by
        # specific key names (covered_regions/not_covered/max_weight_kg/
        # etc.) — an LLM asked to freely invent "a JSON object capturing
        # the facts" will happily rename or drop keys, which silently
        # breaks compliance checking for every future opportunity even
        # though the proposal reads as factually correct (verified the
        # hard way: approving an unconstrained proposal made Tecnomania's
        # real "Portugal not covered" hard-blocker vanish, because the new
        # structured_value had no not_covered key at all). Showing the
        # current row and requiring an incremental edit prevents this.
        existing = run_sql_one(
            "SELECT capability_status, structured_value, conditions_text FROM amazon_capability_profile WHERE constraint_type_id = %s",
            (row["constraint_type_id"],),
        )
        existing_text = (
            f"Amazon's CURRENT capability profile for this requirement type:\n"
            f"  capability_status: {existing['capability_status']}\n"
            f"  structured_value: {json.dumps(existing['structured_value'])}\n"
            f"  conditions_text: {existing['conditions_text']}\n"
            if existing else "Amazon has no existing capability profile row for this requirement type yet.\n"
        )

        prompt = f"""Source text (an internal Amazon Shipping operations/capability update document):
---
{chr(10).join(relevant_text)}
---
Requirement type: {row['name']} — {row['description'] or ''}

{existing_text}
Does this text propose a CHANGE to Amazon's capability for this specific requirement type? Respond with JSON:
{{"proposes_change": true/false, "capability_status": "can_do" | "cannot_do" | "can_do_with_conditions" | null, "structured_value": <the FULL updated structured_value — start from the CURRENT one above and only add/modify the specific facts this document states; keep every existing key name and every existing fact this document doesn't mention (e.g. if the current value has "not_covered", the updated value must still have "not_covered" with anything not newly covered still listed) — or null>, "conditions_text": "<free text conditions, or null>"}}
Set "proposes_change" to false if this text doesn't actually change Amazon's capability for this requirement type — never invent a change that isn't clearly stated, and never rename or drop an existing key/fact that this document doesn't address."""
        result = generate_json(prompt, skill=SKILL_NAME)
        if not result.get("proposes_change") or not result.get("capability_status"):
            continue

        first_chunk_id = sorted(seen_ids)[0]
        structured_value = result.get("structured_value")
        proposal = write_sql_one(
            """INSERT INTO amazon_capability_update_queue
                 (constraint_type_id, proposed_capability_status, proposed_structured_value,
                  proposed_conditions_text, source_document_id, source_chunk_id, raw_text, confidence, is_demo)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING *""",
            (
                row["constraint_type_id"],
                result["capability_status"],
                Json(structured_value) if structured_value is not None else None,
                result.get("conditions_text"),
                source_document_id,
                first_chunk_id,
                chr(10).join(relevant_text)[:2000],
                round(hits[0]["score"], 3),
                is_demo,
            ),
        )
        written.append(proposal)
    return written


def run_demo_ingestion() -> dict:
    """The only entrypoint that ever runs this pipeline in the demo.
    Nothing happens automatically — only executes when explicitly
    invoked. Uses a hardcoded internal memo, not a real upload; all
    resulting rows (document, chunks, proposals) are tagged is_demo."""
    ingested = _ingest_memo_document(DEMO_MEMO_TEXT, "demo_ops_capability_memo.txt", is_demo=True)
    proposals = _propose_updates_from_chunks(
        ingested["chunks"], ingested["document"]["document_id"], is_demo=True
    )
    return {
        "document_id": str(ingested["document"]["document_id"]),
        "chunks_ingested": len(ingested["chunks"]),
        "proposals_created": len(proposals),
        "proposals": proposals,
    }


def list_pending_proposals() -> list:
    return run_sql(
        """SELECT q.update_id, q.constraint_type_id, cc.name AS constraint_name,
                  q.proposed_capability_status, q.proposed_structured_value, q.proposed_conditions_text,
                  q.raw_text, q.confidence, q.is_demo, q.status, q.created_at
           FROM amazon_capability_update_queue q
           JOIN constraint_catalog cc ON cc.constraint_type_id = q.constraint_type_id
           WHERE q.status = 'pending'
           ORDER BY q.created_at DESC"""
    )


def approve_proposal(update_id: str, reviewer_id: str) -> dict:
    """The one place this whole pipeline is allowed to write to
    amazon_capability_profile — a true upsert (ON CONFLICT
    constraint_type_id, its existing UNIQUE constraint), and it
    deliberately does NOT touch owner_team on update, so an existing
    row's ownership isn't silently reassigned by an approval action."""
    proposal = run_sql_one(
        "SELECT * FROM amazon_capability_update_queue WHERE update_id = %s", (update_id,)
    )
    if not proposal:
        return {"ok": False, "error": "Proposal not found."}
    if proposal["status"] != "pending":
        return {"ok": False, "error": f"Proposal already {proposal['status']}."}

    # Capture the pre-image before overwriting, so a demo approval can later
    # be undone via reset_demo_capability_changes() without guessing what
    # the row looked like before.
    existing = run_sql_one(
        "SELECT capability_status, structured_value, conditions_text FROM amazon_capability_profile WHERE constraint_type_id = %s",
        (proposal["constraint_type_id"],),
    )

    structured_value = proposal["proposed_structured_value"]
    write_sql(
        """INSERT INTO amazon_capability_profile
             (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
           VALUES (%s, %s, %s, %s, 'Operations')
           ON CONFLICT (constraint_type_id) DO UPDATE SET
             capability_status = EXCLUDED.capability_status,
             structured_value = EXCLUDED.structured_value,
             conditions_text = EXCLUDED.conditions_text,
             last_reviewed_at = now()""",
        (
            proposal["constraint_type_id"],
            proposal["proposed_capability_status"],
            Json(structured_value) if structured_value is not None else None,
            proposal["proposed_conditions_text"],
        ),
    )
    write_sql(
        """UPDATE amazon_capability_update_queue
           SET status = 'approved', reviewer_id = %s, reviewed_at = now(),
               previous_row_existed = %s, previous_capability_status = %s,
               previous_structured_value = %s, previous_conditions_text = %s
           WHERE update_id = %s""",
        (
            reviewer_id,
            existing is not None,
            existing["capability_status"] if existing else None,
            Json(existing["structured_value"]) if existing and existing["structured_value"] is not None else None,
            existing["conditions_text"] if existing else None,
            update_id,
        ),
    )
    return {"ok": True}


def reset_demo_capability_changes() -> dict:
    """Undoes every demo-approved capability change, restoring
    amazon_capability_profile to what it looked like before the demo ran.
    Only ever touches rows created by run_demo_ingestion() (is_demo=TRUE) —
    a real, non-demo approval is never reset. Safe to call repeatedly:
    already-reset rows are excluded by the status='approved' filter."""
    approved_demo = run_sql(
        """SELECT update_id, constraint_type_id, previous_row_existed,
                  previous_capability_status, previous_structured_value, previous_conditions_text
           FROM amazon_capability_update_queue
           WHERE is_demo = TRUE AND status = 'approved'
           ORDER BY reviewed_at DESC"""
    )
    reverted = []
    for row in approved_demo:
        if row["previous_row_existed"]:
            write_sql(
                """UPDATE amazon_capability_profile
                   SET capability_status = %s, structured_value = %s, conditions_text = %s, last_reviewed_at = now()
                   WHERE constraint_type_id = %s""",
                (
                    row["previous_capability_status"],
                    Json(row["previous_structured_value"]) if row["previous_structured_value"] is not None else None,
                    row["previous_conditions_text"],
                    row["constraint_type_id"],
                ),
            )
        else:
            write_sql(
                "DELETE FROM amazon_capability_profile WHERE constraint_type_id = %s",
                (row["constraint_type_id"],),
            )
        write_sql(
            "UPDATE amazon_capability_update_queue SET status = 'reset' WHERE update_id = %s",
            (row["update_id"],),
        )
        reverted.append(str(row["update_id"]))
    return {"ok": True, "reverted_count": len(reverted), "reverted_update_ids": reverted}


def reject_proposal(update_id: str, reviewer_id: str) -> dict:
    write_sql(
        """UPDATE amazon_capability_update_queue
           SET status = 'rejected', reviewer_id = %s, reviewed_at = now()
           WHERE update_id = %s AND status = 'pending'""",
        (reviewer_id, update_id),
    )
    return {"ok": True}


if __name__ == "__main__":
    import json

    action = sys.argv[1] if len(sys.argv) > 1 else "run_demo"
    if action == "run_demo":
        print(json.dumps(run_demo_ingestion(), indent=2, default=str))
    elif action == "list_pending":
        print(json.dumps(list_pending_proposals(), indent=2, default=str))
    elif action == "approve":
        print(json.dumps(approve_proposal(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "cli"), indent=2, default=str))
    elif action == "reject":
        print(json.dumps(reject_proposal(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "cli"), indent=2, default=str))
    elif action == "reset_demo":
        print(json.dumps(reset_demo_capability_changes(), indent=2, default=str))
    else:
        print("Usage: python capability_ingestion.py [run_demo|list_pending|approve <update_id> [reviewer]|reject <update_id> [reviewer]|reset_demo]")
        sys.exit(1)
