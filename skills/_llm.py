"""Shared LLM access for retrieval/extraction skills — embeddings via
Gemini's cloud API, generation via Ollama:

  - EMBED_MODEL    (gemini-embedding-001) -> embed() / embed_batch()
    Cloud only, via GEMINI_API_KEY (google-genai, same key/package
    nl_query_gemini.py already uses). Ollama's cloud API has no embedding
    models at all — a local Ollama server was previously required just
    for this — so this runs on Gemini instead, no local server needed.
    Turns text into a vector for cosine-similarity matching: classifying
    a tender's stated constraint against constraint_catalog, or matching
    a reply email to the question it resolves.
  - GENERATE_MODEL (gpt-oss:20b-cloud by default) -> generate_json()
    Runs on ollama.com's cloud API when OLLAMA_API_KEY is set (reachable
    from anywhere, no local server needed); falls back to a local model
    (llama3.2) when it isn't. Structured extraction/reasoning that
    similarity search can't do, e.g. pulling opportunity_features out of
    a contract paragraph.

    from _llm import embed, embed_batch, generate_json, cosine_similarity

Cloud setup:
    GEMINI_API_KEY   - required for embed()/embed_batch()
    OLLAMA_API_KEY   - optional, for generate_json() (falls back to a
                       local Ollama server running llama3.2 if unset)
"""

import os
import time
import json
import uuid
import urllib.request
import urllib.error

# Every skill script that calls embed()/generate_json() runs as its own
# fresh subprocess (Next.js execFile's `python <script>.py ...` per call —
# see app/api/skill/route.ts, app/api/retrieve/route.ts), so one run_id
# generated at import time naturally scopes to exactly one script
# invocation. A single retrieve() call fans out across several distinct
# `skill` labels (opportunity_features, tender_constraints,
# client_highlights, email_messages) that all share this run_id — that's
# what lets software_analytics.py group "which script consumed how much"
# under one run instead of only ever showing lifetime totals.
_RUN_ID = str(uuid.uuid4())


def _load_dotenv_best_effort():
    """Load KEY=VALUE pairs from a sibling .env into os.environ if they
    aren't already set. Mirrors nl_query_gemini.py's loader."""
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


_load_dotenv_best_effort()

OLLAMA_LOCAL_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_CLOUD_HOST = "https://ollama.com"
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY")

GEMINI_EMBED_MODEL = os.environ.get("GEMINI_EMBED_MODEL", "gemini-embedding-001")

# GEMINI_API_SECRET_PRIVATE is a second Gemini key, used only as a
# fallback when the primary key (GEMINI_API_KEY) hits a quota/rate-limit
# error — embed_batch() below switches to it automatically, mid-request,
# rather than failing the whole retrieval call over an exhausted quota.
GEMINI_API_KEY_FALLBACK = os.environ.get("GEMINI_API_SECRET_PRIVATE")

_gemini_clients: dict = {}


def _get_gemini_client(use_fallback: bool = False):
    """Lazy import/init, same reasoning as nl_query_gemini.py's
    _get_client() — a module that only ever calls generate_json()
    shouldn't need google-genai installed or GEMINI_API_KEY set."""
    cache_key = "fallback" if use_fallback else "primary"
    if cache_key not in _gemini_clients:
        api_key = GEMINI_API_KEY_FALLBACK if use_fallback else os.environ.get("GEMINI_API_KEY")
        if not api_key:
            var = "GEMINI_API_SECRET_PRIVATE" if use_fallback else "GEMINI_API_KEY"
            raise RuntimeError(f"{var} is not set — required for embed()/embed_batch().")
        from google import genai
        _gemini_clients[cache_key] = genai.Client(api_key=api_key)
    return _gemini_clients[cache_key]


def _is_quota_error(e: Exception) -> bool:
    msg = str(e)
    return "RESOURCE_EXHAUSTED" in msg or "429" in msg or "quota" in msg.lower()

# Cloud is the default. Measured on this machine: local llama3.2 runs at
# 100% CPU with no GPU — fine for tiny prompts (5-9s) but scales badly
# with real ~4000-char batched prompts (a full tender_constraints run
# took ~5 minutes, worse than cloud). Cloud is network-bound, not
# CPU-bound, so it actually benefits from concurrency; local doesn't,
# since concurrent local calls just fight over the same CPU. Set
# OLLAMA_USE_CLOUD=false to force local (e.g. no network, or a machine
# with a real GPU where local would actually win).
OLLAMA_USE_CLOUD = os.environ.get("OLLAMA_USE_CLOUD", "true").lower() == "true"

GENERATE_MODEL = os.environ.get(
    "OLLAMA_GENERATE_MODEL", "gpt-oss:20b-cloud" if OLLAMA_USE_CLOUD else "llama3.2"
)


def _post(host: str, path: str, payload: dict, timeout: int = 60, use_auth: bool = False, retries: int = 1) -> dict:
    headers = {"Content-Type": "application/json"}
    if use_auth:
        if not OLLAMA_API_KEY:
            raise RuntimeError("OLLAMA_API_KEY is not set — required to call the ollama.com cloud API.")
        headers["Authorization"] = f"Bearer {OLLAMA_API_KEY}"

    req = urllib.request.Request(
        f"{host}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{host}{path} returned {e.code}: {e.read().decode(errors='replace')}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            # Transient (connect timeout via URLError, or a read timeout
            # once connected — raised as a bare TimeoutError, NOT a
            # URLError, so it must be caught explicitly here too). Cloud
            # calls occasionally run long under concurrent load; retry
            # once before giving up rather than failing the whole
            # retrieval call on one slow request.
            if attempt < retries:
                attempt += 1
                time.sleep(1)
                continue
            hint = "is `ollama serve` running?" if host == OLLAMA_LOCAL_HOST else "check your network/API key."
            raise RuntimeError(f"Could not reach {host}{path} — {hint} ({e})") from e


def _log_call(**fields):
    """Best-effort write to observability.llm_call_log — every embed()/
    generate_json() call, real token counts and latency where Ollama's
    response provides them. Logging failure must never break the actual
    LLM call it's describing, so any error here is swallowed, not raised.
    Imported lazily to keep _llm.py usable standalone (e.g. its own
    __main__ smoke test) even if _ingestion_db's env isn't configured."""
    try:
        import os
        import sys
        _skills_dir = os.path.dirname(os.path.abspath(__file__))
        if _skills_dir not in sys.path:
            sys.path.insert(0, _skills_dir)
        from _ingestion_db import write_sql

        fields.setdefault("run_id", _RUN_ID)
        write_sql(
            """INSERT INTO llm_call_log
                 (run_id, opportunity_id, skill, call_type, model, is_cloud,
                  prompt_tokens, completion_tokens, total_tokens,
                  total_duration_ms, load_duration_ms, eval_duration_ms,
                  success, error_message)
               VALUES (%(run_id)s, %(opportunity_id)s, %(skill)s, %(call_type)s, %(model)s, %(is_cloud)s,
                       %(prompt_tokens)s, %(completion_tokens)s, %(total_tokens)s,
                       %(total_duration_ms)s, %(load_duration_ms)s, %(eval_duration_ms)s,
                       %(success)s, %(error_message)s)""",
            fields,
        )
    except Exception:
        pass


def embed(text: str, *, opportunity_id: str = None, skill: str = None) -> list:
    """Embed a single string with GEMINI_EMBED_MODEL, via the cloud.
    Returns a list[float].

    opportunity_id/skill are optional attribution labels for the
    observability log (which opportunity and which retrieval.py function
    triggered this call) — purely for analytics, never required."""
    return embed_batch([text], opportunity_id=opportunity_id, skill=skill)[0]


def embed_batch(texts: list, *, opportunity_id: str = None, skill: str = None) -> list:
    """Embed multiple strings in one Gemini API call (embed_content
    accepts a list of contents directly — no need to loop per string the
    way Ollama's single-prompt endpoint required).

    If the primary key (GEMINI_API_KEY) comes back with a quota/rate-limit
    error and GEMINI_API_SECRET_PRIVATE is set, retries once with that
    second key before giving up — a quota exhaustion on one key
    shouldn't fail retrieval outright."""
    start = time.perf_counter()
    used_fallback = False
    try:
        result = _get_gemini_client().models.embed_content(model=GEMINI_EMBED_MODEL, contents=texts)
    except Exception as e:
        if _is_quota_error(e) and GEMINI_API_KEY_FALLBACK:
            used_fallback = True
            try:
                result = _get_gemini_client(use_fallback=True).models.embed_content(
                    model=GEMINI_EMBED_MODEL, contents=texts,
                )
            except Exception as e2:
                _log_call(
                    opportunity_id=opportunity_id, skill=skill, call_type="embed", model=GEMINI_EMBED_MODEL,
                    is_cloud=True, prompt_tokens=None, completion_tokens=None, total_tokens=None,
                    total_duration_ms=round((time.perf_counter() - start) * 1000, 1),
                    load_duration_ms=None, eval_duration_ms=None, success=False, error_message=str(e2)[:2000],
                )
                raise
        else:
            _log_call(
                opportunity_id=opportunity_id, skill=skill, call_type="embed", model=GEMINI_EMBED_MODEL,
                is_cloud=True, prompt_tokens=None, completion_tokens=None, total_tokens=None,
                total_duration_ms=round((time.perf_counter() - start) * 1000, 1),
                load_duration_ms=None, eval_duration_ms=None, success=False, error_message=str(e)[:2000],
            )
            raise
    # Gemini's embed_content response carries no token-usage metadata
    # (unlike generate_content) — wall-clock duration is still real and
    # worth recording.
    _log_call(
        opportunity_id=opportunity_id, skill=skill, call_type="embed",
        model=GEMINI_EMBED_MODEL + (" (fallback key)" if used_fallback else ""),
        is_cloud=True, prompt_tokens=None, completion_tokens=None, total_tokens=None,
        total_duration_ms=round((time.perf_counter() - start) * 1000, 1),
        load_duration_ms=None, eval_duration_ms=None, success=True, error_message=None,
    )
    return [e.values for e in result.embeddings]


def cosine_similarity(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def generate_json(prompt: str, system: str = None, *, opportunity_id: str = None, skill: str = None) -> dict:
    """Ask GENERATE_MODEL for a JSON object back. Local (llama3.2) by
    default — measured 5-9s vs. up to 108s for the cloud model under
    real load. Set OLLAMA_USE_CLOUD=true to use ollama.com's cloud API
    instead (e.g. no local Ollama server reachable). Raises if the
    model's response isn't valid JSON — callers decide how to handle
    that (retry, flag as low-confidence extraction, etc.), this function
    doesn't guess.

    opportunity_id/skill are optional attribution labels for the
    observability log, same as embed() — purely for analytics."""
    payload = {
        "model": GENERATE_MODEL,
        "prompt": prompt,
        "format": "json",
        "stream": False,
    }
    if system:
        payload["system"] = system

    host = OLLAMA_CLOUD_HOST if OLLAMA_USE_CLOUD else OLLAMA_LOCAL_HOST
    start = time.perf_counter()
    # Cloud generation can run long under concurrent load (see
    # skills/retrieval/retrieval.py's ThreadPoolExecutor usage) — a wider
    # timeout than the default avoids failing a slow-but-fine call.
    try:
        result = _post(host, "/api/generate", payload, timeout=150, use_auth=OLLAMA_USE_CLOUD)
    except Exception as e:
        _log_call(
            opportunity_id=opportunity_id, skill=skill, call_type="generate_json", model=GENERATE_MODEL,
            is_cloud=OLLAMA_USE_CLOUD, prompt_tokens=None, completion_tokens=None, total_tokens=None,
            total_duration_ms=round((time.perf_counter() - start) * 1000, 1),
            load_duration_ms=None, eval_duration_ms=None, success=False, error_message=str(e)[:2000],
        )
        raise

    # /api/generate (non-streaming) returns real token counts and
    # nanosecond-precision server-side timing — the actual tokenomics
    # numbers, not an estimate. Convert ns -> ms for the log.
    prompt_tokens = result.get("prompt_eval_count")
    completion_tokens = result.get("eval_count")
    total_tokens = (
        (prompt_tokens or 0) + (completion_tokens or 0)
        if prompt_tokens is not None or completion_tokens is not None else None
    )
    _log_call(
        opportunity_id=opportunity_id, skill=skill, call_type="generate_json", model=GENERATE_MODEL,
        is_cloud=OLLAMA_USE_CLOUD, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        total_duration_ms=round(result["total_duration"] / 1e6, 1) if result.get("total_duration") else None,
        load_duration_ms=round(result["load_duration"] / 1e6, 1) if result.get("load_duration") else None,
        eval_duration_ms=round(result["eval_duration"] / 1e6, 1) if result.get("eval_duration") else None,
        success=True, error_message=None,
    )
    text = result["response"].strip()

    # Cloud models don't always honor format="json" as strictly as local
    # ones do — they'll sometimes wrap the object in a ```json fence.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    # Some models (seen with gpt-oss:20b-cloud) escape single quotes with
    # a backslash inside a JSON string ("\'") — not a valid JSON escape
    # (JSON only knows \" for quotes), which makes an otherwise
    # well-formed response fail to parse. Safe to strip unconditionally:
    # a literal backslash immediately before a single quote is never
    # something valid JSON needs.
    text = text.replace("\\'", "'")

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{GENERATE_MODEL} did not return valid JSON: {text}") from e


if __name__ == "__main__":
    vec = embed("delivery to mainland Spain within 48 hours")
    print(f"embed() OK — {GEMINI_EMBED_MODEL} returned a {len(vec)}-dim vector")

    out = generate_json(
        "Extract a JSON object with one field, greeting, containing the word hello.",
    )
    print(f"generate_json() OK — {GENERATE_MODEL} returned: {out}")
