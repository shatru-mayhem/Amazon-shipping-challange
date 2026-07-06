"""software_analytics — aggregate real tokenomics/latency telemetry from
every embed()/generate_json() call (skills/_llm.py logs each one to
observability.llm_call_log). Not opportunity-scoped — this is a
system-wide view of the pipeline's own LLM usage, not a per-deal output.
Pure read: no writes, no Gemini.

    from software_analytics import get_software_analytics
    result = get_software_analytics()
"""

import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _db import run_sql, run_sql_one  # noqa: E402

RECENT_CALLS_LIMIT = 50


def _float_or_none(v):
    return float(v) if v is not None else None


def _percentile(sorted_vals, pct):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return round(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo), 1)


def get_software_analytics() -> dict:
    overall = run_sql_one(
        """
        SELECT
            count(*)                                              AS total_calls,
            count(*) FILTER (WHERE success)                       AS successful_calls,
            count(*) FILTER (WHERE NOT success)                   AS failed_calls,
            coalesce(sum(prompt_tokens), 0)                        AS total_prompt_tokens,
            coalesce(sum(completion_tokens), 0)                    AS total_completion_tokens,
            coalesce(sum(total_tokens), 0)                         AS total_tokens,
            round(avg(total_duration_ms), 1)                       AS avg_latency_ms,
            count(*) FILTER (WHERE is_cloud)                       AS cloud_calls,
            count(*) FILTER (WHERE NOT is_cloud)                   AS local_calls
        FROM llm_call_log
        """
    ) or {}

    latencies = sorted(
        float(r["total_duration_ms"])
        for r in run_sql("SELECT total_duration_ms FROM llm_call_log WHERE total_duration_ms IS NOT NULL")
    )

    by_skill = run_sql(
        """
        SELECT
            coalesce(skill, 'unattributed')                        AS skill,
            count(*)                                               AS call_count,
            coalesce(sum(total_tokens), 0)                         AS total_tokens,
            round(avg(total_duration_ms), 1)                       AS avg_latency_ms,
            count(*) FILTER (WHERE NOT success)                    AS failed_calls
        FROM llm_call_log
        GROUP BY skill
        ORDER BY call_count DESC
        """
    )

    by_model = run_sql(
        """
        SELECT
            model,
            call_type,
            is_cloud,
            count(*)                                               AS call_count,
            coalesce(sum(total_tokens), 0)                         AS total_tokens,
            round(avg(total_duration_ms), 1)                       AS avg_latency_ms
        FROM llm_call_log
        GROUP BY model, call_type, is_cloud
        ORDER BY call_count DESC
        """
    )

    recent = run_sql(
        """
        SELECT skill, call_type, model, is_cloud, prompt_tokens, completion_tokens,
               total_tokens, total_duration_ms, success, error_message, created_at
        FROM llm_call_log
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (RECENT_CALLS_LIMIT,),
    )

    # Chronological (oldest-first) latency series for a per-call timeline
    # chart — small-N real data, not bucketed by day, since the pipeline
    # has only run a handful of times so far.
    timeline = run_sql(
        """
        SELECT created_at, call_type, skill, total_duration_ms, total_tokens, success
        FROM llm_call_log
        WHERE total_duration_ms IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 500
        """
    )

    # NUMERIC columns come back from psycopg2 as Decimal, which
    # json.dumps(default=str) silently turns into a string rather than a
    # JSON number — the frontend then gets e.g. "1234.5" instead of 1234.5,
    # so Number-only methods like .toFixed() break (Math.round() masked
    # this for a while since it coerces strings). Cast explicitly instead
    # of relying on default=str for anything the UI treats as a number.
    for row in by_skill:
        row["avg_latency_ms"] = _float_or_none(row["avg_latency_ms"])
    for row in by_model:
        row["avg_latency_ms"] = _float_or_none(row["avg_latency_ms"])
    for row in recent:
        row["total_duration_ms"] = _float_or_none(row["total_duration_ms"])
    for row in timeline:
        row["total_duration_ms"] = _float_or_none(row["total_duration_ms"])

    # Per-run view: one run_id = one skill-script subprocess invocation
    # (skills/_llm.py generates run_id once per process). A single
    # retrieval.py run fans out across several `skill` labels
    # (opportunity_features, tender_constraints, ...) that all share one
    # run_id, which is what lets the UI expand a run and see which script
    # consumed how much, instead of only ever showing lifetime totals.
    run_summaries = run_sql(
        """
        SELECT
            run_id,
            min(created_at)                                        AS started_at,
            max(created_at)                                         AS ended_at,
            count(*)                                                AS call_count,
            coalesce(sum(total_tokens), 0)                          AS total_tokens,
            coalesce(sum(total_duration_ms), 0)                     AS total_duration_ms,
            count(*) FILTER (WHERE NOT success)                     AS failed_calls,
            (array_agg(opportunity_id) FILTER (WHERE opportunity_id IS NOT NULL))[1] AS opportunity_id
        FROM llm_call_log
        GROUP BY run_id
        ORDER BY started_at DESC
        LIMIT 100
        """
    )

    run_skill_rows = run_sql(
        """
        SELECT
            run_id,
            coalesce(skill, 'unattributed')                         AS skill,
            count(*)                                                AS call_count,
            coalesce(sum(total_tokens), 0)                          AS total_tokens,
            coalesce(sum(total_duration_ms), 0)                     AS total_duration_ms,
            round(avg(total_duration_ms), 1)                        AS avg_latency_ms,
            count(*) FILTER (WHERE NOT success)                     AS failed_calls
        FROM llm_call_log
        WHERE run_id IN (SELECT run_id FROM llm_call_log GROUP BY run_id ORDER BY min(created_at) DESC LIMIT 100)
        GROUP BY run_id, skill
        ORDER BY total_duration_ms DESC
        """
    )
    skills_by_run: dict = {}
    for row in run_skill_rows:
        row["total_tokens"] = int(row["total_tokens"])
        row["total_duration_ms"] = _float_or_none(row["total_duration_ms"])
        row["avg_latency_ms"] = _float_or_none(row["avg_latency_ms"])
        skills_by_run.setdefault(str(row["run_id"]), []).append(row)

    opp_ids = [r["opportunity_id"] for r in run_summaries if r.get("opportunity_id")]
    opp_labels = {}
    if opp_ids:
        opp_rows = run_sql(
            """SELECT o.opportunity_id, o.title, c.name AS customer_name
               FROM opportunities o LEFT JOIN customers c ON c.customer_id = o.customer_id
               WHERE o.opportunity_id = ANY(%s::uuid[])""",
            (opp_ids,),
        )
        opp_labels = {str(r["opportunity_id"]): r for r in opp_rows}

    by_run = []
    for r in run_summaries:
        run_id = str(r["run_id"])
        opp = opp_labels.get(str(r["opportunity_id"])) if r.get("opportunity_id") else None
        by_run.append({
            "run_id": run_id,
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "call_count": r["call_count"],
            "total_tokens": int(r["total_tokens"]),
            "total_duration_ms": _float_or_none(r["total_duration_ms"]),
            "failed_calls": r["failed_calls"],
            "opportunity_title": opp["title"] if opp else None,
            "customer_name": opp["customer_name"] if opp else None,
            "skills": skills_by_run.get(run_id, []),
        })

    total_calls = overall.get("total_calls") or 0
    success_rate = round((overall.get("successful_calls") or 0) / total_calls, 3) if total_calls else None

    return {
        "total_calls": total_calls,
        "success_rate": success_rate,
        "failed_calls": overall.get("failed_calls") or 0,
        "total_prompt_tokens": overall.get("total_prompt_tokens") or 0,
        "total_completion_tokens": overall.get("total_completion_tokens") or 0,
        "total_tokens": overall.get("total_tokens") or 0,
        "avg_latency_ms": float(overall["avg_latency_ms"]) if overall.get("avg_latency_ms") is not None else None,
        "p50_latency_ms": _percentile(latencies, 0.50),
        "p95_latency_ms": _percentile(latencies, 0.95),
        "cloud_calls": overall.get("cloud_calls") or 0,
        "local_calls": overall.get("local_calls") or 0,
        "by_skill": by_skill,
        "by_model": by_model,
        "recent_calls": recent,
        "latency_timeline": timeline,
        "by_run": by_run,
        # Ollama's cloud API is subscription/API-key based, not a published
        # per-token rate — token counts are the real, verifiable tokenomics
        # signal here; a $ figure would be invented, so it's deliberately
        # not shown rather than guessed.
        "cost_note": "Ollama cloud is not billed per-token at a published rate — token counts shown instead of a $ estimate.",
    }


if __name__ == "__main__":
    print(json.dumps(get_software_analytics(), indent=2, default=str))
