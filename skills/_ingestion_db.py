"""Write-capable DB access for skills that persist retrieval's answers
(currently just skills/retrieval/persist.py), via the app_ingestion role
— the same one lib/ingestion-db.ts uses on the Next.js side. Separate
from _db.py's run_sql/run_sql_one on purpose: those go through
nl_query_readonly and are read-only by design (validate_sql blocks
writes); this is the one place in the Python skills that's allowed to
write, and it's scoped to exactly that.

    from _ingestion_db import write_sql, write_sql_one
"""

import os
import psycopg2
import psycopg2.extras


def _load_dotenv_best_effort():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
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

DB_SCHEMAS = "core, constraints, knowledge, public"


def write_sql(sql: str, params=None) -> list:
    """Execute any SQL (including INSERT/UPDATE) via the app_ingestion
    role and return the rows (for RETURNING clauses). No validate_sql
    gate here — this connection is explicitly write-capable, unlike
    _db.run_sql's read-only nl_query_readonly connection."""
    conn = psycopg2.connect(os.environ["APP_INGESTION_DB_URL"])
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"SET search_path TO {DB_SCHEMAS}")
            cur.execute(sql, params)
            rows = [dict(row) for row in cur.fetchall()] if cur.description else []
        conn.commit()
        return rows
    finally:
        conn.close()


def write_sql_one(sql: str, params=None):
    rows = write_sql(sql, params)
    return rows[0] if rows else None
