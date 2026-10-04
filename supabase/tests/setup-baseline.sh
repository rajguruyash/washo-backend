#!/usr/bin/env bash
# Builds a local, throwaway replica of the PRODUCTION schema from washo_schema.sql.
# It never connects to Supabase. It emulates Supabase's default grants (which pg_dump omits),
# so "can role X call function Y?" tests mean what they would on the real project.
set -euo pipefail
DUMP="${WASHO_SCHEMA_DUMP:-/Users/apple/Documents/washoapp/washo_schema.sql}"
DB="${BASELINE_DB:-washo_baseline}"

dropdb --if-exists "$DB"
createdb "$DB"
psql -q -d "$DB" <<'SQL'
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','supabase_admin','authenticator',
    'supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin','dashboard_user',
    'pgbouncer','supabase_replication_admin','supabase_read_only_user','postgres'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
# supabase_vault is unavailable locally; everything else restores cleanly.
psql -d "$DB" -v ON_ERROR_STOP=0 -q -f "$DUMP" >/tmp/washo_baseline_restore.log 2>&1 || true
bad=$(grep -c "ERROR" /tmp/washo_baseline_restore.log || true)
echo "restore errors: $bad (expected 2: supabase_vault)"

# Supabase gives anon/authenticated/service_role everything in public by default, and PUBLIC may
# execute any function. Re-create that so the baseline behaves like production.
psql -q -d "$DB" <<'SQL'
GRANT USAGE ON SCHEMA public, storage, auth TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, storage TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
SQL
# The dump is schema-only. Seed what production is known to contain (the mobile app's seed migration),
# plus two deliberate oddities so the pricing migration's versioning and deactivation paths are exercised:
#   * car-body-wash starts at the WRONG price (14000) -> must get a new rule_version at 15000
#   * a stray 3-month pricing rule exists -> must be deactivated, not deleted
psql -q -d "$DB" <<'SQL'
INSERT INTO public.services (code, name, vehicle_type, description, is_active) VALUES
  ('bike-body-wash','Bike Body Wash','bike','Standard bike body wash service.',true),
  ('car-body-wash','Car Body Wash','car','Standard car body wash service.',true),
  ('car-deep-cleaning','Car Deep Cleaning','car','Deep cleaning for cars.',true),
  ('suv-deep-cleaning','SUV Deep Cleaning','suv','Deep cleaning for SUVs.',true);
INSERT INTO public.pricing_rules (service_id, vehicle_type, duration_months, quantity_tier, base_amount_cents, active)
SELECT id, vehicle_type, 1, 1, CASE code WHEN 'bike-body-wash' THEN 6500 WHEN 'car-body-wash' THEN 14000
       WHEN 'car-deep-cleaning' THEN 22000 WHEN 'suv-deep-cleaning' THEN 25000 END, true FROM public.services;
INSERT INTO public.pricing_rules (service_id, vehicle_type, duration_months, quantity_tier, base_amount_cents, active)
SELECT id, vehicle_type, 3, 1, 40000, true FROM public.services WHERE code='car-body-wash';
SQL
psql -tA -d "$DB" -c "select count(*)||' public tables, '||(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')||' public functions' from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
