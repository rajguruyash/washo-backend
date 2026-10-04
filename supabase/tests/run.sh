#!/usr/bin/env bash
# Usage:
#   supabase/tests/run.sh baseline      # prove the vulnerabilities exist on the unmodified schema
#   supabase/tests/run.sh safe          # apply supabase/migrations/*  and run the "after" suites
#   supabase/tests/run.sh full          # also apply supabase/cutover/* (needs the mobile app update)
#   supabase/tests/run.sh dev           # local fake Supabase + website API on PORT (default 5001), to click through the site
#   supabase/tests/run.sh api           # full schema + the website API tests (fake Supabase Auth/functions/Storage)
set -euo pipefail
cd "$(dirname "$0")/../.."
MODE="${1:-safe}"
BASE="${BASELINE_DB:-washo_baseline}"
psql -tA -d postgres -c "select 1 from pg_database where datname='$BASE'" | grep -q 1 || ./supabase/tests/setup-baseline.sh

if [ "$MODE" = "baseline" ]; then
  SB_TEST_DB="$BASE" npx vitest run --config vitest.supabase.config.ts supabase/tests/baseline-exploits.test.ts
  exit $?
fi

DB="washo_mig_$MODE"
dropdb --if-exists "$DB"; createdb -T "$BASE" "$DB"
apply() { for f in "$@"; do [ -f "$f" ] || continue; echo "  applying $(basename "$f")"; psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done; }
# Supabase keeps pgcrypto in the `extensions` schema; admin_create_worker calls extensions.crypt/gen_salt. Locally it lives in public.
psql -q -d "$DB" -c "CREATE SCHEMA IF NOT EXISTS extensions; CREATE OR REPLACE FUNCTION extensions.crypt(text, text) RETURNS text LANGUAGE sql AS 'SELECT public.crypt(\$1, \$2)'; CREATE OR REPLACE FUNCTION extensions.gen_salt(text) RETURNS text LANGUAGE sql AS 'SELECT public.gen_salt(\$1)'; GRANT USAGE ON SCHEMA extensions TO authenticated, service_role, anon;"
apply supabase/migrations/*.sql
[ "$MODE" = "full" ] || [ "$MODE" = "api" ] || [ "$MODE" = "dev" ] && apply supabase/cutover/*.sql
if [ "$MODE" = "dev" ]; then
  # Local stand-in for Supabase (Auth + edge functions + Storage) over a real local database, for trying the website by hand.
  psql -q -d postgres -c "ALTER ROLE washo_api WITH LOGIN PASSWORD 'washo_api_test'"
  SB_TEST_DB="$DB" TS_NODE_PROJECT=backend/tsconfig.json node -r ts-node/register/transpile-only backend/tests/devStack.ts
  exit $?
fi
if [ "$MODE" = "api" ]; then
  # The website connects as washo_api. Locally it needs a login; in Supabase an operator sets this out of band.
  psql -q -d postgres -c "ALTER ROLE washo_api WITH LOGIN PASSWORD 'washo_api_test'"
  SB_TEST_DB="$DB" npx vitest run --config vitest.api.config.ts "${@:2}"
  exit $?
fi
# "safe" runs apply the cutover files themselves inside rolled-back transactions (after-07); "full" has already
# applied them for real, so it runs the full-schema suites instead.
if [ "$MODE" = "full" ]; then
  SB_TEST_DB="$DB" npx vitest run --config vitest.supabase.config.ts supabase/tests/full-*.test.ts "${@:2}"
else
  SB_TEST_DB="$DB" npx vitest run --config vitest.supabase.config.ts --exclude supabase/tests/baseline-exploits.test.ts --exclude 'supabase/tests/full-*.test.ts' "${@:2}"
fi
