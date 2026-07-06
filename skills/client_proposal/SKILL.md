---
name: client_proposal
description: Assemble the client-facing proposal / pitch deck sections for an opportunity by composing commercial strategy, pricing and client highlights.
---

# Client Proposal & Pitch Deck

## What it does
Produces the structured content for a client-facing proposal deck: what we
heard, why Amazon Shipping, the commercial proposal (with the selected pricing
scenario), and next steps. Output is structured data a renderer or an LLM can
turn into slides.

## Flow position
```
client_highlights ┐
commercial_strategy ├──► client_proposal ──► (deck) ──► executive_summary
pricing_recommendations ┘        ▲
                          selected scenario
```

## Composition
- `commercial_strategy.build_commercial_strategy` (positioning, proof points)
- `pricing_recommendations.recommend_pricing` (scenarios; a selected one)
- `client_highlights` + `opportunities`/`customers` (direct SQL) for context.

## Usage
```python
from client_proposal import build_client_proposal
result = build_client_proposal("<opportunity_id>", selected_scenario="balanced")
```
```bash
python skills/client_proposal/client_proposal.py <opportunity_id> [scenario]
```

## Output
`sections`: `cover`, `understanding_your_needs`, `why_amazon_shipping`,
`commercial_proposal`, `next_steps`; plus the `selected_scenario`.
