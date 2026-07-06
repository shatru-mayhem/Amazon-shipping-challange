"""Shared LLM access for retrieval/extraction skills, via Ollama — split
across local and cloud because Ollama's cloud API (ollama.com) only serves
its own curated :cloud chat/generation models, not custom models pushed to
a personal namespace, and it has no embedding models at all:

  - EMBED_MODEL   (nomic-embed-text) -> embed() / embed_batch()
    Always LOCAL (http://localhost:11434) — no cloud embedding models
    exist. Turns text into a vector for cosine-similarity matching:
    classifying a tender's stated constraint against constraint_catalog,
    or matching a reply email to the question it resolves.
  - GENERATE_MODEL (gpt-oss:20b-cloud by default) -> generate_json()
    Runs on ollama.com's cloud API when OLLAMA_API_KEY is set (reachable
    from anywhere, no local server needed); falls back to a local model
    (llama3.2) when it isn't. Structured extraction/reasoning that
    similarity search can't do, e.g. pulling opportunity_features out of
    a contract paragraph.

    from _llm import embed, embed_batch, generate_json, cosine_similarity

Local setup (embeddings always need this):
    ollama pull nomic-embed-text
Cloud setup (optional, for generate_json):
    Get a key at https://ollama.com/settings/keys, set OLLAMA_API_KEY.
"""

import os
import time
import json
import urllib.request
import urllib.error


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

# Cloud is the default. Measured on this machine: local llama3.2 runs at
# 100% CPU with no GPU — fine for tiny prompts (5-9s) but scales badly
# with real ~4000-char batched prompts (a full tender_constraints run
# took ~5 minutes, worse than cloud). Cloud is network-bound, not
# CPU-bound, so it actually benefits from concurrency; local doesn't,
# since concurrent local calls just fight over the same CPU. Set
# OLLAMA_USE_CLOUD=false to force local (e.g. no network, or a machine
# with a real GPU where local would actually win).
OLLAMA_USE_CLOUD = os.environ.get("OLLAMA_USE_CLOUD", "true").lower() == "true"

EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
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


def embed(text: str) -> list:
    """Embed a single string with EMBED_MODEL. Always local — Ollama's
    cloud API has no embedding models. Returns a list[float]."""
    result = _post(OLLAMA_LOCAL_HOST, "/api/embeddings", {"model": EMBED_MODEL, "prompt": text})
    return result["embedding"]


def embed_batch(texts: list) -> list:
    """Embed multiple strings. Ollama's embeddings endpoint is single-prompt,
    so this just loops — fine at retrieval-engine volumes (per-tender,
    per-email), not a hot request path."""
    return [embed(t) for t in texts]


def cosine_similarity(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def generate_json(prompt: str, system: str = None) -> dict:
    """Ask GENERATE_MODEL for a JSON object back. Local (llama3.2) by
    default — measured 5-9s vs. up to 108s for the cloud model under
    real load. Set OLLAMA_USE_CLOUD=true to use ollama.com's cloud API
    instead (e.g. no local Ollama server reachable). Raises if the
    model's response isn't valid JSON — callers decide how to handle
    that (retry, flag as low-confidence extraction, etc.), this function
    doesn't guess."""
    payload = {
        "model": GENERATE_MODEL,
        "prompt": prompt,
        "format": "json",
        "stream": False,
    }
    if system:
        payload["system"] = system

    host = OLLAMA_CLOUD_HOST if OLLAMA_USE_CLOUD else OLLAMA_LOCAL_HOST
    # Cloud generation can run long under concurrent load (see
    # skills/retrieval/retrieval.py's ThreadPoolExecutor usage) — a wider
    # timeout than the default avoids failing a slow-but-fine call.
    result = _post(host, "/api/generate", payload, timeout=150, use_auth=OLLAMA_USE_CLOUD)
    text = result["response"].strip()

    # Cloud models don't always honor format="json" as strictly as local
    # ones do — they'll sometimes wrap the object in a ```json fence.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{GENERATE_MODEL} did not return valid JSON: {text}") from e


if __name__ == "__main__":
    vec = embed("delivery to mainland Spain within 48 hours")
    print(f"embed() OK — {EMBED_MODEL} returned a {len(vec)}-dim vector")

    out = generate_json(
        "Extract a JSON object with one field, greeting, containing the word hello.",
    )
    print(f"generate_json() OK — {GENERATE_MODEL} returned: {out}")
