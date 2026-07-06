#!/bin/sh
set -e

# Ollama's cloud API has no embedding models (see skills/_llm.py) — embed()
# always calls localhost:11434, so THIS container needs its own local
# Ollama server with nomic-embed-text pulled. gpt-oss:20b-cloud (used by
# generate_json) runs on ollama.com's cloud API instead, via OLLAMA_API_KEY
# — no local model needed for that one.
ollama serve &
OLLAMA_PID=$!

echo "Waiting for local Ollama to accept connections..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  sleep 1
done

if ! ollama list | grep -q nomic-embed-text; then
  echo "Pulling nomic-embed-text (one-time, ~275MB)..."
  ollama pull nomic-embed-text
fi

echo "Starting skills bridge API on port ${PORT:-8000}..."
uvicorn service.app:app --host 0.0.0.0 --port "${PORT:-8000}" &
API_PID=$!

trap 'kill $OLLAMA_PID $API_PID 2>/dev/null' TERM INT
wait $API_PID
