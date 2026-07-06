-- =====================================================================
-- Standalone seed for constraints.constraint_categories, 
-- constraints.constraint_catalog, and constraints.amazon_capability_profile.
-- Run this if these tables exist but are empty (confirmed via the
-- nl_query test: amazon_capability_profile returned 0 rows).
--
-- Safe to check first with:
--   SELECT count(*) FROM constraints.amazon_capability_profile;
-- If that's already > 0, do NOT run this — it will create duplicate
-- category/catalog rows since there's no ON CONFLICT guard here
-- (constraint_categories.name is UNIQUE, so categories will fail loudly
-- and safely if run twice; constraint_catalog has no unique constraint
-- on name, so re-running would silently duplicate catalog entries).
-- =====================================================================

-- SEED DATA — constraints schema: categories, catalog, capability profile
-- =====================================================================

INSERT INTO constraints.constraint_categories (name, description) VALUES
    ('Geography',       'Where the service must operate — countries, regions, specific lanes'),
    ('Volume / Size',   'Package size, weight, and volume thresholds'),
    ('SLA',             'Delivery time commitments and service level requirements'),
    ('Insurance',       'Liability and insurance coverage requirements'),
    ('Customs',         'Cross-border documentation and customs handling requirements'),
    ('Data / Security', 'Data residency, security certification, and privacy requirements'),
    ('Financial',       'Payment terms, currency, penalty clauses'),
    ('Legal',           'Contractual terms, exclusivity clauses, termination conditions'),
    ('Delivery model',  'Home delivery vs PUDO vs B2B/palletized vs returns'),
    ('Product type',    'Prohibited or restricted goods categories');

-- Geography ---------------------------------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Geography'),
  'Delivery region', 'enumerated_list', NULL,
  'Geographic regions the customer requires delivery coverage for');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do_with_conditions',
  '{"covered_regions": ["Spanish Peninsula", "Balearic Islands"], "not_covered": ["Portugal", "Canary Islands", "Ceuta", "Melilla"], "balearic_cost_multiplier": 1.35}'::jsonb,
  'Balearic Islands served but at a 1.35x cost multiplier on all mile costs. Portugal, Canary Islands, Ceuta, Melilla are not currently served at all — any requirement touching these is a hard capability gap, not a pricing question.',
  'Operations'
FROM constraints.constraint_catalog WHERE name = 'Delivery region';

-- Delivery model ------------------------------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Delivery model'),
  'Delivery method', 'enumerated_list', NULL,
  'Home delivery vs PUDO (pick-up/drop-off) vs B2B palletized delivery vs return service');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do_with_conditions',
  '{"supported": ["home_delivery"], "not_supported": ["PUDO", "international_shipping", "B2B_palletized", "client_returns"]}'::jsonb,
  'PUDO, international shipping and B2B/palletized delivery are listed as future development, not currently available. Client return services are not offered at all today.',
  'Operations'
FROM constraints.constraint_catalog WHERE name = 'Delivery method';

-- Volume / Size ---------------------------------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Volume / Size'),
  'Maximum package weight', 'numeric_range', 'kg', 'Heaviest single package the network can carry'),
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Volume / Size'),
  'Maximum package dimensions', 'numeric_range', 'cm', 'Largest single package dimensions (L x W x H)');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do_with_conditions', '{"max_weight_kg": 15}'::jsonb,
  'Any tender requiring shipment of packages above 15kg falls outside current capability for standard service.', 'Operations'
FROM constraints.constraint_catalog WHERE name = 'Maximum package weight';

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do_with_conditions', '{"max_dimensions_cm": {"l": 80, "w": 80, "h": 60}}'::jsonb,
  'Packages exceeding 80x80x60cm are out of scope for standard service.', 'Operations'
FROM constraints.constraint_catalog WHERE name = 'Maximum package dimensions';

-- Product type ------------------------------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Product type'),
  'Prohibited goods category', 'enumerated_list', NULL, 'Product categories that cannot be shipped under any circumstances');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'cannot_do',
  '{"forbidden": ["Dangerous Goods Category 2 (e.g. explosives, dynamite)"]}'::jsonb,
  NULL, 'Operations / Compliance'
FROM constraints.constraint_catalog WHERE name = 'Prohibited goods category';

-- SLA ---------------------------------------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='SLA'),
  'Delivery speed', 'numeric_range', 'hours', 'Committed delivery time window from injection to delivery'),
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='SLA'),
  'Delivery attempts', 'numeric_range', 'attempts', 'Number of delivery attempts before a parcel is returned/escalated'),
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='SLA'),
  'Weekend delivery', 'boolean', NULL, 'Whether delivery is available on Saturday/Sunday');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do', '{"delivery_window_hours_min": 24, "delivery_window_hours_max": 48}'::jsonb, NULL, 'Operations'
FROM constraints.constraint_catalog WHERE name = 'Delivery speed';

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do', '{"max_attempts": 5}'::jsonb, NULL, 'Operations'
FROM constraints.constraint_catalog WHERE name = 'Delivery attempts';

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do', '{"weekend_delivery": true, "included_at_no_extra_cost": true}'::jsonb, NULL, 'Operations'
FROM constraints.constraint_catalog WHERE name = 'Weekend delivery';

-- Financial (premium delivery add-ons) -------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Financial'),
  'Premium delivery feature', 'enumerated_list', NULL, 'OTP / SOD / POUD security and proof-of-delivery add-ons');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do_with_conditions',
  '{"POUD": {"cost_eur": 0, "included": true}, "SOD": {"cost_eur": 0.10}, "OTP": {"cost_eur": 0.35}}'::jsonb,
  'POUD (photo on unattended delivery) is included at no cost. SOD and OTP carry per-package surcharges.', 'Pricing'
FROM constraints.constraint_catalog WHERE name = 'Premium delivery feature';

-- Insurance / claims --------------------------------------------------
INSERT INTO constraints.constraint_catalog (constraint_type_id, category_id, name, data_type, unit, description)
VALUES
 (gen_random_uuid(), (SELECT category_id FROM constraints.constraint_categories WHERE name='Insurance'),
  'Loss and damage rate', 'numeric_range', 'percent', 'Historical loss/damage rate used to assess risk exposure for high-value or fragile shipments');

INSERT INTO constraints.amazon_capability_profile (constraint_type_id, capability_status, structured_value, conditions_text, owner_team)
SELECT constraint_type_id, 'can_do', '{"loss_rate_pct": 0.07, "damage_rate_pct": 0.15}'::jsonb,
  'Claims processed via Shipper Central under the Spanish Land Transport Act (LOTT); funds credited ~7 calendar days after approval.', 'Operations'
FROM constraints.constraint_catalog WHERE name = 'Loss and damage rate';

