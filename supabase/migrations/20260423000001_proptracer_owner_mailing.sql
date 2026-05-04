-- PropTracer v2 rebuild — owner mailing address + ownership flags
-- city/state/postal_code already exist on intel_properties.
-- street_address is the street line only; city/state/postal_code are separate.

alter table intel_properties
  add column if not exists owner_mailing_address text,
  add column if not exists owner_mailing_city text,
  add column if not exists owner_mailing_state text,
  add column if not exists owner_mailing_zip text,
  add column if not exists corporate_owned boolean,
  add column if not exists absentee_owner boolean;
