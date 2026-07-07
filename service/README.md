# Python skills bridge — deployment

Why this exists: Vercel's Node.js serverless functions can't run
`skills/*.py` (no Python interpreter, no psycopg2/faiss/numpy). This is a
small FastAPI service — `app.py` — that runs those same scripts as
subprocesses on a host that has all of that, and the Vercel app talks to
it over HTTP (see `lib/skills-bridge.ts`). Embeddings and generation both
run on cloud APIs (Gemini and Ollama's cloud API respectively), so this
container itself only needs Python — no local model server.

Tested locally: `uvicorn service.app:app --port 8010` + a real `/skill`
call round-tripped correctly against the live DB.

## 1. Deploy the service (Railway recommended)

Railway auto-builds from a `Dockerfile` and gives you a public HTTPS URL
with zero extra config.

1. https://railway.app → New Project → **Deploy from GitHub repo** → pick
   this repo.
2. Railway will look for a Dockerfile at the repo root by default — set
   **Dockerfile Path** to `service/Dockerfile` and **Root Directory** to
   the repo root (the Dockerfile's `COPY . .` needs the whole repo, not
   just `service/`, since it needs `skills/` and `nl_query_gemini.py`
   alongside it).
3. Add the environment variables below in Railway's **Variables** tab.
4. Deploy — no local model to pull, so first boot is a normal Python
   container build.
5. Once healthy, Railway gives you a public URL like
   `https://<service>.up.railway.app`. Confirm it: `curl
   https://<service>.up.railway.app/healthz` → `{"ok":true}`.

Render or Fly.io work the same way (Dockerfile-based deploy) if you
prefer either of those instead.

### Environment variables — the Python service

Same values as your local `.env` (a fresh deploy never gets `.env` — it's
git-ignored — so these must be added in Railway's dashboard by hand):

| Variable | Purpose |
|---|---|
| `SUPABASE_DB_URL` | read-only DB connection (`nl_query_readonly` role) — `skills/_db.py` |
| `APP_INGESTION_DB_URL` | write-capable DB connection (`app_ingestion` role) — `skills/_ingestion_db.py` |
| `GEMINI_API_KEY` | Google AI Studio key, for `embed()`/`embed_batch()` (`gemini-embedding-001`) and `nl_query_gemini.py` |
| `OLLAMA_API_KEY` | ollama.com cloud API key, for `generate_json()` (gpt-oss:20b-cloud) |
| `OLLAMA_USE_CLOUD` | `true` (recommended — see `_llm.py`'s own latency comparison notes) |
| `SKILLS_SERVICE_TOKEN` | **pick a new random secret** — this is the shared auth token between Vercel and this service; do not reuse another credential |
| `FOLLOWUP_EMAIL_TO`, `ZAPIER_FOLLOWUP_WEBHOOK_URL` | only if you use `follow_up_actions`' send-draft feature |

## 2. Point Vercel at it

In the Vercel project's **Environment Variables**, add:

| Variable | Value |
|---|---|
| `PYTHON_SKILLS_SERVICE_URL` | `https://<service>.up.railway.app` (no trailing slash) |
| `PYTHON_SKILLS_SERVICE_TOKEN` | the exact same value as the Python service's `SKILLS_SERVICE_TOKEN` |

Plus the ones already needed for the rest of the app to work at all
(`APP_INGESTION_DB_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).

Redeploy. `app/api/skill/route.ts` and `app/api/retrieve/route.ts`
(via `lib/skills-bridge.ts`) automatically switch from local subprocess
to calling this service the moment `PYTHON_SKILLS_SERVICE_URL` is set —
no code change needed, and local dev is unaffected when it's unset.

## Sizing

Both embeddings (Gemini) and generation (`gpt-oss:20b-cloud`) run on
their providers' servers, not this container — it only runs FastAPI and
the skill subprocesses, so a small/default host tier is enough.
