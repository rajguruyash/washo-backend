/**
 * Copies the legacy marketing-site leads (Render PostgreSQL `leads` table) into Supabase `public.website_leads`.
 *
 *   - READ-ONLY on the legacy database (runs inside a READ ONLY transaction). The Render database is never modified.
 *   - Idempotent: keyed on the legacy id, so running it twice, or after more leads arrive, never duplicates.
 *   - DRY RUN by default. Nothing is written unless you pass --apply.
 *
 *   LEGACY_DATABASE_URL=postgresql://...render...   TARGET_DATABASE_URL=postgresql://...supabase...
 *   node -r ts-node/register/transpile-only supabase/scripts/import-leads.ts            # dry run: counts only
 *   node -r ts-node/register/transpile-only supabase/scripts/import-leads.ts --apply    # really import
 *
 * Payment screenshots from the old flow are NOT copied (they contain customers' payment details). The path is kept
 * in legacy_payment_image_url so an admin can still find the file on the old server.
 */
import { Client } from 'pg';

export interface ImportOptions {
  legacyUrl: string;
  targetUrl: string;
  apply: boolean;
}
export interface ImportResult {
  legacyRows: number;
  alreadyImported: number;
  toImport: number;
  imported: number;
}

const ssl = (url: string) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

export async function importLeads(o: ImportOptions): Promise<ImportResult> {
  const legacy = new Client({ connectionString: o.legacyUrl, ssl: ssl(o.legacyUrl) });
  const target = new Client({ connectionString: o.targetUrl, ssl: ssl(o.targetUrl) });
  await legacy.connect();
  await target.connect();
  try {
    await legacy.query('BEGIN READ ONLY');
    const rows = (await legacy.query('SELECT * FROM leads ORDER BY id')).rows as Record<string, any>[];
    await legacy.query('ROLLBACK');

    const existing = new Set<number>(
      (await target.query('SELECT legacy_id FROM public.website_leads WHERE legacy_id IS NOT NULL')).rows.map((r) => r.legacy_id)
    );
    const fresh = rows.filter((r) => !existing.has(r.id));
    const result: ImportResult = { legacyRows: rows.length, alreadyImported: rows.length - fresh.length, toImport: fresh.length, imported: 0 };
    if (!o.apply || fresh.length === 0) return result;

    await target.query('BEGIN');
    try {
      for (const r of fresh) {
        const res = await target.query(
          `INSERT INTO public.website_leads
             (legacy_id, name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number,
              preferred_service, status, source, legacy_payment_image_url, legacy_created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (legacy_id) DO NOTHING`,
          [r.id, r.name, r.email ?? null, r.mobile, r.vehicle_type ?? null, r.vehicle_model ?? null, r.vehicle_registration_number ?? null,
           r.location ?? null, r.flat_number ?? null, r.preferred_service ?? null, r.status ?? null, r.source ?? null,
           r.payment_image_url ?? null,
           // the legacy column is "timestamp without time zone" written by a server running in UTC
           r.created_at ? new Date(new Date(r.created_at).getTime()).toISOString() : null]
        );
        result.imported += res.rowCount ?? 0;
      }
      await target.query('COMMIT');
    } catch (err) {
      await target.query('ROLLBACK');
      throw err;
    }
    return result;
  } finally {
    await legacy.end();
    await target.end();
  }
}

if (require.main === module) {
  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!legacyUrl || !targetUrl) {
    console.error('Set LEGACY_DATABASE_URL and TARGET_DATABASE_URL.');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  importLeads({ legacyUrl, targetUrl, apply })
    .then((r) => {
      console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: legacy rows ${r.legacyRows}, already imported ${r.alreadyImported}, ${apply ? `imported ${r.imported}` : `would import ${r.toImport}`}`);
      if (!apply) console.log('Nothing was written. Re-run with --apply to import.');
    })
    .catch((e) => {
      console.error('Import failed:', e.message);
      process.exit(1);
    });
}
