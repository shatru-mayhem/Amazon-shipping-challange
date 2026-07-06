"""constraint_compliance — compare each tender_constraints row for an
opportunity against Amazon's amazon_capability_profile and persist a
verdict into constraint_compliance_results. Pure comparison over
already-structured JSON, no Gemini, no FAISS — the "computation, not
retrieval" step retrieval/SKILL.md already documents as out of scope for
retrieve().

    from constraint_compliance import check_compliance, persist_compliance
    computed = check_compliance(opportunity_id)   # read-only, no writes
    result = persist_compliance(opportunity_id)   # writes, idempotent

Run after persist.py's _persist_tender_constraints — this reads rows
that step just wrote.
"""

import os
import re
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)

from _db import run_sql  # noqa: E402
from _ingestion_db import write_sql  # noqa: E402

# structured_value keys that hold a hard numeric ceiling — checked
# regardless of capability_status, since a stated value clearing a
# can_do_with_conditions limit is still an unambiguous gap.
_NUMERIC_LIMIT_KEYS = ("max_weight_kg", "max_attempts")
# structured_value keys that hold an explicit "not allowed" list.
_EXCLUSION_KEYS = ("not_covered", "not_supported", "forbidden")
# structured_value keys that hold an explicit "allowed" list — used only
# to confirm a can_do_with_conditions match is a pricing note, not a gap.
_INCLUSION_KEYS = ("covered_regions", "supported")

_NUMBER_RE = re.compile(r"[-+]?\d*\.?\d+")


def _stated(row):
    value = row.get("stated_value")
    if isinstance(value, dict):
        value = value.get("value")
    return value, row.get("stated_text")


def _match_terms(value, text, terms):
    """Case-insensitive substring match of any of `terms` against the
    stated value/text. Deliberately simple string matching, not NLP —
    the terms are short catalog phrases (region/method/category names)."""
    haystack = " ".join(str(x) for x in (value, text) if x is not None).lower()
    for term in terms:
        if isinstance(term, str) and term.lower() in haystack:
            return term
    return None

def _extract_number(value, text):
    if isinstance(value, (int, float)):
        return float(value)
    for source in (value, text):
        if isinstance(source, str):
            m = _NUMBER_RE.search(source)
            if m:
                return float(m.group())
    return None


def _list_values(structured, keys):
    terms = []
    for k in keys:
        v = structured.get(k)
        if isinstance(v, list):
            terms.extend(v)
    return terms


def _numeric_limit(structured):
    for k in _NUMERIC_LIMIT_KEYS:
        if k in structured:
            return k, structured[k]
    return None, None


def _evaluate(row):
    """Returns (result, severity, gap_description, capability_id)."""
    name = row.get("constraint_name") or "Constraint"
    capability_id = row.get("capability_id")

    if capability_id is None:
        return (
            "unclear_needs_verification",
            "medium",
            f"No capability data exists for '{name}' — cannot check it against Amazon's capability profile.",
            None,
        )

    status = row.get("capability_status")
    structured = row.get("structured_value") or {}
    conditions_text = row.get("conditions_text")
    sv_value, sv_text = _stated(row)

    if status == "cannot_do":
        return (
            "unsatisfied",
            "high",
            conditions_text or f"Amazon cannot currently satisfy '{name}'.",
            capability_id,
        )

    exclusions = _list_values(structured, _EXCLUSION_KEYS)
    excluded_hit = _match_terms(sv_value, sv_text, exclusions) if exclusions else None
    if excluded_hit:
        return (
            "unsatisfied",
            "high",
            f"Stated requirement for '{name}' matches an explicit capability gap: '{excluded_hit}' is not covered/supported.",
            capability_id,
        )

    limit_key, limit_val = _numeric_limit(structured)
    if limit_key is not None and limit_val is not None:
        stated_num = _extract_number(sv_value, sv_text)
        if stated_num is not None:
            try:
                if float(stated_num) > float(limit_val):
                    return (
                        "unsatisfied",
                        "high",
                        f"Stated value ({stated_num}) for '{name}' exceeds capability limit ({limit_val}).",
                        capability_id,
                    )
            except (TypeError, ValueError):
                pass  # unparseable — fall through, don't guess

    inclusions = _list_values(structured, _INCLUSION_KEYS)
    included_hit = _match_terms(sv_value, sv_text, inclusions) if inclusions else None

    # An enumerated_list constraint with an explicit inclusion allowlist
    # (e.g. covered_regions: [Spanish Peninsula, Balearic Islands]) is a
    # closed world by construction — every seed row that ships one lists
    # it alongside its own not_covered/not_supported list as the same
    # closed set. A stated value that matches neither is not an unknown,
    # it's an item absent from the allowlist — e.g. "France" is in
    # neither covered_regions nor not_covered, but the allowlist's mere
    # existence means anything off it is uncovered. This must run before
    # the capability_status=='can_do' shortcut below — otherwise "can_do"
    # (Amazon covers *something* under this constraint type) gets read as
    # "covers the stated value", silently passing a region absent from
    # the allowlist. Only applies to enumerated_list types — free text /
    # numeric fields don't have a closed set to be absent from.
    if inclusions and row.get("data_type") == "enumerated_list" and not included_hit:
        return (
            "unsatisfied",
            "high",
            f"Stated requirement for '{name}' ({sv_value or sv_text}) is not listed among what Amazon "
            f"currently covers ({', '.join(str(i) for i in inclusions)}) — treated as a capability gap, "
            f"not just unverified, since the allowlist is exhaustive.",
            capability_id,
        )

    if status == "can_do":
        return ("satisfied", None, None, capability_id)

    # can_do_with_conditions and not caught by an explicit exclusion,
    # allowlist miss, or a blown numeric limit above — either it's a
    # known-covered item with a pricing/process condition attached
    # (satisfied, note the condition), or we genuinely can't tell and
    # shouldn't guess.
    # No exclusion/inclusion/limit lists at all in structured_value (e.g.
    # a flat fee-schedule dict like "Premium delivery feature") means
    # there's nothing to be excluded from — treat as satisfied-with-note.
    no_gap_shape = not exclusions and not inclusions and limit_key is None
    if included_hit or no_gap_shape:
        return ("satisfied", "low" if conditions_text else None, conditions_text, capability_id)

    return (
        "unclear_needs_verification",
        "medium",
        f"Could not unambiguously determine whether '{name}' is satisfied under the current capability conditions.",
        capability_id,
    )


# A constraint marked 'unsatisfied' here always means Amazon's capability
# profile explicitly cannot meet it (cannot_do, an explicit not_covered/
# not_supported/forbidden hit, an over-limit number, or absence from an
# exhaustive allowlist) — never a soft/negotiable gap, since anything
# ambiguous already falls back to unclear_needs_verification above. So
# 'unsatisfied' IS the hard-blocker signal; every downstream skill that
# reads constraint_compliance_results should treat it as one, consistently,
# for every constraint type — not just geography. Single source of truth
# here so that meaning can't drift between the skills that consume it.
def is_hard_blocker(result: str) -> bool:
    return result == "unsatisfied"


def _read_constraints_with_capabilities(opportunity_id):
    return run_sql(
        """
        SELECT tc.tender_constraint_id, tc.stated_value, tc.stated_text,
               cc.name AS constraint_name, cc.data_type,
               acp.capability_id, acp.capability_status,
               acp.structured_value, acp.conditions_text
        FROM tender_constraints tc
        LEFT JOIN constraint_catalog cc ON cc.constraint_type_id = tc.constraint_type_id
        LEFT JOIN amazon_capability_profile acp ON acp.constraint_type_id = tc.constraint_type_id
        WHERE tc.opportunity_id = %s
        """,
        (opportunity_id,),
    )


def check_compliance(opportunity_id: str) -> dict:
    """Read-only: computes a verdict per tender_constraint, no writes."""
    rows = _read_constraints_with_capabilities(opportunity_id)
    computed = []
    for row in rows:
        result, severity, gap, capability_id = _evaluate(row)
        computed.append({
            "tender_constraint_id": row["tender_constraint_id"],
            "capability_id": capability_id,
            "result": result,
            "severity": severity,
            "gap_description": gap,
            "constraint_name": row.get("constraint_name"),
        })
    return {"opportunity_id": opportunity_id, "compliance": computed}


def persist_compliance(opportunity_id: str) -> dict:
    """Delete-then-insert per opportunity, same idempotency shape as
    persist.py's _persist_tender_constraints."""
    computed = check_compliance(opportunity_id)["compliance"]
    write_sql("DELETE FROM constraint_compliance_results WHERE opportunity_id = %s", (opportunity_id,))
    for c in computed:
        write_sql(
            """INSERT INTO constraint_compliance_results
                 (opportunity_id, tender_constraint_id, capability_id, result, gap_description, severity)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (
                opportunity_id,
                c["tender_constraint_id"],
                c["capability_id"],
                c["result"],
                c["gap_description"],
                c["severity"],
            ),
        )
    return {"rows_written": len(computed)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python constraint_compliance.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(persist_compliance(sys.argv[1]), indent=2, default=str))
