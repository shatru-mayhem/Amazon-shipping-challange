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
from concurrent.futures import ThreadPoolExecutor

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)

from _db import run_sql  # noqa: E402
from _llm import embed, generate_json, cosine_similarity  # noqa: E402
from vector_store import VectorStore  # noqa: E402

CHUNK_TEXT_CAP = 8000          # chars of source text handed to one prompt
EMAIL_SIM_THRESHOLD = 0.65       # cosine sim to accept a reply as "resolves this question"

# tender_constraints: how many of a document's chunks to retrieve per
# catalog type, and the minimum FAISS cosine similarity a catalog type's
# best-matching chunk needs before bothering to call the LLM about it at
# all. Below this, that catalog type just isn't discussed in this
# document — skip the call entirely rather than force a guess.
CONSTRAINT_RETRIEVAL_K = 3
CONSTRAINT_RELEVANCE_THRESHOLD = 0.35

# tender_constraints/client_highlights each did one generate_json call per
# document_chunks row. A single tender doc can be a dozen-plus chunks, and
# each call is a network round-trip — so batch several chunks into one
# prompt (up to this many combined chars) before extracting, cutting the
# call count roughly (BATCH_TEXT_CHARS / average chunk size)-fold.
BATCH_TEXT_CHARS = 4000

# Both extraction loops are independent I/O (one call per batch/snippet),
# so running them concurrently cuts wall-clock time roughly WORKERS-fold
# instead of paying for every call serially — this only helps against the
# cloud model (network-bound); a local model on a CPU-only machine has no
# spare capacity to parallelize into, since every worker fights over the
# same CPU. Kept modest to avoid tripping cloud-account contention (a
# too-high value is what produced a 108s single-call stall in testing).
LLM_CALL_WORKERS = 3


def _batch_by_char_budget(items, text_key, id_key, max_chars=BATCH_TEXT_CHARS):
    """Groups a list of {text_key: str, id_key: ...} dicts into batches
    whose combined text stays under max_chars. Returns a list of
    {"text": combined_text, "ids": [id, ...]}. A single oversized item
    still gets its own batch rather than being split mid-content."""
    batches = []
    current_texts, current_ids, current_len = [], [], 0

    for item in items:
        text = item[text_key]
        if current_texts and current_len + len(text) > max_chars:
            batches.append({"text": "\n\n---\n\n".join(current_texts), "ids": current_ids})
            current_texts, current_ids, current_len = [], [], 0
        current_texts.append(text)
        current_ids.append(item[id_key])
        current_len += len(text)

    if current_texts:
        batches.append({"text": "\n\n---\n\n".join(current_texts), "ids": current_ids})
    return batches


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
    # Trust value over the found flag — see tender_constraints for why:
    # smaller local models have been observed returning found=false while
    # still filling in a real value. Also treat a literal "null" string
    # (another small-model quirk) the same as an actual null.
    value = result.get("value")
    if isinstance(value, str) and value.strip().lower() == "null":
        value = None
    if value in (None, "", []):
        return _not_found(
            opportunity_id, "opportunity_features", field,
            "field not stated in ingested source text",
        )

    return _found(
        opportunity_id, "opportunity_features", field,
        value=value,
        confidence=result.get("confidence"),
        source={"chunk_ids": [c["chunk_id"] for c in chunks]},
    )


# ---------------------------------------------------------------------
# tender_constraints — the catalog is small and known in advance, so
# there's no need to (1) ask the model to find arbitrary constraints
# then (2) separately embed+classify each one against the catalog.
# Just ask directly, per batch of source text: "which of these specific,
# named requirement types does this text state a value for?" One call
# per batch instead of two, and matches are exact (a name the model
# picked from the list) instead of a similarity-threshold guess.
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
    if field:
        catalog = [row for row in catalog if row["name"] == field]
    if not catalog:
        reason = f"'{field}' is not an active constraint_catalog entry" if field else "constraint_catalog is empty"
        return _not_found(opportunity_id, "tender_constraints", field, reason)

    # FAISS similarity search over this document's chunks, queried once
    # per catalog type — only chunks actually relevant to a given type
    # (e.g. "Delivery speed") ever reach the LLM for it, instead of every
    # catalog type seeing the whole document (which is what let a company
    # address get force-matched onto an unrelated constraint before).
    store = VectorStore(chunks, text_key="raw_text", id_key="chunk_id")

    def _unmatched(row, reason):
        return {
            "status": "unmatched",
            "constraint_name": row["name"],
            "constraint_type_id": str(row["constraint_type_id"]),
            "reason": reason,
        }

    def _check_one_constraint(row):
        query = f"{row['name']}: {row['description'] or ''}"
        hits = store.search(query, k=CONSTRAINT_RETRIEVAL_K)
        if not hits or hits[0]["score"] < CONSTRAINT_RELEVANCE_THRESHOLD:
            # No LLM call at all — nothing in the document is even
            # topically close to this constraint type.
            return _unmatched(row, "not discussed anywhere in the ingested document")

        # Dedup in case the same chunk_id appears twice across hits.
        seen_ids = set()
        relevant_text = []
        for hit in hits:
            if hit["item"]["chunk_id"] in seen_ids:
                continue
            seen_ids.add(hit["item"]["chunk_id"])
            relevant_text.append(hit["item"]["raw_text"])

        prompt = f"""Source text (already filtered to what's relevant to this one requirement):
---
{chr(10).join(relevant_text)[:CHUNK_TEXT_CAP]}
---
Requirement type: {row['name']} — {row['description'] or ''}

Does this text state a value for this specific requirement? Respond with JSON:
{{"found": true/false, "stated_text": "... or null", "stated_value": "... or null"}}
Set "found" to false if this requirement type genuinely isn't addressed — never force a match onto unrelated text."""
        result = generate_json(prompt)

        # Trust stated_text over the found flag — smaller local models
        # have been observed returning found=false while still filling in
        # a real stated_text (self-contradictory), so the boolean isn't
        # reliable on its own. Also normalize the literal string "null"
        # (another small-model quirk seen in testing) to real None.
        def _clean(v):
            return None if isinstance(v, str) and v.strip().lower() == "null" else v

        stated_text = _clean(result.get("stated_text"))
        if not stated_text:
            return _unmatched(row, "related text was found, but no specific value was stated for it")

        return {
            "status": "matched",
            "stated_text": stated_text,
            "stated_value": _clean(result.get("stated_value")),
            "source_chunk_ids": sorted(seen_ids),
            "matched_constraint_type_id": str(row["constraint_type_id"]),
            "matched_constraint_name": row["name"],
            "relevance_score": round(hits[0]["score"], 3),
        }

    with ThreadPoolExecutor(max_workers=LLM_CALL_WORKERS) as pool:
        results = list(pool.map(_check_one_constraint, catalog))

    matched = [r for r in results if r["status"] == "matched"]
    unmatched = [r for r in results if r["status"] == "unmatched"]

    # Every catalog constraint gets a verdict — matched with a value, or
    # unmatched with a specific reason — never silently dropped. Only
    # not_found (the top-level retrieve() contract) when nothing could be
    # checked at all, which the two early returns above already cover.
    return _found(
        opportunity_id, "tender_constraints", field,
        value={"matched": matched, "unmatched": unmatched},
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

    # Batch per source_type (not mixed) so highlights keep at least
    # type-level provenance — batching documents and emails together
    # would lose which type a given highlight actually came from.
    by_type = {}
    for s in snippets:
        by_type.setdefault(s["source_type"], []).append(s)

    batches = [
        {**b, "source_type": source_type}
        for source_type, items in by_type.items()
        for b in _batch_by_char_budget(items, text_key="text", id_key="source_id")
    ]

    def _extract_from_batch(batch):
        prompt = f"""Source text ({batch['source_type']}):
---
{batch['text'][:CHUNK_TEXT_CAP]}
---
Identify any client growth objectives, pain points, stated priorities, or past complaints in this text. Respond with JSON: {{"highlights": [{{"highlight_type": one of {HIGHLIGHT_TYPES}, "text": "..."}}]}}. Respond with {{"highlights": []}} if none are present."""
        result = generate_json(prompt)
        found = []
        for h in result.get("highlights", []):
            # generate_json's response shape isn't schema-enforced — a model
            # can return a bare string instead of {"highlight_type":...,
            # "text":...}. Skip anything malformed rather than crash.
            if not isinstance(h, dict) or h.get("highlight_type") not in HIGHLIGHT_TYPES:
                continue
            found.append({**h, "source_type": batch["source_type"], "source_ids": batch["ids"]})
        return found

    # One generate_json call per batch — independent network I/O, run
    # concurrently rather than serially (see LLM_CALL_WORKERS).
    with ThreadPoolExecutor(max_workers=LLM_CALL_WORKERS) as pool:
        highlights = [h for batch_result in pool.map(_extract_from_batch, batches) for h in batch_result]

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

    # Embed every message body exactly once (in parallel), instead of
    # re-embedding the same candidate repeatedly across comparisons —
    # both faster (one round-trip per message, not per pair) and avoids
    # redundant network calls entirely.
    with ThreadPoolExecutor(max_workers=LLM_CALL_WORKERS) as pool:
        vecs = list(pool.map(lambda m: embed(m["body_redacted"]), messages))
    body_vecs = {m["message_id"]: v for m, v in zip(messages, vecs)}

    resolutions = []
    for msg in unresolved:
        candidates = [
            m for m in messages
            if m["thread_id"] == msg["thread_id"] and m["sent_at"] > msg["sent_at"]
        ]
        if not candidates:
            continue

        msg_vec = body_vecs[msg["message_id"]]
        best_msg, best_score = None, -1.0
        for cand in candidates:
            score = cosine_similarity(msg_vec, body_vecs[cand["message_id"]])
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
