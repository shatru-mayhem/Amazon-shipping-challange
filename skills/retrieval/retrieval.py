"""retrieval — the single point of contact between downstream skills and
raw source text (tender documents + emails).

Contract: a downstream process asks for one (table, field) it needs.
retrieve() always returns before the caller proceeds — synchronously,
in-process, no queue, no async handoff — and the response is always one
of exactly two shapes:

    {"status": "found",     "value": ..., "confidence": ..., "source": ...}
    {"status": "not_found", "reason": "<why, specifically>"}

"Not found" is a valid, complete response — never an exception, never a
silent None, never something the caller has to poll for. If a caller gets
"not_found" it has everything it needs to log a run_flag (see
tender-analysis-schema.sql SECTION 6) and either proceed with a gap noted
or halt — retrieval itself never blocks waiting for more source data to
show up.

Scope is exactly the 4 tables identified in RETRIEVAL_REQUIREMENTS.md —
everything else a downstream skill reads is either internal Amazon
reference data or pure computation over these:

    from retrieval import retrieve
    result = retrieve(opportunity_id, "opportunity_features", "volume")
    result = retrieve(opportunity_id, "tender_constraints")
    result = retrieve(opportunity_id, "client_highlights", "pain_point")
    result = retrieve(opportunity_id, "email_messages")

Models: nomic-embed-text (local, always — no cloud embedding models exist)
for similarity matching; GENERATE_MODEL (cloud gpt-oss:20b-cloud, or local
llama3.2 fallback — see _llm.py) for extraction/classification prompts.
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)

from _db import run_sql  # noqa: E402
from _llm import embed, generate_json, cosine_similarity  # noqa: E402

CHUNK_TEXT_CAP = 8000          # chars of source text handed to one prompt
CONSTRAINT_SIM_THRESHOLD = 0.60  # nomic-embed cosine sim to accept a catalog match
EMAIL_SIM_THRESHOLD = 0.65       # cosine sim to accept a reply as "resolves this question"

HIGHLIGHT_TYPES = ["growth_objective", "pain_point", "stated_priority", "past_complaint"]

OPPORTUNITY_FEATURE_SPECS = {
    "volume": "Expected daily/monthly parcel volume — a number.",
    "lanes": "Origin/destination lane pairs — a JSON array of {origin, destination}.",
    "geography": "Countries/regions delivery is required in — a JSON array of strings.",
    "industry_vertical": "The client's industry (e.g. retail, e-commerce, pharma) — a short string.",
    "contract_length_months": "Contract duration in months — an integer.",
    "required_sla_hours": "Required delivery SLA in hours — a number.",
    "incumbent_provider": "Name of the current/incumbent logistics provider — a string.",
    "requested_discount_pct": "Requested discount off list price — a number, e.g. 12.5 for 12.5%.",
}


def _response(opportunity_id, table, field, status, value=None, confidence=None, reason=None, source=None):
    resp = {"opportunity_id": opportunity_id, "table": table, "field": field, "status": status}
    if status == "found":
        resp["value"] = value
        if confidence is not None:
            resp["confidence"] = confidence
        if source is not None:
            resp["source"] = source
    else:
        resp["reason"] = reason or "not found"
    return resp


def _found(opportunity_id, table, field, value, confidence=None, source=None):
    return _response(opportunity_id, table, field, "found", value=value, confidence=confidence, source=source)


def _not_found(opportunity_id, table, field, reason):
    return _response(opportunity_id, table, field, "not_found", reason=reason)


# ---------------------------------------------------------------------
# opportunity_features — structured field extraction from tender text
# ---------------------------------------------------------------------

def _challenge_doc_chunks(opportunity_id):
    return run_sql(
        """SELECT dc.chunk_id, dc.raw_text
           FROM document_chunks dc
           JOIN documents d ON d.document_id = dc.document_id
           WHERE d.opportunity_id = %s AND d.source_type = 'challenge_doc'
           ORDER BY dc.page_number NULLS LAST""",
        (opportunity_id,),
    )


def _retrieve_opportunity_feature(opportunity_id, field):
    if field not in OPPORTUNITY_FEATURE_SPECS:
        return _not_found(
            opportunity_id, "opportunity_features", field,
            f"'{field}' is not a recognized opportunity_features field",
        )

    chunks = _challenge_doc_chunks(opportunity_id)
    if not chunks:
        return _not_found(
            opportunity_id, "opportunity_features", field,
            "no challenge_doc text ingested for this opportunity yet",
        )

    text = "\n\n".join(c["raw_text"] for c in chunks)[:CHUNK_TEXT_CAP]
    prompt = f"""Source text from a client's tender/contract document:
---
{text}
---
Extract this field: {field} — {OPPORTUNITY_FEATURE_SPECS[field]}
Respond with JSON: {{"found": true/false, "value": <value matching the described type, or null>, "confidence": <0-1 float>}}.
Set "found" to false and "value" to null if this field is not stated anywhere in the source text above — never guess or invent a value."""

    result = generate_json(prompt)
    if not result.get("found") or result.get("value") in (None, "", []):
        return _not_found(
            opportunity_id, "opportunity_features", field,
            "field not stated in ingested source text",
        )

    return _found(
        opportunity_id, "opportunity_features", field,
        value=result["value"],
        confidence=result.get("confidence"),
        source={"chunk_ids": [c["chunk_id"] for c in chunks]},
    )


# ---------------------------------------------------------------------
# tender_constraints — extract stated constraints, classify against
# constraint_catalog by embedding similarity
# ---------------------------------------------------------------------

def _retrieve_tender_constraints(opportunity_id, field=None):
    chunks = _challenge_doc_chunks(opportunity_id)
    if not chunks:
        return _not_found(
            opportunity_id, "tender_constraints", field,
            "no challenge_doc text ingested for this opportunity yet",
        )

    catalog = run_sql(
        "SELECT constraint_type_id, name, description FROM constraint_catalog WHERE active = TRUE"
    )
    if not catalog:
        return _not_found(opportunity_id, "tender_constraints", field, "constraint_catalog is empty")

    catalog_embeddings = {
        row["constraint_type_id"]: embed(f"{row['name']}: {row['description'] or ''}")
        for row in catalog
    }

    extracted = []
    for c in chunks:
        prompt = f"""Source text:
---
{c['raw_text'][:CHUNK_TEXT_CAP]}
---
List every distinct requirement/constraint stated in this text (e.g. geography coverage, weight/size limits, SLA, insurance, legal terms, financial terms). Respond with JSON: {{"constraints": [{{"stated_text": "...", "stated_value": "... or null"}}]}}. Respond with {{"constraints": []}} if none are stated."""
        result = generate_json(prompt)
        for item in result.get("constraints", []):
            if not isinstance(item, dict) or not item.get("stated_text"):
                continue
            extracted.append({**item, "source_chunk_id": c["chunk_id"]})

    if not extracted:
        return _not_found(
            opportunity_id, "tender_constraints", field,
            "no constraint statements found in source text",
        )

    matched = []
    for item in extracted:
        vec = embed(item["stated_text"])
        best_id, best_score = None, -1.0
        for cid, cvec in catalog_embeddings.items():
            score = cosine_similarity(vec, cvec)
            if score > best_score:
                best_id, best_score = cid, score

        catalog_hit = best_score >= CONSTRAINT_SIM_THRESHOLD
        matched.append({
            **item,
            "matched_constraint_type_id": best_id if catalog_hit else None,
            "matched_constraint_name": (
                next(r["name"] for r in catalog if r["constraint_type_id"] == best_id) if catalog_hit else None
            ),
            "similarity": round(best_score, 3),
        })

    if field:
        matched = [m for m in matched if m["matched_constraint_name"] == field]
        if not matched:
            return _not_found(
                opportunity_id, "tender_constraints", field,
                f"no constraint statement matched to catalog entry '{field}'",
            )

    return _found(
        opportunity_id, "tender_constraints", field,
        value=matched,
        source={"chunk_ids": [c["chunk_id"] for c in chunks]},
    )


# ---------------------------------------------------------------------
# client_highlights — pains / priorities / objectives / complaints, from
# tender documents AND emails (two separate source systems)
# ---------------------------------------------------------------------

def _all_source_snippets(opportunity_id):
    doc_chunks = run_sql(
        """SELECT dc.chunk_id AS source_id, dc.raw_text AS text, 'document' AS source_type
           FROM document_chunks dc
           JOIN documents d ON d.document_id = dc.document_id
           WHERE d.opportunity_id = %s""",
        (opportunity_id,),
    )
    emails = run_sql(
        """SELECT em.message_id AS source_id, em.body_redacted AS text, 'email' AS source_type
           FROM email_messages em
           JOIN email_threads et ON et.thread_id = em.thread_id
           WHERE et.opportunity_id = %s""",
        (opportunity_id,),
    )
    return doc_chunks + emails


def _retrieve_client_highlights(opportunity_id, field=None):
    snippets = _all_source_snippets(opportunity_id)
    if not snippets:
        return _not_found(
            opportunity_id, "client_highlights", field,
            "no documents or emails ingested for this opportunity",
        )

    highlights = []
    for s in snippets:
        prompt = f"""Source text ({s['source_type']}):
---
{s['text'][:CHUNK_TEXT_CAP]}
---
Identify any client growth objectives, pain points, stated priorities, or past complaints in this text. Respond with JSON: {{"highlights": [{{"highlight_type": one of {HIGHLIGHT_TYPES}, "text": "..."}}]}}. Respond with {{"highlights": []}} if none are present."""
        result = generate_json(prompt)
        for h in result.get("highlights", []):
            # generate_json's response shape isn't schema-enforced — a model
            # can return a bare string instead of {"highlight_type":...,
            # "text":...}. Skip anything malformed rather than crash.
            if not isinstance(h, dict) or h.get("highlight_type") not in HIGHLIGHT_TYPES:
                continue
            highlights.append({**h, "source_type": s["source_type"], "source_id": s["source_id"]})

    if field:
        highlights = [h for h in highlights if h["highlight_type"] == field]

    if not highlights:
        reason = f"no '{field}' highlights found" if field else "no highlights identified in available text"
        return _not_found(opportunity_id, "client_highlights", field, reason)

    return _found(opportunity_id, "client_highlights", field, value=highlights)


# ---------------------------------------------------------------------
# email_messages — which unresolved questions have a reply that answers
# them (semantic match within a thread), from the email/CRM system
# ---------------------------------------------------------------------

def _thread_messages(opportunity_id):
    return run_sql(
        """SELECT em.message_id, em.thread_id, em.sent_at, em.sender, em.body_redacted, em.resolved
           FROM email_messages em
           JOIN email_threads et ON et.thread_id = em.thread_id
           WHERE et.opportunity_id = %s
           ORDER BY em.thread_id, em.sent_at""",
        (opportunity_id,),
    )


def _retrieve_email_resolution(opportunity_id, field=None):
    messages = _thread_messages(opportunity_id)
    if not messages:
        return _not_found(opportunity_id, "email_messages", field, "no email threads found for this opportunity")

    unresolved = [m for m in messages if not m["resolved"]]
    if field:
        unresolved = [m for m in unresolved if str(m["message_id"]) == str(field)]
        if not unresolved:
            return _not_found(
                opportunity_id, "email_messages", field,
                f"message {field} not found, or already resolved, for this opportunity",
            )

    if not unresolved:
        return _not_found(opportunity_id, "email_messages", field, "no unresolved messages for this opportunity")

    resolutions = []
    for msg in unresolved:
        candidates = [
            m for m in messages
            if m["thread_id"] == msg["thread_id"] and m["sent_at"] > msg["sent_at"]
        ]
        if not candidates:
            continue

        msg_vec = embed(msg["body_redacted"])
        best_msg, best_score = None, -1.0
        for cand in candidates:
            score = cosine_similarity(msg_vec, embed(cand["body_redacted"]))
            if score > best_score:
                best_msg, best_score = cand, score

        if best_score >= EMAIL_SIM_THRESHOLD:
            resolutions.append({
                "message_id": msg["message_id"],
                "resolved_by_message_id": best_msg["message_id"],
                "similarity": round(best_score, 3),
            })

    if not resolutions:
        return _not_found(
            opportunity_id, "email_messages", field,
            "no resolving reply found above confidence threshold for any unresolved message",
        )

    return _found(opportunity_id, "email_messages", field, value=resolutions)


# ---------------------------------------------------------------------
# Dispatcher — the one function downstream processes call
# ---------------------------------------------------------------------

_TABLE_HANDLERS = {
    "opportunity_features": _retrieve_opportunity_feature,
    "tender_constraints": _retrieve_tender_constraints,
    "client_highlights": _retrieve_client_highlights,
    "email_messages": _retrieve_email_resolution,
}


def retrieve(opportunity_id: str, table: str, field: str = None) -> dict:
    """The retrieval engine's single entrypoint. Synchronous: the caller
    gets a complete answer — found or not_found — before it proceeds.
    Never raises for missing data; only raises if `table` itself isn't
    one retrieval knows how to serve at all (a caller bug, not a data gap)."""
    handler = _TABLE_HANDLERS.get(table)
    if handler is None:
        raise ValueError(
            f"retrieval has no handler for table '{table}' — valid tables: {list(_TABLE_HANDLERS)}"
        )
    return handler(opportunity_id, field)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python retrieval.py <opportunity_id> <table> [field]")
        print(f"       tables: {list(_TABLE_HANDLERS)}")
        sys.exit(1)

    opp_id = sys.argv[1]
    table_arg = sys.argv[2]
    field_arg = sys.argv[3] if len(sys.argv) > 3 else None
    print(json.dumps(retrieve(opp_id, table_arg, field_arg), indent=2, default=str))
