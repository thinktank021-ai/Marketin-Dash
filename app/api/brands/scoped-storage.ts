import { getD1 } from "../../../db";
import { DEFAULT_BRAND_ID } from "./storage";
import { oncePerDatabase } from "./storage-initialization";

/**
 * Creates brand-scoped financial and contract stores and copies the original
 * Donyagardi data once. New brands therefore start empty and can never read or
 * overwrite another brand's manual inputs.
 */
async function initializeScopedStorage() {
  const d1 = getD1();
  // Tables and indexes are owned by the applied Drizzle migrations.

  // Once the scoped rules for the default office exist, the one-time legacy import
  // has already completed. Skipping the repeated full-table copies is important on
  // Cloudflare isolates: otherwise every cold isolate can hold report requests
  // while copying historical rows, leaving the range report on its spinner.
  try {
    const seeded = await d1.prepare("SELECT 1 AS ready FROM brand_dashboard_rules WHERE brand_id = ? LIMIT 1").bind(DEFAULT_BRAND_ID).first<{ ready: number }>();
    if (seeded) return d1;
  } catch { /* A pre-migration database still needs the legacy import below. */ }

  // Legacy tables exist on the current production database. Fresh databases
  // safely skip these one-time imports until no legacy data is present.
  const migrations = [
    `INSERT OR IGNORE INTO brand_weekly_ad_budgets (brand_id,date,week_start,weekday,sms_toman,instagram_toman,google_ads_toman,updated_at)
      SELECT '${DEFAULT_BRAND_ID}',date,week_start,weekday,sms_toman,instagram_toman,google_ads_toman,updated_at FROM weekly_ad_budgets`,
    `INSERT OR IGNORE INTO brand_monthly_channel_contractor_fees (brand_id,month,instagram_toman,google_ads_toman,updated_at)
      SELECT '${DEFAULT_BRAND_ID}',month,instagram_toman,google_ads_toman,updated_at FROM monthly_channel_contractor_fees`,
    `INSERT OR IGNORE INTO brand_monthly_currency_rates (brand_id,month,try_to_toman,updated_at)
      SELECT '${DEFAULT_BRAND_ID}',month,try_to_toman,updated_at FROM monthly_currency_rates`,
    `INSERT OR IGNORE INTO brand_monthly_expert_contracts (brand_id,month,expert,contract_count,updated_at)
      SELECT '${DEFAULT_BRAND_ID}',month,expert,contract_count,updated_at FROM monthly_expert_contracts`,
    `INSERT OR IGNORE INTO brand_expert_contract_records (brand_id,month,expert,lead_ref,sheet_row,first_contact_date,source_channel,raw_source_channel,route,created_at)
      SELECT '${DEFAULT_BRAND_ID}',month,expert,lead_ref,sheet_row,first_contact_date,source_channel,raw_source_channel,route,created_at FROM expert_contract_records`,
  ];
  for (const sql of migrations) {
    try { await d1.prepare(sql).run(); } catch { /* A fresh database has no legacy table to import. */ }
  }
  return d1;
}
export function ensureScopedStorage() { return oncePerDatabase(getD1(), "scoped", initializeScopedStorage); }
