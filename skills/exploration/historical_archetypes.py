"""historical_archetypes — exploratory analysis over core.historical_tenders
(the 360 real historical opportunities, migrated from
public.historical_opportunities — see supabase/migrate_historical_data.sql).

NOT a production skill: this doesn't answer a per-opportunity question
the way retrieval.py / commercial_strategy.py / etc. do. It's a
standalone exploration to validate an idea before wiring anything into
the dashboard: instead of using historical data only to predict (the
win-rate/margin percentiles pricing_recommendations and win_probability
already compute), use PCA to find out which tender features actually
co-vary — do high-volume deals also tend to need international/B2B? does
low geo-fit correlate with the same pain points regardless of industry?
— then cluster on that to define a handful of "opportunity archetypes",
each with its own empirical win rate, margin, and common pain points.

If the clusters turn out meaningful (checked against real win/loss
outcome as a sanity check, not as the clustering target itself — this is
unsupervised), the natural next step is a "nearest archetype" lookup
feeding into commercial_strategy (common objections/pain points for this
archetype), risk_assessment (this archetype's typical loss reasons), and
pricing_recommendations (archetype-specific margin bands instead of one
global percentile). That wiring is NOT built yet — this script is step
one: does the idea hold up on the real data.

Usage:
    python skills/exploration/historical_archetypes.py [--clusters N] [--plot]
    python skills/exploration/historical_archetypes.py --json [--clusters N]
        Prints the same analysis as a single JSON object instead of prose —
        for app/api/historical-insights/route.ts / service/app.py to render
        on a dashboard page.
    python skills/exploration/historical_archetypes.py --json --save-model
        Also fits+pickles the (scaler, pca, kmeans) pipeline to
        historical_archetypes_model.joblib next to this file, and includes
        its path in the JSON output so the API route can serve it as a
        download.
    python skills/exploration/historical_archetypes.py --json --update-requirements-doc
        Also (re)writes the auto-generated "Historical analysis findings"
        section of RETRIEVAL_REQUIREMENTS.md at the repo root, so the
        fields this analysis flags as worth prioritizing are reflected in
        the same doc that maps skill -> field -> origin.
"""

import os
import re
import sys
import json
import argparse

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
import joblib
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans

_SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SKILLS_DIR not in sys.path:
    sys.path.insert(0, _SKILLS_DIR)


def _load_dotenv_best_effort():
    env_path = os.path.join(_SKILLS_DIR, "..", ".env")
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


def _fetch_all_historical_tenders() -> list:
    """_db.run_sql caps every query at 200 rows (DEFAULT_ROW_LIMIT, a
    safety limit sized for NL-query result sets) — wrong for an analytical
    script that needs the full population, not a capped, non-random
    subset. Own connection + fetchall(), same read-only role
    (nl_query_readonly), no cap."""
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute("SET search_path TO core, constraints, pricing, knowledge, orchestration, public")
            cur.execute("SELECT tender_id, features, margin, outcome FROM historical_tenders")
            return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()

NUMERIC_FEATURES = [
    "daily_volume_total", "geo_fit_pct", "daily_volume_serviceable", "avg_weight_kg",
    "oversized_pct", "intl_volume_share", "pain_severity", "price_vs_incumbent_pct",
    "competitive_intensity", "sales_cycle_touches", "decision_time_days", "contract_length_months",
]
BOOLEAN_FEATURES = ["requires_intl", "requires_pudo", "requires_b2b", "weekend_need"]
ALL_FEATURES = NUMERIC_FEATURES + BOOLEAN_FEATURES


def load_data() -> pd.DataFrame:
    rows = _fetch_all_historical_tenders()
    records = []
    for r in rows:
        f = r["features"] or {}
        rec = {"tender_id": r["tender_id"], "margin": r["margin"], "outcome": r["outcome"]}
        for col in NUMERIC_FEATURES:
            rec[col] = f.get(col)
        for col in BOOLEAN_FEATURES:
            rec[col] = 1.0 if f.get(col) in (True, "true", "True", 1) else 0.0
        rec["main_pain_point"] = f.get("main_pain_point")
        rec["lost_reason"] = f.get("lost_reason")
        records.append(rec)
    return pd.DataFrame.from_records(records)


def compute_correlations(df: pd.DataFrame, threshold: float = 0.3) -> list:
    """Returns [{'a', 'b', 'r'}, ...] for every feature pair at |r| >= threshold,
    sorted strongest-first. Pure computation, no printing — print_correlations
    and the --json path both build on this so the two output modes can never
    silently disagree."""
    corr = df[ALL_FEATURES].astype(float).corr()
    seen = set()
    pairs = []
    for a in corr.columns:
        for b in corr.columns:
            if a == b or (b, a) in seen:
                continue
            seen.add((a, b))
            r = corr.loc[a, b]
            if abs(r) >= threshold:
                pairs.append({"a": a, "b": b, "r": round(float(r), 3)})
    pairs.sort(key=lambda p: -abs(p["r"]))
    return pairs


def print_correlations(pairs: list) -> None:
    print("\n=== Feature correlations (|r| >= 0.3) — which features move together ===")
    for p in pairs:
        print(f"  {p['a']:28s} <-> {p['b']:28s}  r = {p['r']:+.2f}")
    if not pairs:
        print("  (no pairs at this threshold — features are largely independent)")


def compute_pca(df: pd.DataFrame, n_components: int = 3) -> dict:
    """Returns {'scaler', 'pca', 'components', 'X_scaled', 'summary'} — the
    fitted objects (for model saving / clustering) plus a JSON-safe summary
    (explained variance, top loadings per component)."""
    X = df[ALL_FEATURES].astype(float).fillna(df[ALL_FEATURES].astype(float).median())
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    pca = PCA(n_components=n_components)
    components = pca.fit_transform(X_scaled)

    pcs = []
    for i in range(n_components):
        loadings = pd.Series(pca.components_[i], index=ALL_FEATURES).sort_values(key=abs, ascending=False)
        pcs.append({
            "pc": i + 1,
            "top_loadings": [
                {"feature": feat, "loading": round(float(load), 3)}
                for feat, load in loadings.head(5).items()
            ],
        })

    summary = {
        "explained_variance_ratio": [round(float(v), 3) for v in pca.explained_variance_ratio_],
        "cumulative_variance": round(float(sum(pca.explained_variance_ratio_)), 3),
        "components": pcs,
    }
    return {"scaler": scaler, "pca": pca, "components": components, "X_scaled": X_scaled, "summary": summary}


def print_pca(summary: dict) -> None:
    print(f"\n=== PCA — {len(summary['components'])} components ===")
    print(f"Explained variance ratio: {summary['explained_variance_ratio']}")
    print(f"Cumulative: {summary['cumulative_variance']}")
    for pc in summary["components"]:
        print(f"\nPC{pc['pc']} top loadings (features that move together on this axis):")
        for l in pc["top_loadings"]:
            print(f"  {l['feature']:28s} {l['loading']:+.3f}")


def compute_clusters(df: pd.DataFrame, X_scaled: np.ndarray, k: int) -> dict:
    """Returns {'kmeans', 'labeled_df', 'archetypes'} — the fitted KMeans (for
    model saving), the df with a 'cluster' column, and a JSON-safe per-cluster
    summary (n, win_rate, avg_margin, top pain point, feature profile)."""
    kmeans = KMeans(n_clusters=k, n_init=10, random_state=42)
    labeled = df.copy()
    labeled["cluster"] = kmeans.fit_predict(X_scaled)

    archetypes = []
    for c in sorted(labeled["cluster"].unique()):
        sub = labeled[labeled["cluster"] == c]
        won = sub[sub["outcome"] == "won"]
        win_rate = len(won) / len(sub) if len(sub) else 0
        avg_margin = won["margin"].astype(float).mean() if len(won) else None
        top_pain = sub["main_pain_point"].mode().iloc[0] if not sub["main_pain_point"].mode().empty else None
        profile = sub[NUMERIC_FEATURES].astype(float).mean().sort_values(ascending=False)

        archetypes.append({
            "cluster": int(c),
            "n": int(len(sub)),
            "win_rate": round(float(win_rate), 3),
            "avg_margin": round(float(avg_margin), 4) if avg_margin is not None else None,
            "top_pain_point": top_pain,
            "feature_profile": [
                {"feature": feat, "value": round(float(val), 2)}
                for feat, val in profile.head(4).items()
            ],
        })
    return {"kmeans": kmeans, "labeled_df": labeled, "archetypes": archetypes}


def print_clusters(archetypes: list, k: int) -> None:
    print(f"\n=== {k} archetypes (KMeans on standardized features) ===")
    for a in archetypes:
        print(f"\nArchetype {a['cluster']} — n={a['n']}, win_rate={a['win_rate']:.0%}"
              + (f", avg_margin={a['avg_margin']*100:.1f}%" if a["avg_margin"] is not None else ""))
        print(f"  Most common pain point: {a['top_pain_point']}")
        print("  Feature profile (mean values): " + ", ".join(
            f"{fp['feature']}={fp['value']:.2f}" for fp in a["feature_profile"]
        ))


def build_insights(correlations: list, pca_summary: dict, archetypes: list) -> list:
    """Turns the raw analysis into short, actionable sentences a non-data-
    scientist reader (and RETRIEVAL_REQUIREMENTS.md) can use directly:
    which features actually drive outcome separation, so retrieval accuracy
    on those specific opportunity_features fields matters more than on the
    rest."""
    insights = []

    if correlations:
        top = correlations[0]
        insights.append(
            f"{top['a']} and {top['b']} move together most strongly (r={top['r']:+.2f}) "
            "— treat them as a pair when reading a new opportunity, not independent signals."
        )

    if pca_summary["components"]:
        pc1 = pca_summary["components"][0]
        drivers = ", ".join(l["feature"] for l in pc1["top_loadings"][:3])
        insights.append(
            f"The single axis explaining the most variance across historical tenders (PC1, "
            f"{pca_summary['explained_variance_ratio'][0]:.0%} of variance) is driven by: {drivers}. "
            "Retrieval accuracy on these fields matters more than on low-loading fields."
        )

    if archetypes:
        best = max(archetypes, key=lambda a: a["win_rate"])
        worst = min(archetypes, key=lambda a: a["win_rate"])
        if best["cluster"] != worst["cluster"]:
            best_drivers = ", ".join(f"{fp['feature']}={fp['value']:.2f}" for fp in best["feature_profile"][:2])
            worst_drivers = ", ".join(f"{fp['feature']}={fp['value']:.2f}" for fp in worst["feature_profile"][:2])
            insights.append(
                f"Archetype {best['cluster']} wins {best['win_rate']:.0%} of the time ({best_drivers}) vs. "
                f"archetype {worst['cluster']} at {worst['win_rate']:.0%} ({worst_drivers}) — "
                "an opportunity matching the losing profile is a candidate for a risk flag before proposal."
            )
        pain_points = {a["top_pain_point"] for a in archetypes if a["top_pain_point"]}
        if pain_points:
            insights.append(
                "Get client_highlights.pain_point right during retrieval — it's the top differentiator "
                f"across archetypes ({', '.join(sorted(pain_points))})."
            )

    if not insights:
        insights.append("Not enough historical data yet to draw a reliable pattern — re-run once more tenders are logged.")

    return insights


# ---------------------------------------------------------------------
# Model persistence — so the fitted (scaler, pca, kmeans) pipeline can be
# downloaded and reused instead of re-fit from scratch every time.
# ---------------------------------------------------------------------

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historical_archetypes_model.joblib")


def save_model(scaler, pca, kmeans, feature_columns: list, path: str = MODEL_PATH) -> str:
    joblib.dump(
        {"scaler": scaler, "pca": pca, "kmeans": kmeans, "feature_columns": feature_columns},
        path,
    )
    return path


# ---------------------------------------------------------------------
# RETRIEVAL_REQUIREMENTS.md wiring — auto-generated section listing which
# fields this analysis says are worth prioritizing during retrieval.
# ---------------------------------------------------------------------

REQUIREMENTS_DOC_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "RETRIEVAL_REQUIREMENTS.md",
)
SECTION_START = "<!-- BEGIN historical-archetypes-findings (auto-generated by skills/exploration/historical_archetypes.py --update-requirements-doc) -->"
SECTION_END = "<!-- END historical-archetypes-findings -->"


def build_requirements_doc_section(correlations: list, pca_summary: dict, archetypes: list, insights: list) -> str:
    lines = [SECTION_START, "", "## Step 4 — Historical analysis findings (auto-generated)", ""]
    lines.append(
        "Generated by `skills/exploration/historical_archetypes.py --update-requirements-doc` "
        "from `core.historical_tenders`. Re-run it to refresh this section as more tenders are logged."
    )
    lines.append("")
    lines.append("**Actionable insights:**")
    for insight in insights:
        lines.append(f"- {insight}")
    lines.append("")
    if pca_summary["components"]:
        pc1 = pca_summary["components"][0]
        lines.append(
            f"**Highest-priority fields for retrieval accuracy** (top PC1 loadings, "
            f"{pca_summary['explained_variance_ratio'][0]:.0%} of variance explained): "
            + ", ".join(f"`{l['feature']}`" for l in pc1["top_loadings"])
        )
        lines.append("")
    if correlations:
        lines.append("**Feature pairs that move together** (validate/derive one from the other during retrieval if only one is stated):")
        for p in correlations[:5]:
            lines.append(f"- `{p['a']}` <-> `{p['b']}` (r={p['r']:+.2f})")
        lines.append("")
    lines.append(SECTION_END)
    return "\n".join(lines)


def update_requirements_doc(section: str, path: str = REQUIREMENTS_DOC_PATH) -> None:
    """Idempotent: replaces the auto-generated section between the marker
    comments if present, otherwise appends it — so re-running this doesn't
    pile up duplicate sections on every invocation."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            existing = f.read()
    except OSError:
        existing = ""

    pattern = re.compile(re.escape(SECTION_START) + r".*?" + re.escape(SECTION_END), re.DOTALL)
    if pattern.search(existing):
        updated = pattern.sub(section, existing)
    else:
        updated = existing.rstrip("\n") + "\n\n" + section + "\n"

    with open(path, "w", encoding="utf-8") as f:
        f.write(updated)


def run_analysis(n_clusters: int) -> dict:
    """One call, all the structured data a caller (CLI prose mode, --json
    mode, or a future importer) needs — computed once so JSON output and
    prose output can never drift apart."""
    df = load_data()
    if df.empty:
        return {"error": "No rows in historical_tenders — nothing to analyze."}

    correlations = compute_correlations(df)
    pca_result = compute_pca(df)
    cluster_result = compute_clusters(df, pca_result["X_scaled"], n_clusters)
    insights = build_insights(correlations, pca_result["summary"], cluster_result["archetypes"])

    return {
        "df": df,
        "n_total": int(len(df)),
        "n_won": int((df["outcome"] == "won").sum()),
        "n_lost": int((df["outcome"] == "lost").sum()),
        "correlations": correlations,
        "pca_summary": pca_result["summary"],
        "scaler": pca_result["scaler"],
        "pca": pca_result["pca"],
        "components": pca_result["components"],
        "archetypes": cluster_result["archetypes"],
        "kmeans": cluster_result["kmeans"],
        "labeled_df": cluster_result["labeled_df"],
        "insights": insights,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clusters", type=int, default=4)
    parser.add_argument("--plot", action="store_true", help="save a PC1-vs-PC2 scatter PNG colored by outcome")
    parser.add_argument("--json", action="store_true", help="print the analysis as a single JSON object instead of prose")
    parser.add_argument("--save-model", action="store_true", help="pickle the fitted (scaler, pca, kmeans) pipeline")
    parser.add_argument("--update-requirements-doc", action="store_true",
                         help="(re)write the auto-generated findings section of RETRIEVAL_REQUIREMENTS.md")
    args = parser.parse_args()

    result = run_analysis(args.clusters)
    if "error" in result:
        if args.json:
            print(json.dumps(result))
        else:
            print(result["error"])
        return

    model_path = None
    if args.save_model:
        model_path = save_model(result["scaler"], result["pca"], result["kmeans"], ALL_FEATURES)

    if args.update_requirements_doc:
        section = build_requirements_doc_section(
            result["correlations"], result["pca_summary"], result["archetypes"], result["insights"]
        )
        update_requirements_doc(section)

    if args.plot:
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(8, 6))
        colors = result["labeled_df"]["outcome"].map({"won": "#067D62", "lost": "#B12704"})
        ax.scatter(result["components"][:, 0], result["components"][:, 1], c=colors, alpha=0.6)
        ax.set_xlabel("PC1")
        ax.set_ylabel("PC2")
        ax.set_title("Historical tenders — PC1 vs PC2, colored by outcome")
        out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historical_archetypes_pca.png")
        fig.savefig(out_path, dpi=150, bbox_inches="tight")
        if not args.json:
            print(f"\nSaved plot to {out_path}")

    if args.json:
        print(json.dumps({
            "n_total": result["n_total"],
            "n_won": result["n_won"],
            "n_lost": result["n_lost"],
            "correlations": result["correlations"],
            "pca_summary": result["pca_summary"],
            "archetypes": result["archetypes"],
            "insights": result["insights"],
            "model_path": model_path,
            "requirements_doc_updated": bool(args.update_requirements_doc),
        }))
        return

    print(f"Loaded {result['n_total']} historical tenders ({result['n_won']} won, {result['n_lost']} lost).")
    print_correlations(result["correlations"])
    print_pca(result["pca_summary"])
    print_clusters(result["archetypes"], args.clusters)
    for insight in result["insights"]:
        print(f"\n- {insight}")
    if model_path:
        print(f"\nSaved model to {model_path}")
    if args.update_requirements_doc:
        print(f"\nUpdated {REQUIREMENTS_DOC_PATH}")


if __name__ == "__main__":
    main()
