"""win_loss_signals — check each win_loss_signal_catalog entry against an
opportunity's already-computed data and persist a verdict into
signal_check_results, so win_probability.py (which reads that table) has
something to actually adjust its estimate with. Pure comparison, no
Gemini — same "computation, not retrieval" shape as constraint_compliance.

    from win_loss_signals import check_signals, persist_signals
    computed = check_signals(opportunity_id)   # read-only, no writes
    result = persist_signals(opportunity_id)    # writes, idempotent

Run after persist.py's constraint_compliance step — the one signal
currently in the catalog ("requires delivery to a region outside
Amazon's covered network") reads constraint_compliance_results for the
"Delivery region" constraint, not opportunity_features directly.

Why hook off constraint_compliance_results instead of re-deriving
"international" from opportunity_features.geography: that constraint's
compliance verdict is already the precise, capability-profile-aware
answer to "is the stated region covered or not" (see
constraint_compliance.py) — re-deriving a separate geography heuristic
here would just be a second, less accurate way of answering the same
question. The signal's strength (0.73, a log-odds delta) was computed
from real historical_tenders outcomes — see
skills/exploration/historical_archetypes.py and
supabase/seed_delivery_region_win_loss_signal (migration name:
grant_app_ingestion_win_loss_signals): opportunities requiring an
uncovered region win 35.3% of the time vs. 61.8% otherwise, and the
dominant loss reason for that segment is specifically "Geographic gap"
(47/74), not generic competitive loss ("Lost to competitor" was only
5/74) — i.e. it looks like a real Amazon-side capability gap, not just
noise.
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)

from _db import run_sql  # noqa: E402
from _ingestion_db import write_sql  # noqa: E402

DELIVERY_REGION_SIGNAL = "Requires delivery to a region outside Amazon's covered network"


def _check_delivery_region_gap(opportunity_id: str) -> str:
    """Returns a signal_check_results.status value by reading this
    opportunity's already-computed 'Delivery region' compliance verdict
    (constraint_compliance_results), not by re-deriving one."""
    row = run_sql(
        """
        SELECT ccr.result
        FROM constraint_compliance_results ccr
        JOIN tender_constraints tc ON tc.tender_constraint_id = ccr.tender_constraint_id
        JOIN constraint_catalog cc ON cc.constraint_type_id = tc.constraint_type_id
        WHERE ccr.opportunity_id = %s AND cc.name = 'Delivery region'
        ORDER BY ccr.checked_at DESC
        LIMIT 1
        """,
        (opportunity_id,),
    )
    if not row:
        return "unknown_missing_data"  # no Delivery region constraint checked yet for this opportunity
    result = row[0]["result"]
    if result == "unsatisfied":
        return "present"
    if result == "satisfied":
        return "absent_should_check"
    return "unknown_missing_data"  # unclear_needs_verification — genuinely don't know yet


# One signal today; add more entries here (and to win_loss_signal_catalog)
# as more historical patterns get validated via
# skills/exploration/historical_archetypes.py.
_SIGNAL_CHECKERS = {
    DELIVERY_REGION_SIGNAL: _check_delivery_region_gap,
}


def check_signals(opportunity_id: str) -> dict:
    """Read-only: computes a status per catalog signal, no writes."""
    catalog = run_sql("SELECT signal_id, factor_name FROM win_loss_signal_catalog")
    computed = []
    for row in catalog:
        checker = _SIGNAL_CHECKERS.get(row["factor_name"])
        status = checker(opportunity_id) if checker else "unknown_missing_data"
        computed.append({"signal_id": row["signal_id"], "factor_name": row["factor_name"], "status": status})
    return {"opportunity_id": opportunity_id, "signals": computed}


def persist_signals(opportunity_id: str) -> dict:
    """Delete-then-insert per opportunity, same idempotency shape as
    constraint_compliance.persist_compliance."""
    computed = check_signals(opportunity_id)["signals"]
    write_sql("DELETE FROM signal_check_results WHERE opportunity_id = %s", (opportunity_id,))
    for s in computed:
        write_sql(
            "INSERT INTO signal_check_results (opportunity_id, signal_id, status) VALUES (%s, %s, %s)",
            (opportunity_id, s["signal_id"], s["status"]),
        )
    return {"rows_written": len(computed)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python win_loss_signals.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(persist_signals(sys.argv[1]), indent=2, default=str))
