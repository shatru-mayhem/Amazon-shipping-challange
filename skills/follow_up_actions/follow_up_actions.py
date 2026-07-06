"""follow_up_actions — surface the open questions and required validations
for an opportunity so they can be pushed out (e.g. to Zapier) as tasks or
emails. Pure read: no writes, no Gemini.

    from follow_up_actions import get_follow_up_actions
    result = get_follow_up_actions(opportunity_id)

The `actions` list is shaped to drop straight into a Zapier webhook payload.
"""

import os
import sys
import json

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "constraint_compliance"))
from _db import run_sql  # noqa: E402
from constraint_compliance import is_hard_blocker  # noqa: E402


def get_follow_up_actions(opportunity_id: str) -> dict:
    actions = []

    # 1. Unresolved inbound follow-up questions from the client's emails.
    emails = run_sql(
        """
        SELECT em.sent_at, em.sender, em.body_redacted
        FROM email_messages em
        JOIN email_threads et ON et.thread_id = em.thread_id
        WHERE et.opportunity_id = %s AND em.resolved = FALSE
        ORDER BY em.sent_at DESC
        """,
        (opportunity_id,),
    )
    for e in emails:
        snippet = (e["body_redacted"] or "").strip().replace("\n", " ")
        actions.append({
            "type": "email_reply_needed",
            "priority": "high",
            "source": f"email from {e['sender']}",
            "action": "Respond to unresolved client message",
            "detail": snippet[:280],
        })

    # 2. Constraint compliance results — split into hard blockers (Amazon
    # cannot meet this, full stop) vs. genuinely unclear (needs internal
    # verification). Same is_hard_blocker used everywhere else so a gap in
    # ANY constraint type (geography, weight, product category, ...)
    # generates an escalation, not just the ones seen in testing so far.
    compliance = run_sql(
        """
        SELECT cc.name AS constraint_name, ccr.gap_description, ccr.result
        FROM constraint_compliance_results ccr
        JOIN tender_constraints tc ON tc.tender_constraint_id = ccr.tender_constraint_id
        LEFT JOIN constraint_catalog cc ON cc.constraint_type_id = tc.constraint_type_id
        WHERE ccr.opportunity_id = %s
          AND ccr.result IN ('unsatisfied', 'unclear_needs_verification')
        """,
        (opportunity_id,),
    )
    for c in compliance:
        if is_hard_blocker(c["result"]):
            actions.append({
                "type": "hard_blocker_escalation",
                "priority": "high",
                "source": "constraint check",
                "action": f"Escalate hard capability blocker: {c['constraint_name'] or 'constraint'} "
                          f"(Amazon cannot currently meet this — do not commit to it in the proposal)",
                "detail": c["gap_description"] or "",
            })
        else:
            actions.append({
                "type": "internal_verification",
                "priority": "medium",
                "source": "constraint check",
                "action": f"Verify capability for: {c['constraint_name'] or 'constraint'}",
                "detail": c["gap_description"] or "",
            })

    # 3. Open pipeline flags for this opportunity (missing inputs, low confidence).
    flags = run_sql(
        """
        SELECT rf.flag_type, rf.detail, rf.severity
        FROM run_flags rf
        JOIN run_executions re ON re.run_execution_id = rf.run_execution_id
        WHERE re.opportunity_id = %s AND rf.resolved = FALSE
        """,
        (opportunity_id,),
    )
    for f in flags:
        detail = f["detail"]
        if isinstance(detail, (dict, list)):
            detail = json.dumps(detail)
        actions.append({
            "type": f["flag_type"],
            "priority": f["severity"] or "medium",
            "source": "pipeline run flag",
            "action": "Resolve open pipeline flag",
            "detail": detail or "",
        })

    order = {"high": 0, "medium": 1, "low": 2}
    actions.sort(key=lambda a: order.get(a["priority"], 3))

    return {
        "opportunity_id": opportunity_id,
        "open_action_count": len(actions),
        "actions": actions,
        "zapier_ready": True,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python follow_up_actions.py <opportunity_id>")
        sys.exit(1)
    print(json.dumps(get_follow_up_actions(sys.argv[1]), indent=2, default=str))
