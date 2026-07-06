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
"""

import os
import sys
import argparse

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
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


def print_correlations(df: pd.DataFrame) -> None:
    corr = df[ALL_FEATURES].astype(float).corr()
    print("\n=== Feature correlations (|r| >= 0.3) — which features move together ===")
    seen = set()
    pairs = []
    for a in corr.columns:
        for b in corr.columns:
            if a == b or (b, a) in seen:
                continue
            seen.add((a, b))
            r = corr.loc[a, b]
            if abs(r) >= 0.3:
                pairs.append((a, b, r))
    pairs.sort(key=lambda p: -abs(p[2]))
    for a, b, r in pairs:
        print(f"  {a:28s} <-> {b:28s}  r = {r:+.2f}")
    if not pairs:
        print("  (no pairs at this threshold — features are largely independent)")


def run_pca(df: pd.DataFrame, n_components: int = 3) -> tuple:
    X = df[ALL_FEATURES].astype(float).fillna(df[ALL_FEATURES].astype(float).median())
    X_scaled = StandardScaler().fit_transform(X)

    pca = PCA(n_components=n_components)
    components = pca.fit_transform(X_scaled)

    print(f"\n=== PCA — {n_components} components ===")
    print(f"Explained variance ratio: {[round(v, 3) for v in pca.explained_variance_ratio_]}")
    print(f"Cumulative: {round(sum(pca.explained_variance_ratio_), 3)}")

    for i in range(n_components):
        loadings = pd.Series(pca.components_[i], index=ALL_FEATURES).sort_values(key=abs, ascending=False)
        print(f"\nPC{i+1} top loadings (features that move together on this axis):")
        for feat, load in loadings.head(5).items():
            print(f"  {feat:28s} {load:+.3f}")

    return components, X_scaled


def run_clustering(df: pd.DataFrame, X_scaled: np.ndarray, k: int) -> pd.DataFrame:
    kmeans = KMeans(n_clusters=k, n_init=10, random_state=42)
    df = df.copy()
    df["cluster"] = kmeans.fit_predict(X_scaled)

    print(f"\n=== {k} archetypes (KMeans on standardized features) ===")
    for c in sorted(df["cluster"].unique()):
        sub = df[df["cluster"] == c]
        won = sub[sub["outcome"] == "won"]
        win_rate = len(won) / len(sub) if len(sub) else 0
        avg_margin = won["margin"].astype(float).mean() if len(won) else None
        top_pain = sub["main_pain_point"].mode().iloc[0] if not sub["main_pain_point"].mode().empty else None
        profile = sub[NUMERIC_FEATURES].astype(float).mean().sort_values(ascending=False)

        print(f"\nArchetype {c} — n={len(sub)}, win_rate={win_rate:.0%}"
              + (f", avg_margin={avg_margin*100:.1f}%" if avg_margin is not None else ""))
        print(f"  Most common pain point: {top_pain}")
        print("  Feature profile (mean values): " + ", ".join(
            f"{feat}={val:.2f}" for feat, val in profile.head(4).items()
        ))
    return df


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clusters", type=int, default=4)
    parser.add_argument("--plot", action="store_true", help="save a PC1-vs-PC2 scatter PNG colored by outcome")
    args = parser.parse_args()

    df = load_data()
    if df.empty:
        print("No rows in historical_tenders — nothing to analyze.")
        return
    print(f"Loaded {len(df)} historical tenders ({(df['outcome'] == 'won').sum()} won, {(df['outcome'] == 'lost').sum()} lost).")

    print_correlations(df)
    components, X_scaled = run_pca(df)
    clustered = run_clustering(df, X_scaled, args.clusters)

    if args.plot:
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(8, 6))
        colors = clustered["outcome"].map({"won": "#067D62", "lost": "#B12704"})
        ax.scatter(components[:, 0], components[:, 1], c=colors, alpha=0.6)
        ax.set_xlabel("PC1")
        ax.set_ylabel("PC2")
        ax.set_title("Historical tenders — PC1 vs PC2, colored by outcome")
        out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historical_archetypes_pca.png")
        fig.savefig(out_path, dpi=150, bbox_inches="tight")
        print(f"\nSaved plot to {out_path}")


if __name__ == "__main__":
    main()
