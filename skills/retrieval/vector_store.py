"""vector_store — FAISS-backed similarity search over a small, in-memory
set of texts (a tender's document_chunks, or similar). Built fresh per
retrieve() call — the corpus is a handful of chunks per tender, not a
persistent large-scale index, so there's no cross-call index to
maintain or invalidate.

    from vector_store import VectorStore
    store = VectorStore(chunks, text_key="raw_text", id_key="chunk_id")
    hits = store.search("Delivery speed: committed delivery time window", k=2)
    # -> [{"item": <original chunk dict>, "score": 0.71}, ...]

Why this exists: retrieval.py's tender_constraints used to hand every
catalog type the ENTIRE batch of source text and ask "does any of this
match?" — which let irrelevant text (a company address, a disclaimer)
get force-matched onto an unrelated constraint type. Retrieving only the
chunks actually similar to a given catalog type's description, before
ever calling the LLM, fixes that at the source instead of asking the
model to somehow ignore irrelevant text on its own.
"""

import numpy as np
import faiss

import sys
import os

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)

from _llm import embed  # noqa: E402


class VectorStore:
    def __init__(self, items: list, text_key: str, id_key: str):
        """items: list of dicts, each containing at least text_key and
        id_key. Embeds every item's text_key immediately (local
        nomic-embed-text — fast, no cloud round-trip)."""
        self.items = items
        if not items:
            self.index = None
            return

        vectors = np.array([embed(item[text_key]) for item in items], dtype="float32")
        faiss.normalize_L2(vectors)  # inner product on normalized vectors == cosine similarity
        self.index = faiss.IndexFlatIP(vectors.shape[1])
        self.index.add(vectors)

    def search(self, query_text: str, k: int = 3) -> list:
        """Returns up to k {"item": <original dict>, "score": float}
        entries, best match first. Empty list if the store has no items."""
        if self.index is None:
            return []

        query_vec = np.array([embed(query_text)], dtype="float32")
        faiss.normalize_L2(query_vec)
        k = min(k, len(self.items))
        scores, indices = self.index.search(query_vec, k)

        return [
            {"item": self.items[idx], "score": float(scores[0][rank])}
            for rank, idx in enumerate(indices[0])
            if idx != -1
        ]
