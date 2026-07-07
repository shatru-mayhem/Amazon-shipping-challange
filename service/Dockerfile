# Python skills bridge — a container that has what Vercel's Node
# serverless functions don't: a Python interpreter and psycopg2/faiss/numpy.
# Embeddings (skills/_llm.py) run on Gemini's cloud API, and generation
# defaults to Ollama's cloud API — neither needs anything installed in
# this container itself.
#
# Build from the REPO ROOT (not from service/), since it needs the whole
# skills/ tree and nl_query_gemini.py alongside it, same layout as local:
#   docker build -f service/Dockerfile -t amazon-skills-service .

FROM python:3.11-slim

WORKDIR /app

COPY service/requirements.txt service/requirements.txt
RUN pip install --no-cache-dir -r service/requirements.txt

# The rest of the repo — skills/*.py, nl_query_gemini.py, etc. — same
# layout the code already assumes locally (each skill's sys.path.insert
# is relative to its own __file__, not to any env var).
COPY . .

EXPOSE 8000
CMD ["uvicorn", "service.app:app", "--host", "0.0.0.0", "--port", "8000"]
