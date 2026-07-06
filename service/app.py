"""service/app.py — HTTP bridge that lets the Vercel-hosted Next.js app
call the Python skills over the network instead of spawning `python` as a
local subprocess (app/api/skill/route.ts, app/api/retrieve/route.ts).

Why this exists: Vercel's Node.js serverless functions have no Python
interpreter, no psycopg2/faiss/numpy, and no path to a local Ollama
server — `execFile("python", ...)` simply fails there. This service runs
on a host that DOES have all of that (a container, not serverless), and
Next.js talks to it over HTTP instead.

Deliberately does the SAME thing app/api/skill/route.ts's runPython()
already does — run `python skills/<name>/<name>.py <args>` as a
subprocess and parse stdout as JSON — rather than importing and calling
each skill's function directly. That keeps every skill's existing CLI
contract (extra_args handling for send_draft, capability_ingestion
actions, etc.) as the single source of truth instead of a second,
hand-maintained dispatch table that could drift from it.

Auth: a single shared-secret header (SKILLS_SERVICE_TOKEN) — this
service has DB write credentials in its own environment, so it can't be
left open on a public URL. Vercel sends the same token as
PYTHON_SKILLS_SERVICE_TOKEN.

Run locally:  uvicorn service.app:app --reload --port 8000
"""

import os
import sys
import json
import subprocess

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

SERVICE_TOKEN = os.environ.get("SKILLS_SERVICE_TOKEN")
TIMEOUT_SECONDS = 120

# Mirrors app/api/skill/route.ts's SKILLS map exactly — keep both in sync
# if a skill is added/renamed.
SKILLS = {
    "opportunity_score": "opportunity_score/opportunity_score.py",
    "win_probability": "win_probability/win_probability.py",
    "risk_assessment": "risk_assessment/risk_assessment.py",
    "commercial_strategy": "commercial_strategy/commercial_strategy.py",
    "pricing_recommendations": "pricing_recommendations/pricing_recommendations.py",
    "client_proposal": "client_proposal/client_proposal.py",
    "follow_up_actions": "follow_up_actions/follow_up_actions.py",
    "executive_summary": "executive_summary/executive_summary.py",
    "sources_used": "sources_used/sources_used.py",
    "software_analytics": "software_analytics/software_analytics.py",
    "capability_ingestion": "capability_ingestion/capability_ingestion.py",
}
GLOBAL_SKILLS = {"software_analytics", "capability_ingestion"}
VALID_TABLES = {"opportunity_features", "tender_constraints", "client_highlights", "email_messages"}

app = FastAPI(title="amazon-backend Python skills bridge")


class SkillRequest(BaseModel):
    skill: str
    opportunity_id: str | None = None
    extra_args: list[str] | None = None


class RetrieveRequest(BaseModel):
    opportunity_id: str
    table: str
    field: str | None = None


def _check_auth(x_service_token: str | None):
    if not SERVICE_TOKEN:
        raise HTTPException(500, "SKILLS_SERVICE_TOKEN is not set on this service — refusing to run unauthenticated.")
    if x_service_token != SERVICE_TOKEN:
        raise HTTPException(401, "Invalid or missing X-Service-Token.")


def _run_python(args: list) -> dict:
    try:
        proc = subprocess.run(
            ["python", *args],
            cwd=_ROOT,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"Script timed out after {TIMEOUT_SECONDS}s.")
    if proc.returncode != 0:
        raise HTTPException(500, proc.stderr.strip() or f"Script exited {proc.returncode}.")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise HTTPException(500, f"Script did not return valid JSON: {proc.stdout[:2000]}")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/skill")
def run_skill(req: SkillRequest, x_service_token: str | None = Header(default=None)):
    _check_auth(x_service_token)
    if req.skill not in SKILLS:
        raise HTTPException(400, f"skill must be one of: {', '.join(SKILLS)}")
    is_global = req.skill in GLOBAL_SKILLS
    if not is_global and not req.opportunity_id:
        raise HTTPException(400, "opportunity_id is required.")

    script = os.path.join(_ROOT, "skills", SKILLS[req.skill])
    args = [script]
    if not is_global:
        args.append(req.opportunity_id)
    if req.extra_args:
        args.extend(str(a) for a in req.extra_args)

    return _run_python(args)


@app.post("/retrieve")
def run_retrieve(req: RetrieveRequest, x_service_token: str | None = Header(default=None)):
    _check_auth(x_service_token)
    if req.table not in VALID_TABLES:
        raise HTTPException(400, f"table must be one of: {', '.join(VALID_TABLES)}")

    script = os.path.join(_ROOT, "skills", "retrieval", "retrieval.py")
    args = [script, req.opportunity_id, req.table]
    if req.field:
        args.append(str(req.field))

    return _run_python(args)
