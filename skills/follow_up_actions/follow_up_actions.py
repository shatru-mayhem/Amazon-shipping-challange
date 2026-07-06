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
import uuid
import urllib.request
import urllib.error

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SKILLS_DIR)
sys.path.insert(0, os.path.join(_SKILLS_DIR, "constraint_compliance"))
from _db import run_sql, run_sql_one  # noqa: E402
from _ingestion_db import write_sql  # noqa: E402
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


def _post_to_zapier(payload: dict) -> dict:
    """Shared POST to the Zapier Catch Hook. Never silently swallows a
    failed request: if Zapier is unreachable or rejects the payload,
    that's reported back, not hidden behind a generic 'done'."""
    req = urllib.request.Request(
        ZAPIER_WEBHOOK_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return {"ok": True, "zapier_status": resp.status, "zapier_response": resp.read().decode(errors="replace")}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"Zapier returned HTTP {e.code}: {e.read().decode(errors='replace')}", "payload": payload}
    except (urllib.error.URLError, TimeoutError) as e:
        return {"ok": False, "error": f"Could not reach Zapier webhook: {e}", "payload": payload}


def _log_draft_send(draft_id: str, opportunity_id: str, kind: str, to_email: str, subject: str) -> None:
    write_sql(
        """INSERT INTO draft_send_log (draft_id, opportunity_id, kind, to_email, subject, status)
           VALUES (%s, %s, %s, %s, %s, 'sent_to_zapier')""",
        (draft_id, opportunity_id, kind, to_email, subject),
    )


def get_draft_status(draft_id: str) -> dict:
    """Polled by the dashboard after a send, so the UI can show real
    completion instead of the user having to check Gmail/Zapier manually.
    'sent_to_zapier' just means our own POST succeeded — completed/failed
    only get set by mark_draft_completed(), called from the Zapier
    callback step once the Gmail draft actually exists (or fails)."""
    row = run_sql_one(
        "SELECT draft_id, status, gmail_draft_id, completed_at FROM draft_send_log WHERE draft_id = %s",
        (draft_id,),
    )
    if not row:
        return {"ok": False, "error": "Unknown draft_id."}
    return {"ok": True, **row}


def mark_draft_completed(draft_id: str, status: str, gmail_draft_id: str = None) -> dict:
    """Called from the Zapier callback (a step added AFTER Gmail's
    'Create Draft' in the Zap, POSTing back to our own /api/zapier-draft-
    callback route with this draft_id) — this is what turns 'we handed it
    to Zapier' into 'the draft actually exists.'"""
    if status not in ("completed", "failed"):
        return {"ok": False, "error": "status must be 'completed' or 'failed'."}
    write_sql(
        """UPDATE draft_send_log SET status = %s, gmail_draft_id = %s, completed_at = now()
           WHERE draft_id = %s""",
        (status, gmail_draft_id, draft_id),
    )
    return {"ok": True}


def send_followup_draft(opportunity_id: str, to_email: str = DEFAULT_FOLLOWUP_RECIPIENT) -> dict:
    """Sends the current open follow-up actions (internal BD summary,
    including hard-blocker escalations verbatim) to the Zapier webhook,
    which turns them into a Gmail draft (never auto-sent — a human still
    reviews and hits send). Internal-only — see send_client_reply_draft()
    for the client-facing version, which never includes this raw text."""
    follow_up = get_follow_up_actions(opportunity_id)
    draft = _build_email_draft(opportunity_id, follow_up)
    draft_id = str(uuid.uuid4())

    result = _post_to_zapier({
        "draft_id": draft_id,
        "to": to_email,
        "subject": draft["subject"],
        "body": draft["body"],
        "opportunity_id": opportunity_id,
        "open_action_count": follow_up["open_action_count"],
        "issues": follow_up["actions"],
    })
    if not result["ok"]:
        return result
    _log_draft_send(draft_id, opportunity_id, "internal_summary", to_email, draft["subject"])
    return {
        "ok": True,
        "draft_id": draft_id,
        "zapier_status": result["zapier_status"],
        "zapier_response": result["zapier_response"],
        "to": to_email,
        "subject": draft["subject"],
        "open_action_count": follow_up["open_action_count"],
    }


def _client_contact(opportunity_id: str):
    """Most recent inbound message from the client themselves (not
    Amazon's own side of the thread), so the reply can be addressed to a
    real name. sender is stored as "Name <email>"."""
    row = run_sql_one(
        """SELECT em.sender
           FROM email_messages em
           JOIN email_threads et ON et.thread_id = em.thread_id
           WHERE et.opportunity_id = %s AND em.sender NOT ILIKE %s
           ORDER BY em.sent_at DESC LIMIT 1""",
        (opportunity_id, "%amazonshipping%"),
    )
    if not row:
        return None
    sender = row["sender"]
    first_name = sender.split("<")[0].strip().split(" ")[0] or None
    return first_name


def _build_client_reply_draft(opportunity_id: str) -> dict:
    """Client-facing reply draft — deliberately built from ONLY the parts
    of commercial_strategy that are already vetted client-safe content
    (positioning_statement/address_client_pains/align_to_priorities have
    already been filtered against capability_gaps_to_flag by
    commercial_strategy.py's _conflicts_with_hard_blocker(), the same fix
    that stopped the pitch deck promising France coverage). Never touches
    capability_gaps_to_flag or the internal hard-blocker escalation text
    directly — those exist so a human decides how/whether to address them,
    not so an auto-draft can improvise around them. Acknowledges the
    client's own open questions by quoting them back, but doesn't attempt
    to answer them (that's still a human's job) — it reinforces why
    Amazon Shipping is the right fit and confirms the team is on it."""
    _COMMERCIAL_DIR = os.path.join(_SKILLS_DIR, "commercial_strategy")
    if _COMMERCIAL_DIR not in sys.path:
        sys.path.insert(0, _COMMERCIAL_DIR)
    from commercial_strategy import build_commercial_strategy  # noqa: E402

    opp = run_sql_one(
        """SELECT o.title, c.name AS customer_name
           FROM opportunities o LEFT JOIN customers c ON c.customer_id = o.customer_id
           WHERE o.opportunity_id = %s""",
        (opportunity_id,),
    )
    title = opp["title"] if opp else opportunity_id
    customer = opp["customer_name"] if opp and opp["customer_name"] else "there"
    contact_first_name = _client_contact(opportunity_id) or customer

    strategy = build_commercial_strategy(opportunity_id)

    # How many of the client's own messages are still awaiting a reply —
    # count only. positioning_statement and the raw client email body are
    # deliberately NOT quoted here: positioning_statement is internal BD
    # phrasing ("Position Amazon Shipping around X, directly tied to Y"),
    # not natural prose to send verbatim, and the email body is an
    # already-redacted, arbitrarily-truncated internal transcript — not
    # something to echo back into an outbound client email.
    open_question_count = sum(
        1 for a in get_follow_up_actions(opportunity_id)["actions"] if a["type"] == "email_reply_needed"
    )

    lines = [f"Hi {contact_first_name},", ""]
    lines.append(f"Thank you for the continued conversation on {title}.")
    if strategy.get("address_client_pains"):
        lines += ["", "A few things we specifically want to make sure we're solving for you:"]
        for p in strategy["address_client_pains"][:3]:
            lines.append(f"- {p}")
    if open_question_count:
        plural = "s" if open_question_count != 1 else ""
        lines += [
            "",
            f"We also want to make sure we directly address the {open_question_count} open question{plural} "
            "from your last message(s) — our team is confirming the details and will follow up shortly with a direct answer.",
        ]
    lines += ["", "Happy to jump on a call if that's easier — let us know what works.", "", "Best,", "The Amazon Shipping Team"]

    subject = f"Re: {title}"
    return {"subject": subject, "body": "\n".join(lines)}


def send_client_reply_draft(opportunity_id: str, to_email: str = DEFAULT_FOLLOWUP_RECIPIENT) -> dict:
    """Client-facing reply draft, sent to the Zapier webhook to become a
    Gmail draft — never auto-sent, since this is client communication and
    a human must review it before it goes out. Demo recipient is the same
    harshithadivakar23@gmail.com placeholder (no real client inbox in the
    demo); swap to the actual client contact's email once this is live."""
    draft = _build_client_reply_draft(opportunity_id)
    draft_id = str(uuid.uuid4())
    result = _post_to_zapier({
        "draft_id": draft_id,
        "to": to_email,
        "subject": draft["subject"],
        "body": draft["body"],
        "opportunity_id": opportunity_id,
        "kind": "client_reply",
    })
    if not result["ok"]:
        return result
    _log_draft_send(draft_id, opportunity_id, "client_reply", to_email, draft["subject"])
    return {
        "ok": True,
        "draft_id": draft_id,
        "zapier_status": result["zapier_status"],
        "zapier_response": result["zapier_response"],
        "to": to_email,
        "subject": draft["subject"],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(
            "Usage: python follow_up_actions.py <opportunity_id> "
            "[send_draft|send_client_reply [to_email] | draft_status <draft_id> | "
            "mark_completed <draft_id> <completed|failed> [gmail_draft_id]]"
        )
        sys.exit(1)

    # opportunity_id (argv[1]) is a required positional slot to match the
    # /api/skill route's contract, but draft_status/mark_completed act on a
    # draft_id instead and ignore it — the Zapier callback route has no
    # real opportunity_id handy, so it passes a placeholder.
    opportunity_id = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "send_draft":
        to_email = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_FOLLOWUP_RECIPIENT
        print(json.dumps(send_followup_draft(opportunity_id, to_email), indent=2, default=str))
    elif len(sys.argv) > 2 and sys.argv[2] == "send_client_reply":
        to_email = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_FOLLOWUP_RECIPIENT
        print(json.dumps(send_client_reply_draft(opportunity_id, to_email), indent=2, default=str))
    elif len(sys.argv) > 3 and sys.argv[2] == "draft_status":
        print(json.dumps(get_draft_status(sys.argv[3]), indent=2, default=str))
    elif len(sys.argv) > 4 and sys.argv[2] == "mark_completed":
        gmail_draft_id = sys.argv[5] if len(sys.argv) > 5 else None
        print(json.dumps(mark_draft_completed(sys.argv[3], sys.argv[4], gmail_draft_id), indent=2, default=str))
    else:
        print(json.dumps(get_follow_up_actions(opportunity_id), indent=2, default=str))
