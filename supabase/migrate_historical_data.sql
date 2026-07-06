-- Backfills core.historical_tenders from public.historical_opportunities.
-- Captured here for reproducibility — applied directly via the Supabase
-- MCP tool, same reasoning as schema_hardening.sql.
--
-- Why this was needed: core.historical_tenders (the table
-- pricing_recommendations.py and win_probability.py actually query) was
-- completely empty. Both skills were silently falling back to hardcoded
-- defaults (0.08/0.15/0.22 margin, 0.5 base rate) instead of erroring —
-- which looked like working output but wasn't grounded in anything real.
-- The real 360-row dataset existed the whole time, just in a different
-- table (public.historical_opportunities, from a teammate's separate RAG
-- feature — see supabase/rag_knowledge_base.sql) that was never
-- connected to these skills.
--
-- Verified after running: historical_margin_samples went from 0 -> 191
-- (the 'won' rows), win_probability base_rate went from the hardcoded
-- 0.5 -> the real 0.531 (191/360).

INSERT INTO core.historical_tenders (features, price, margin, outcome, customer_profile, closed_at)
SELECT
  jsonb_build_object(
    'daily_volume_total', daily_volume_total,
    'geo_fit_pct', geo_fit_pct,
    'daily_volume_serviceable', daily_volume_serviceable,
    'avg_weight_kg', avg_weight_kg,
    'oversized_pct', oversized_pct,
    'requires_intl', requires_intl,
    'intl_volume_share', intl_volume_share,
    'requires_pudo', requires_pudo,
    'requires_b2b', requires_b2b,
    'weekend_need', weekend_need,
    'main_pain_point', main_pain_point,
    'pain_severity', pain_severity,
    'price_vs_incumbent_pct', price_vs_incumbent_pct,
    'competitive_intensity', competitive_intensity,
    'sales_cycle_touches', sales_cycle_touches,
    'decision_time_days', decision_time_days,
    'contract_length_months', contract_length_months,
    'lost_reason', lost_reason,
    'source_opportunity_id', opportunity_id
  ) AS features,
  annual_revenue_potential_eur AS price,
  CASE WHEN final_margin_pct IS NOT NULL THEN final_margin_pct / 100.0 ELSE NULL END AS margin,
  lower(outcome) AS outcome,
  jsonb_build_object(
    'company_name', company_name,
    'industry', industry,
    'year', year,
    'source', source,
    'incumbent_carrier', incumbent_carrier
  ) AS customer_profile,
  make_date(year, 12, 31)::timestamptz AS closed_at
FROM public.historical_opportunities;
