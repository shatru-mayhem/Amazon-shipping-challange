# Python skills bridge — a container that has what Vercel's Node
# serverless functions don't: a Python interpreter, psycopg2/faiss/numpy,
# and a local Ollama server for embeddings (see entrypoint.sh for why
# Ollama has to run *in this container*, not just be reachable via API key).
#
# Build from the REPO ROOT (not from service/), since it needs the whole
# skills/ tree and nl_query_gemini.py alongside it, same layout as local:
#   docker build -f service/Dockerfile -t amazon-skills-service .
#
# Needs >=1GB RAM for nomic-embed-text comfortably — pick a host tier
# accordingly (see service/README.md).

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /app

COPY service/requirements.txt service/requirements.txt
RUN pip install --no-cache-dir -r service/requirements.txt

# The rest of the repo — skills/*.py, nl_query_gemini.py, etc. — same
# layout the code already assumes locally (each skill's sys.path.insert
# is relative to its own __file__, not to any env var).
COPY . .

RUN chmod +x service/entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["service/entrypoint.sh"]
