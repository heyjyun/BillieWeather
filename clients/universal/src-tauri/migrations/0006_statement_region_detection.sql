-- Version 6: automatic region detection for a statement, kept apart from the person's choice.
-- Additive only: four nullable columns, every existing value is kept.
-- - region (version 5) stays the region in effect: what a person selected or accepted, or NULL.
-- - region_source says how it was decided: 'user' (selected), 'user_confirmed' (kept after a
--   conflict warning), 'suggestion' (accepted a High-confidence suggestion), or NULL (not specified).
-- - detected_region / region_confidence ('high' | 'medium' | 'low') / region_evidence (JSON of
--   rule labels such as a bank name, "IBAN DE" or "USD"; never text or numbers from the file) record
--   what the rule-based detector found (finance-core regionDetect.ts). Detection never sets region.
ALTER TABLE statements ADD COLUMN region_source TEXT;
ALTER TABLE statements ADD COLUMN detected_region TEXT;
ALTER TABLE statements ADD COLUMN region_confidence TEXT;
ALTER TABLE statements ADD COLUMN region_evidence TEXT;
-- Regions saved before this version were all chosen by a person.
UPDATE statements SET region_source = 'user' WHERE region IS NOT NULL;
