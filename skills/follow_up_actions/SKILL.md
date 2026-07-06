---
name: follow_up_actions
description: Surface open questions and required validations for an opportunity (unresolved client emails, unclear constraints, open pipeline flags) as a Zapier-ready action list.
---

# Follow-up Actions (Zapier automation)

## What it does
Collects everything still waiting on a human for an opportunity into one
prioritised, webhook-ready action list — the feed for Zapier automation
(create tasks, send reminder emails, etc.).

## Flow position
```
email_messages + constraint_compliance_results + run_flags
              └──────────────┬──────────────┘
                    follow_up_actions  →  Zapier
```

## Data source (via nl_query_gemini.run_sql — no Gemini)
- `email_messages` × `email_threads` (unresolved inbound questions)
- `constraint_compliance_results` (unclear → needs verification)
- `run_flags` × `run_executions` (open pipeline flags for this opportunity)

## Action types produced
- `email_reply_needed` (high) — unresolved client message.
- `internal_verification` (medium) — constraint compliance is unclear.
- pipeline flag types (`missing_required_input`, `low_confidence_field`, …).

## Usage
```python
from follow_up_actions import get_follow_up_actions
result = get_follow_up_actions("<opportunity_id>")
# POST result["actions"] to a Zapier catch-hook webhook
```
```bash
python skills/follow_up_actions/follow_up_actions.py <opportunity_id>
```

## Output
`open_action_count`, `actions` (priority-sorted, each with type/priority/
source/action/detail), `zapier_ready`.
