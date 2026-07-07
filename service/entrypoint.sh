#!/bin/sh
set -e

# Ollama's cloud API has no embedding models (see skills/_llm.py) — embed()
# always calls localhost:11434, so THIS container needs its own local
# Ollama server with nomic-embed-text pulled. gpt-oss:20b-cloud (used by
# generate_json) runs on ollama.com's cloud API instead, via OLLAMA_API_KEY
# — no local model needed for that one.
#
# OLLAMA_NO_CLOUD=true: this local server is only ever used for local
# embeddings, never Ollama's own cloud-proxy chat feature — disable it so
# startup doesn't attempt any registry/cloud handshake that isn't needed
# and could hang on a network path we don't control (seen: server logs
# stopped cold right after generating a fresh ~/.ollama/id_ed25519 key,
# with cloud explicitly enabled in its own startup config dump).
export OLLAMA_NO_CLOUD=true
ollama serve &
OLLAMA_PID=$!

echo "Waiting for local Ollama to accept connections..."
i=0
until curl -sf http://127.0.0.1:11434/api/tags > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "Ollama did not come up within 60s — exiting so Railway restarts the container instead of hanging forever." >&2
    exit 1
  fi
  sleep 1
done
echo "Ollama is up."

if ! ollama list | grep -q nomic-embed-text; then
  echo "Pulling nomic-embed-text (one-time, ~275MB)..."
  timeout 180 ollama pull nomic-embed-text || {
    echo "nomic-embed-text pull did not finish within 180s — exiting so Railway restarts and retries." >&2
    exit 1
  }
  echo "nomic-embed-text pulled."
fi

echo "Starting skills bridge API on port ${PORT:-8000}..."
uvicorn service.app:app --host 0.0.0.0 --port "${PORT:-8000}" &
API_PID=$!

trap 'kill $OLLAMA_PID $API_PID 2>/dev/null' TERM INT
wait $API_PID
