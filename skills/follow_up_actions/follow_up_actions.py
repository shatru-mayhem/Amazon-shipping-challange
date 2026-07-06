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
import urllib.request
import urllib.error

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "constraint_compliance"))
from _db import run_sql, run_sql_one  # noqa: E402
from constraint_compliance import is_hard_blocker  # noqa: E402

# Zapier Catch Hook: receives {to, subject, body, opportunity_id, issues}
# and (per the Zap configured on harshithadivakar23@gmail.com's account)
# creates a Gmail draft — never sends outright. Demo-hardcoded recipient;
# swap for a real per-account/BD-owner email once this is more than a demo.
ZAPIER_WEBHOOK_URL = os.environ.get(
    "ZAPIER_FOLLOWUP_WEBHOOK_URL",
    "https://hooks.zapier.com/hooks/catch/28124606/4uhsfwp/",
)
DEFAULT_FOLLOWUP_RECIPIENT = os.environ.get("FOLLOWUP_EMAIL_TO", "harshithadivakar23@gmail.com")


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


_PRIORITY_LABEL = {"high": "HIGH", "medium": "Medium", "low": "Low"}


def _build_email_draft(opportunity_id: str, follow_up: dict) -> dict:
    """Turns get_follow_up_actions()'s output into a plain subject/body
    draft — no LLM call, since the actions are already structured text and
    a template keeps this deterministic (no risk of an LLM inventing or
    softening a hard-blocker escalation before it reaches a human inbox)."""
    opp = run_sql_one(
        """SELECT o.title, c.name AS customer_name
           FROM opportunities o LEFT JOIN customers c ON c.customer_id = o.customer_id
           WHERE o.opportunity_id = %s""",
        (opportunity_id,),
    )
    title = opp["title"] if opp else opportunity_id
    customer = opp["customer_name"] if opp and opp["customer_name"] else None

    subject = f"Follow-up actions — {title}" + (f" ({customer})" if customer else "")

    actions = follow_up["actions"]
    if not actions:
        body = f"No open follow-up actions for {title}. Nothing needs attention right now."
    else:
        lines = [
            f"{follow_up['open_action_count']} open follow-up action(s) for {title}"
            + (f", {customer}" if customer else "") + ":",
            "",
        ]
        for i, a in enumerate(actions, 1):
            label = _PRIORITY_LABEL.get(a["priority"], a["priority"])
            lines.append(f"{i}. [{label}] {a['action']}")
            lines.append(f"   Source: {a['source']}")
            if a.get("detail"):
                lines.append(f"   Detail: {a['detail']}")
            lines.append("")
        body = "\n".join(lines).rstrip()

    return {"subject": subject, "body": body}


def send_followup_draft(opportunity_id: str, to_email: str = DEFAULT_FOLLOWUP_RECIPIENT) -> dict:
    """Sends the current open follow-up actions to the Zapier webhook,
    which turns them into a Gmail draft (never auto-sent — a human still
    reviews and hits send). Never silently swallows a failed POST: if
    Zapier is unreachable or rejects the payload, that's reported back,
    not hidden behind a generic 'done'."""
    follow_up = get_follow_up_actions(opportunity_id)
    draft = _build_email_draft(opportunity_id, follow_up)

    payload = {
        "to": to_email,
        "subject": draft["subject"],
        "body": draft["body"],
        "opportunity_id": opportunity_id,
        "open_action_count": follow_up["open_action_count"],
        "issues": follow_up["actions"],
    }

    req = urllib.request.Request(
        ZAPIER_WEBHOOK_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            resp_body = resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"Zapier returned HTTP {e.code}: {e.read().decode(errors='replace')}", "payload": payload}
    except (urllib.error.URLError, TimeoutError) as e:
        return {"ok": False, "error": f"Could not reach Zapier webhook: {e}", "payload": payload}

    return {
        "ok": True,
        "zapier_status": status,
        "zapier_response": resp_body,
        "to": to_email,
        "subject": draft["subject"],
        "open_action_count": follow_up["open_action_count"],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python follow_up_actions.py <opportunity_id> [send_draft [to_email]]")
        sys.exit(1)

    opportunity_id = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "send_draft":
        to_email = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_FOLLOWUP_RECIPIENT
        print(json.dumps(send_followup_draft(opportunity_id, to_email), indent=2, default=str))
    else:
        print(json.dumps(get_follow_up_actions(opportunity_id), indent=2, default=str))
