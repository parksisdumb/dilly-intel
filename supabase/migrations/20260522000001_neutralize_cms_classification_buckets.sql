-- Neutralize the CMS ownership-classification "bucket" entities.
--
-- The cms_provider_data ingest created one intel_entities row per CMS
-- hospital ownership-classification string ("Voluntary non-profit -
-- Private", "Government - State", "For profit - Corporation", …) and
-- dumped every facility carrying that classification into the row's
-- subsidiary_names array — 15 to 500 wholly unrelated hospitals each.
--
-- These are not real entities. They pollute portfolio entity-matching:
-- any hospital cluster whose owner name appears in one of these arrays
-- resolves to a nonsense label like "Voluntary non-profit - Private".
--
-- Fix: empty subsidiary_names on all 22 bucket rows so they stop
-- matching. The rows themselves are left in place (no deletes) — only
-- the subsidiary arrays are cleared. Hospital clusters then fall back
-- to their address / stem labels (still HEALTHCARE-badged).
--
-- The 22 names below were enumerated directly from the table on
-- 2026-05-22; they are exact, including the lowercase "district"
-- variant and "Government - City/county".

update intel_entities
set subsidiary_names = '{}'
where entity_type = 'healthcare_system'
  and name in (
    'For profit - Corporation',
    'For profit - Individual',
    'For profit - Limited Liability company',
    'For profit - Partnership',
    'Government - City',
    'Government - City/county',
    'Government - County',
    'Government - Federal',
    'Government - Hospital District or Authority',
    'Government - Hospital district',
    'Government - Local',
    'Government - State',
    'Non profit - Church related',
    'Non profit - Corporation',
    'Non profit - Other',
    'Other',
    'Proprietary',
    'State Owned',
    'Tribal',
    'Voluntary non-profit - Church',
    'Voluntary non-profit - Other',
    'Voluntary non-profit - Private'
  );
