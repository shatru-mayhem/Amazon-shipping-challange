"""
nl_query.py — Natural-language query wrapper over the tender-analysis Supabase DB.
Gemini version.

Flow:
  question (English) -> Gemini writes SQL -> validated -> executed read-only
  against Supabase -> Gemini summarizes the rows into a natural-language answer.

Usage:
    python nl_query.py "tell me about pricing in the Balearic Islands"
    python nl_query.py "what constraints has Tecnomania triggered that are unsatisfied?"

Setup:
    pip install google-genai psycopg2-binary --break-system-packages

    Environment variables required:
      GEMINI_API_KEY       - your Google AI Studio / Gemini API key
      SUPABASE_DB_URL      - a READ-ONLY connection string, e.g.
                             postgresql://app_readonly:<password>@<host>:5432/postgres
      GEMINI_MODEL          - optional, defaults to "gemini-2.5-flash" below.
                             Check https://ai.google.dev/gemini-api/docs/models
                             for the current model name — this changes over time
                             and the default here may be out of date by the time
                             you run this.

IMPORTANT: create a dedicated read-only Postgres role in Supabase before
pointing this at production data:

    CREATE ROLE app_readonly LOGIN PASSWORD '...';
    GRANT USAGE ON SCHEMA core, constraints, pricing, knowledge, orchestration TO app_readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA core, constraints, pricing, knowledge, orchestration TO app_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA core, constraints, pricing, knowledge, orchestration
        GRANT SELECT ON TABLES TO app_readonly;

Never use the Supabase service_role key for this script — that key bypasses
RLS and has full write access. The validation in this script (below) is a
second line of defense, not a replacement for a read-only DB role.
"""

import os
import re
import sys
import json
import time
import psycopg2
import psycopg2.extras


def _load_dotenv_best_effort():
    """Load KEY=VALUE pairs from a sibling .env into os.environ if they
    aren't already set. Best-effort and dependency-free: other backends
    (Node/Java) may inject env vars their own way, and in that case this
    silently does nothing. Existing environment variables always win."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
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

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
DEFAULT_ROW_LIMIT = 200

# The schema barely changes between questions, so re-running every
# introspection query (columns, CHECK constraints, JSONB samples, distinct
# values — several queries per call) on every single invocation is wasted
# round-trips to Supabase. Cache the static (question-independent) part to
# disk and only refresh it once the TTL expires or --refresh-cache is passed.
# Bucket resolution still runs fresh every time (it's pure Python over the
# cached distinct values, no DB call, and it depends on the question).
SCHEMA_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".nl_query_schema_cache.json")
SCHEMA_CACHE_TTL_SECONDS = int(os.environ.get("SCHEMA_CACHE_TTL_SECONDS", 3600))

FORBIDDEN_KEYWORDS = [
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE",
    "GRANT", "REVOKE", "CREATE", "COPY", "CALL", "EXECUTE", "VACUUM",
]

# Gemini is imported and instantiated lazily. The direct-SQL path
# (run_sql / run_sql_one, used by the feature scripts) must work with no
# GEMINI_API_KEY at all, and importing this module for that path should
# never crash just because the Gemini key is absent. Only the natural-
# language path (ask / generate_sql) actually needs the client.
_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. It is only needed for natural-language "
                "questions (ask / generate_sql). For direct SQL use run_sql(), which "
                "needs SUPABASE_DB_URL but no Gemini key."
            )
        from google import genai
        _client = genai.Client(api_key=api_key)
    return _client


# ---------------------------------------------------------------------
# 0. Deterministic bucket-label resolution — no LLM guessing involved.
#
# Columns like weight_band ("0.75-1kg", "up to 1.5kg", "Up to 30kg", ...)
# are TEXT, not numeric, so Gemini can't compare them with > / < / BETWEEN.
# Previously we just showed Gemini the list of distinct strings and hoped
# it picked the right one by reasoning in-context — that worked sometimes
# and silently failed other times (e.g. selecting the whole table instead
# of filtering to the one bucket a question's number belongs to).
#
# This resolves bucket membership in plain Python instead: parse every
# bucket label's numeric bound, reconstruct the real (lower, upper] range
# for each bucket (labels like "up to 1.5kg" only give an upper bound in
# isolation — their true lower bound is the previous bucket's upper bound,
# since these are sequential size brackets, not each starting at zero),
# then for any number mentioned in the question, find the exact bucket it
# falls into and hand that literal string to Gemini as a pre-computed fact
# it must use verbatim, rather than a guess it has to make itself.
# ---------------------------------------------------------------------

_BUCKET_OPEN_ENDED_RE = re.compile(r"^\s*([\d.]+)\s*\+\s*$")
_BUCKET_UP_TO_RE = re.compile(r"^\s*up\s*to\s*([\d.]+)", re.IGNORECASE)
_BUCKET_RANGE_RE = re.compile(r"^\s*([\d.]+)\s*-\s*([\d.]+)")

# Numbers in the question, optionally followed by a unit word — the unit
# itself isn't used for matching (bucket labels carry their own units and
# we only compare magnitudes), it's just part of what we scan past.
_QUESTION_NUMBER_RE = re.compile(r"(\d+(?:\.\d+)?)")


def _parse_bucket_bound(label: str):
    """Extract the bound(s) a single bucket label expresses. Returns a dict
    with 'lower' (float or None), 'upper' (float or None, None = open-ended),
    and 'explicit_lower' (whether lower came from the label itself vs. needs
    to be inferred from bracket order). Returns None if the label doesn't
    look like a numeric bucket at all (e.g. a plain category like
    'first_mile') — callers use that to bail out of treating the column
    as a bucket column."""
    s = label.strip()

    m = _BUCKET_OPEN_ENDED_RE.match(s)
    if m:
        return {"lower": float(m.group(1)), "upper": None, "explicit_lower": True}

    m = _BUCKET_UP_TO_RE.match(s)
    if m:
        return {"lower": None, "upper": float(m.group(1)), "explicit_lower": False}

    m = _BUCKET_RANGE_RE.match(s)
    if m:
        return {"lower": float(m.group(1)), "upper": float(m.group(2)), "explicit_lower": True}

    return None


def build_bucket_ranges(values: list):
    """Given a column's full set of distinct bucket labels, reconstruct each
    label's real (lower, upper] numeric range and return {label: (lower, upper)}.
    Returns None if the values don't consistently look like a bucket/range
    column (e.g. mile_type's 'first_mile'/'last_mile' — plain categories,
    not ranges) so callers can tell bucket columns apart from category
    columns using the same distinct-value data."""
    parsed = []
    for v in values:
        if not isinstance(v, str):
            return None
        bound = _parse_bucket_bound(v)
        if bound is None:
            return None
        parsed.append((v, bound))

    if not parsed:
        return None

    # Order ascending by whatever bound each label does carry, so
    # "up to X" labels line up after the bracket whose upper bound
    # precedes them — this is what lets us infer their real lower bound.
    def sort_key(item):
        _, b = item
        anchor = b["upper"] if b["upper"] is not None else b["lower"]
        return (anchor is None, anchor if anchor is not None else float("inf"))

    parsed.sort(key=sort_key)

    ranges = {}
    prev_upper = 0.0
    for label, b in parsed:
        lower = b["lower"] if b["explicit_lower"] else prev_upper
        upper = b["upper"] if b["upper"] is not None else float("inf")
        ranges[label] = (lower, upper)
        if upper != float("inf"):
            prev_upper = upper
    return ranges


def resolve_bucket_matches(question: str, distinct_values: dict) -> list:
    """For every column whose distinct values are all numeric bucket labels,
    check whether any number mentioned in the question falls inside exactly
    one bucket, and return human-readable, authoritative resolutions like:
    'pricing.cost_matrix.weight_band: the number 1 matches bucket "0.75-1kg"'.
    These get shown to Gemini as pre-computed facts, not something it needs
    to (re-)derive itself."""
    numbers = [float(m.group(1)) for m in _QUESTION_NUMBER_RE.finditer(question)]
    if not numbers:
        return []

    resolutions = []
    for col_key, values in distinct_values.items():
        ranges = build_bucket_ranges(values)
        if not ranges:
            continue
        for num in numbers:
            matches = [
                label for label, (lower, upper) in ranges.items()
                if (lower == 0 and num >= lower and num <= upper) or (num > lower and num <= upper)
            ]
            if len(matches) == 1:
                resolutions.append(f'{col_key}: the number {num:g} matches bucket "{matches[0]}"')
    return resolutions


# ---------------------------------------------------------------------
# 1. Schema context — introspected live so it never drifts from reality
# ---------------------------------------------------------------------

SCHEMA_INTROSPECTION_SQL = """
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema IN ('core','constraints','pricing','knowledge','orchestration')
ORDER BY table_schema, table_name, ordinal_position;
"""

# CHECK constraints (the enum-like ones, e.g. capability_status IN ('can_do', ...))
# are NOT in information_schema.columns — they live in pg_constraint as raw
# expression text. Without these, an LLM writing SQL against a TEXT column
# has no way to know the real allowed values and will guess something
# plausible-sounding instead (this is exactly what produced the
# capability_status = 'active' bug — 'active' was a reasonable guess,
# just wrong, because the actual values ('can_do'/'cannot_do'/
# 'can_do_with_conditions') were never visible to the model).
CHECK_CONSTRAINTS_SQL = """
SELECT
    nsp.nspname AS table_schema,
    rel.relname AS table_name,
    pg_get_constraintdef(con.oid) AS constraint_def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE con.contype = 'c'
  AND nsp.nspname IN ('core','constraints','pricing','knowledge','orchestration');
"""

def get_jsonb_samples(conn, columns) -> dict:
    """For every jsonb/json column found, pull a couple of real rows so
    Gemini sees actual key names — 'jsonb' as a type tells it nothing
    about what's nested inside, which is exactly what produced the
    not_covered / 'region' key-guessing bug. Best-effort: if a query
    fails (e.g. permissions, weird identifiers) it's skipped, not fatal."""
    samples = {}
    with conn.cursor() as cur:
        for schema, table, col, dtype in columns:
            if dtype not in ("jsonb", "json"):
                continue
            key = f"{schema}.{table}.{col}"
            try:
                cur.execute(
                    f'SELECT "{col}" FROM "{schema}"."{table}" WHERE "{col}" IS NOT NULL LIMIT 2'
                )
                rows = cur.fetchall()
                if rows:
                    samples[key] = [r[0] for r in rows]
            except Exception:
                conn.rollback()
    return samples


# Free-text columns we never want to dump distinct values for, even if a
# small table happens to give them a low distinct count — these are prose,
# not category/bucket labels, and listing them wastes tokens without
# helping the model write better SQL.
FREE_TEXT_COLUMN_DENYLIST = {
    "description", "text", "rationale", "tradeoffs", "negotiation_notes",
    "raw_text", "stated_text", "body_redacted", "conditions_text",
    "gap_description", "embedded_text", "blob_url", "file_hash", "filename",
    "subject", "sender", "detail", "resolved_by", "reviewer_id",
}

DISTINCT_VALUE_MAX_COUNT = 30


def get_distinct_text_values(conn, columns) -> dict:
    """For low-cardinality TEXT/varchar columns (category and bucket labels
    like weight_band = '0.75-1kg', 'up to 1.5kg', ...), pull the real
    distinct values so Gemini can match a number in the question (e.g.
    "a 1kg package") to the actual literal bucket string instead of
    guessing at a comparison it can't express (weight_band isn't numeric,
    so `WHERE weight_band > 1` doesn't work — you have to know which
    literal string the value 1kg falls into). This is the same problem
    CHECK constraints and JSONB samples solve for other columns; bucket
    labels are neither, so they were previously invisible to the model."""
    samples = {}
    with conn.cursor() as cur:
        for schema, table, col, dtype in columns:
            if dtype not in ("text", "character varying"):
                continue
            if col in FREE_TEXT_COLUMN_DENYLIST:
                continue
            key = f"{schema}.{table}.{col}"
            try:
                cur.execute(
                    f'SELECT DISTINCT "{col}" FROM "{schema}"."{table}" WHERE "{col}" IS NOT NULL LIMIT %s',
                    (DISTINCT_VALUE_MAX_COUNT + 1,),
                )
                values = [r[0] for r in cur.fetchall()]
                if values and len(values) <= DISTINCT_VALUE_MAX_COUNT:
                    samples[key] = values
            except Exception:
                conn.rollback()
    return samples


def _fetch_static_schema_data(conn) -> dict:
    """The expensive, question-independent part: columns, CHECK constraints,
    JSONB samples, distinct text/bucket values — all straight from Supabase.
    This is what gets cached, since none of it changes between questions."""
    with conn.cursor() as cur:
        cur.execute(SCHEMA_INTROSPECTION_SQL)
        columns = [list(row) for row in cur.fetchall()]
        cur.execute(CHECK_CONSTRAINTS_SQL)
        checks = [list(row) for row in cur.fetchall()]

    jsonb_samples = get_jsonb_samples(conn, columns)
    distinct_values = get_distinct_text_values(conn, columns)

    return {
        "columns": columns,
        "checks": checks,
        "jsonb_samples": jsonb_samples,
        "distinct_values": distinct_values,
        "cached_at": time.time(),
    }


def _load_static_schema_data(conn, force_refresh: bool = False) -> dict:
    """Loads the static schema data from disk cache if it's fresh enough,
    otherwise re-fetches from Supabase and rewrites the cache. A corrupt or
    missing cache file is treated the same as a cache miss, not an error."""
    if not force_refresh and os.path.exists(SCHEMA_CACHE_PATH):
        try:
            with open(SCHEMA_CACHE_PATH, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if time.time() - cached.get("cached_at", 0) < SCHEMA_CACHE_TTL_SECONDS:
                return cached
        except (OSError, json.JSONDecodeError):
            pass

    data = _fetch_static_schema_data(conn)
    try:
        with open(SCHEMA_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError:
        pass  # caching is an optimization, not a requirement — proceed uncached
    return data


def build_schema_context_text(static_data: dict, question: "str | None" = None) -> str:
    """Builds a compact schema.table (col type, col type, ...) description
    for every table, plus CHECK constraint values, JSONB samples, distinct
    bucket/category values, and — if a question is given — deterministic
    bucket resolutions for any number mentioned in it. Pure function over
    already-fetched data: no DB access here, so this is cheap to call on
    every question even though the underlying data was cached."""
    columns = static_data["columns"]
    checks = static_data["checks"]
    jsonb_samples = static_data["jsonb_samples"]
    distinct_values = static_data["distinct_values"]
    bucket_resolutions = resolve_bucket_matches(question, distinct_values) if question else []

    tables = {}
    for schema, table, col, dtype in columns:
        key = f"{schema}.{table}"
        tables.setdefault(key, []).append(f"{col} {dtype}")

    check_lines = {}
    for schema, table, constraint_def in checks:
        key = f"{schema}.{table}"
        check_lines.setdefault(key, []).append(constraint_def)

    lines = []
    for table, cols in tables.items():
        lines.append(f"{table}({', '.join(cols)})")
        for c in check_lines.get(table, []):
            lines.append(f"  CHECK on {table}: {c}")
        for col_key, samples in jsonb_samples.items():
            if col_key.startswith(table + "."):
                for s in samples:
                    lines.append(f"  Sample value for {col_key}: {json.dumps(s, default=str)}")
        for col_key, values in distinct_values.items():
            if col_key.startswith(table + "."):
                lines.append(f"  Distinct values for {col_key}: {json.dumps(values, default=str)}")
        for resolution in bucket_resolutions:
            if resolution.startswith(table + "."):
                lines.append(f"  Bucket resolution (pre-computed, authoritative — use verbatim): {resolution}")
    return "\n".join(lines)


def get_schema_context(conn, question: "str | None" = None, force_refresh: bool = False) -> str:
    """Convenience wrapper: load (cached or fresh) static schema data, then
    build the context text for this question."""
    static_data = _load_static_schema_data(conn, force_refresh=force_refresh)
    return build_schema_context_text(static_data, question)


# ---------------------------------------------------------------------
# 2. Gemini writes the SQL
# ---------------------------------------------------------------------

SQL_SYSTEM_PROMPT = """You write PostgreSQL SELECT queries against the tender analysis database below.

Rules, no exceptions:
- Output ONLY a JSON object: {{"sql": "...", "explanation": "..."}}. No markdown, no prose outside the JSON.
- SELECT statements only. Never write INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, GRANT, or any other mutating/DDL statement.
- Always schema-qualify table names (e.g. constraints.tender_constraints, not tender_constraints).
- Always include an explicit LIMIT clause, {row_limit} rows or fewer, unless the question clearly asks for an aggregate (COUNT, SUM, AVG) that returns one row.
- If the question is ambiguous or can't be answered from this schema, set "sql" to null and explain why in "explanation".
- Prefer joining across schemas over guessing at values — e.g. join constraints.tender_constraints to constraints.constraint_catalog to constraints.amazon_capability_profile to answer "what can't we do for this customer".
- Where the schema below shows a "CHECK on schema.table:" line, the referenced column only accepts the exact values listed in that constraint. Use one of those values verbatim. Never write a plausible-sounding value (e.g. 'active') that doesn't appear in the CHECK definition — if you're unsure which listed value matches the question's intent, pick the closest one and say so in "explanation", don't invent a new one.
- Where the schema below shows "Sample value for schema.table.column: {{...}}", that's a real JSONB value from that column. Use the JSON keys exactly as shown there (e.g. ->>'not_covered', ->'structured_value'->'max_weight_kg') — never invent a key name that doesn't appear in a sample. If no sample is shown for a jsonb column relevant to the question, say so in "explanation" instead of guessing a key.
- When a question asks for two or more values that come from JSONB fields with DIFFERENT shapes (e.g. one is a scalar number, another is a nested object or array), never merge them into a single CASE expression or single output column — Postgres will reject it with "CASE types X and Y cannot be matched" the moment the branches don't share a type, and casting everything to ::text to force a match just hides the real shapes from the caller. Instead, give each value its own output column (one SELECT, multiple columns, one column per JSON shape/value being asked for), each extracted with whatever operator (->>, ->) matches that value's own type.
- Where the schema below shows "Distinct values for schema.table.column: [...]", that column holds literal bucket/category labels (e.g. weight_band = "0.75-1kg", "up to 1.5kg", "Up to 30kg") — it is TEXT, not numeric, so you can never compare it with >, <, or BETWEEN against a number. If the question gives a concrete number that must fall into one of these buckets (e.g. "a 1kg package", "500 packages/day"), read the bucket ranges from the listed strings and pick the ONE literal string whose range contains that number, then filter with `column = 'that exact string'`. Never fall back to selecting the whole table or every bucket when a question names a specific value that maps to exactly one bucket — that produces a huge, unfiltered result that does not answer the question.
- Where the schema below shows "Bucket resolution (pre-computed, authoritative — use verbatim): schema.table.column: the number N matches bucket "X"", that match was already computed in plain Python, not guessed — use that exact bucket string X directly in a `column = 'X'` filter. Do not re-derive it yourself from the distinct-values list and do not second-guess it.

Example (JSONB, different shapes -> separate columns, no capability_status guess):
  Sample value for constraints.amazon_capability_profile.structured_value: {{"max_weight_kg": 15}}
  Sample value for constraints.amazon_capability_profile.structured_value: {{"max_dimensions_cm": [80, 80, 60]}}
  ->
  SELECT
    (SELECT acp.structured_value->>'max_weight_kg' FROM constraints.amazon_capability_profile acp JOIN constraints.constraint_catalog cc ON cc.constraint_type_id = acp.constraint_type_id WHERE cc.name = 'Maximum package weight' LIMIT 1) AS max_weight_kg,
    (SELECT acp.structured_value->'max_dimensions_cm' FROM constraints.amazon_capability_profile acp JOIN constraints.constraint_catalog cc ON cc.constraint_type_id = acp.constraint_type_id WHERE cc.name = 'Maximum package dimensions' LIMIT 1) AS max_dimensions_cm;

Example (bucket match, no filter on capability_status since the question doesn't ask about it):
  Bucket resolution: pricing.cost_matrix.weight_band: the number 1 matches bucket "0.75-1kg"
  -> SELECT mile_type, daily_volume_band, cost_eur FROM pricing.cost_matrix WHERE weight_band = '0.75-1kg' LIMIT {row_limit};

Schema:
{schema}
"""

def generate_sql(question: str, schema_context: str) -> dict:
    from google.genai import types
    resp = _get_client().models.generate_content(
        model=GEMINI_MODEL,
        contents=question,
        config=types.GenerateContentConfig(
            system_instruction=SQL_SYSTEM_PROMPT.format(schema=schema_context, row_limit=DEFAULT_ROW_LIMIT),
            response_mime_type="application/json",
            temperature=0,
        ),
    )
    text = resp.text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini did not return valid JSON: {text}") from e


# ---------------------------------------------------------------------
# 3. Validate before executing — second line of defense after the
#    read-only DB role
# ---------------------------------------------------------------------

def validate_sql(sql: str) -> None:
    if sql is None:
        raise ValueError("No SQL was generated for this question.")

    stripped = sql.strip().rstrip(";")
    if not re.match(r"^\s*(SELECT|WITH)\b", stripped, re.IGNORECASE):
        raise ValueError(f"Refusing to run non-SELECT statement: {sql}")

    upper = stripped.upper()
    for word in FORBIDDEN_KEYWORDS:
        if re.search(rf"\b{word}\b", upper):
            raise ValueError(f"Refusing to run query containing forbidden keyword '{word}': {sql}")

    # NOTE: we deliberately do NOT require a LIMIT or aggregate in the SQL
    # text here. A query like "(SELECT x FROM a) - (SELECT y FROM b)"
    # legitimately returns one row with neither a LIMIT clause nor a
    # COUNT/SUM-style aggregate function, and rejecting it on that basis
    # is a false positive (this is exactly what broke the OTP-vs-SOD
    # subtraction query). The row cap is enforced in execute_sql() via
    # fetchmany() instead, which works regardless of what the query text
    # looks like.


# ---------------------------------------------------------------------
# 4. Execute read-only against Supabase
# ---------------------------------------------------------------------

# The tables live in these Postgres schemas, not public. Putting them on
# the search_path lets both the NL path and the direct-SQL feature scripts
# use unqualified table names (opportunities, cost_matrix, ...) and still
# resolve. Table names are unique across these schemas, so there's no
# ambiguity. Schema-qualified names keep working regardless.
DB_SCHEMAS = "core, constraints, pricing, knowledge, orchestration, public"


def execute_sql(conn, sql: str, params=None) -> list:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute(f"SET search_path TO {DB_SCHEMAS}")
        cur.execute(sql, params)
        # Cap here regardless of whether the query text itself has a LIMIT —
        # this is what lets validate_sql stop requiring LIMIT/aggregate syntax.
        return [dict(row) for row in cur.fetchmany(DEFAULT_ROW_LIMIT)]


# ---------------------------------------------------------------------
# 4b. Direct SQL entry point — NO Gemini involved.
#
# This is the function other feature scripts (risk_assessment,
# pricing_recommendations, win_probability, ...) call. They already know
# the exact SELECT they need, so there's no reason to spend a Gemini call
# generating it. Same DB, same read-only guarantees, same row cap and
# same validate_sql defense-in-depth as the natural-language path — just
# without the LLM step. Supports parameterized queries so callers pass an
# opportunity_id safely instead of string-formatting it into the SQL.
# ---------------------------------------------------------------------

def run_sql(sql: str, params=None) -> list:
    """Execute a read-only SELECT directly against Supabase and return a
    list of dict rows. No Gemini, no schema introspection — just the query.
    Requires SUPABASE_DB_URL; does NOT require GEMINI_API_KEY.

    Example:
        rows = run_sql(
            "SELECT title, status FROM opportunities WHERE opportunity_id = %s",
            (opportunity_id,),
        )
    """
    validate_sql(sql)
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    try:
        return execute_sql(conn, sql, params)
    finally:
        conn.close()


def run_sql_one(sql: str, params=None) -> "dict | None":
    """Same as run_sql but returns just the first row (or None). Convenience
    for the many feature queries that aggregate down to a single row."""
    rows = run_sql(sql, params)
    return rows[0] if rows else None


# ---------------------------------------------------------------------
# 5. Format results — compact column: value pairs, no narrative wrapper.
#    No LLM call here: the SQL result's column names already tell you
#    which field each value came from, and asking an LLM to restate
#    that as prose only adds latency and a chance to garble a number.
# ---------------------------------------------------------------------

def format_compact(rows: list) -> str:
    if not rows:
        return "(no rows returned)"

    lines = []
    for i, row in enumerate(rows):
        if len(rows) > 1:
            lines.append(f"[{i+1}]")
        for col, val in row.items():
            lines.append(f"  {col}: {val}")
    return "\n".join(lines)


# ---------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------

def ask(question: str, force_refresh_schema: bool = False) -> dict:
    db_url = os.environ["SUPABASE_DB_URL"]
    conn = psycopg2.connect(db_url)
    try:
        schema_context = get_schema_context(conn, question=question, force_refresh=force_refresh_schema)
        generated = generate_sql(question, schema_context)

        if not generated.get("sql"):
            return {"question": question, "sql": None, "answer": generated.get("explanation", "Could not generate a query for this question.")}

        validate_sql(generated["sql"])
        rows = execute_sql(conn, generated["sql"])
        answer = format_compact(rows)

        return {"question": question, "sql": generated["sql"], "row_count": len(rows), "answer": answer}
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python nl_query.py \"your question here\"")
        print("       python nl_query.py --debug-schema   (prints the schema context Gemini receives, no LLM call)")
        print("       python nl_query.py --refresh-cache \"your question here\"   (bypass the schema cache for this run)")
        sys.exit(1)

    if sys.argv[1] == "--debug-schema":
        conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
        try:
            print(get_schema_context(conn))
        finally:
            conn.close()
        sys.exit(0)

    args = sys.argv[1:]
    refresh = False
    if args and args[0] == "--refresh-cache":
        refresh = True
        args = args[1:]

    result = ask(" ".join(args), force_refresh_schema=refresh)
    print(f"\nSQL run:\n{result['sql']}\n")
    print(f"Answer:\n{result['answer']}\n")