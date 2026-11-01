#!/usr/bin/env node
/**
 * 📦 Local Database Backup Importer / Restorer
 * Directly restores a dashboard-backup-[brand].json into data/dashboard.sqlite
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = process.cwd();
const dbPath = process.env.DATABASE_FILE || path.join(projectRoot, "data", "dashboard.sqlite");

async function main() {
  const backupFilePath = process.argv[2] || path.join(process.env.HOME || "", "Downloads", "dashboard-backup-donyagardi.json");

  console.log("\n=======================================================");
  console.log(" 📦 بازیابی مستقیم نسخه پشتیبان داده‌ها به پایگاه داده");
  console.log(` 📂 فایل پشتیبان: ${backupFilePath}`);
  console.log(` 🗄️ فایل پایگاه‌داده: ${dbPath}`);
  console.log("=======================================================\n");

  if (!fs.existsSync(backupFilePath)) {
    console.error(`❌ خطا: فایل پشتیبان در مسیر ${backupFilePath} پیدا نشد!`);
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`❌ خطا: فایل پایگاه داده در مسیر ${dbPath} پیدا نشد! ابتدا 'npm run setup -- --non-interactive' را اجرا کنید.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(backupFilePath, "utf-8");
  const backup = JSON.parse(raw);

  if (backup.format !== "marketing-dashboard-backup") {
    console.error("❌ خطا: فرمت فایل پشتیبان نامعتبر است.");
    process.exit(1);
  }

  const brandId = backup.brand?.id || "donyagardi";
  const brandName = backup.brand?.name || "دفتر دنیاگردی";
  const shortName = backup.brand?.shortName || "دنیاگردی";
  const data = backup.data || {};

  const budgets = data.budgets || [];
  const contractorFees = data.contractorFees || [];
  const channelDailyCosts = data.channelDailyCosts || [];
  const channelMonthlyCosts = data.channelMonthlyCosts || [];
  const smsPrices = data.smsPrices || [];
  const rates = data.rates || [];
  const contracts = data.contracts || [];
  const contractRecords = data.contractRecords || [];
  const rules = backup.rules?.rules || {};

  console.log(`🏢 برند هدف: ${brandName} (${brandId})`);
  console.log(`📊 خلاصه محتوای فایل پشتیبان:`);
  console.log(`  - ردیف‌های بودجه روزانه: ${budgets.length}`);
  console.log(`  - دستمزد پیمانکاران: ${contractorFees.length}`);
  console.log(`  - هزینه‌های روزانه کانال‌ها: ${channelDailyCosts.length}`);
  console.log(`  - هزینه‌های ماهانه کانال‌ها: ${channelMonthlyCosts.length}`);
  console.log(`  - قیمت‌های پیامک: ${smsPrices.length}`);
  console.log(`  - نرخ‌های ارز: ${rates.length}`);
  console.log(`  - قراردادها: ${contracts.length}`);

  const sqlite = new DatabaseSync(dbPath);

  // Ensure brand exists and is active
  sqlite.prepare(`
    INSERT INTO dashboard_brands (id, name, short_name, sheet_status, config_status, is_default, updated_at)
    VALUES (?, ?, ?, 'connected', 'active', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      short_name = excluded.short_name,
      config_status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `).run(brandId, brandName, shortName, brandId === "donyagardi" ? 1 : 0);

  // Clear existing brand-specific rows
  sqlite.exec(`DELETE FROM brand_weekly_ad_budgets WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_monthly_channel_contractor_fees WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_channel_daily_costs WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_channel_monthly_costs WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_monthly_sms_prices WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_monthly_currency_rates WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_monthly_expert_contracts WHERE brand_id = '${brandId}';`);
  sqlite.exec(`DELETE FROM brand_expert_contract_records WHERE brand_id = '${brandId}';`);

  // Insert budgets
  const insertBudget = sqlite.prepare("INSERT INTO brand_weekly_ad_budgets (brand_id, date, week_start, weekday, sms_toman, instagram_toman) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of budgets) {
    insertBudget.run(brandId, row.date, row.weekStart, row.weekday, row.smsToman ?? null, row.instagramToman ?? null);
  }

  // Insert contractor fees
  const insertFee = sqlite.prepare("INSERT INTO brand_monthly_channel_contractor_fees (brand_id, month, instagram_toman, google_ads_toman) VALUES (?, ?, ?, ?)");
  for (const row of contractorFees) {
    insertFee.run(brandId, row.month, row.instagramToman ?? null, row.googleAdsToman ?? null);
  }

  // Insert channel daily costs
  const insertDailyCost = sqlite.prepare("INSERT INTO brand_channel_daily_costs (brand_id, date, channel_id, amount_toman) VALUES (?, ?, ?, ?)");
  for (const row of channelDailyCosts) {
    insertDailyCost.run(brandId, row.date, row.channelId, row.amountToman);
  }

  // Insert channel monthly costs
  const insertMonthlyCost = sqlite.prepare("INSERT INTO brand_channel_monthly_costs (brand_id, month, channel_id, media_toman, contractor_toman) VALUES (?, ?, ?, ?, ?)");
  for (const row of channelMonthlyCosts) {
    insertMonthlyCost.run(brandId, row.month, row.channelId, row.mediaToman ?? null, row.contractorToman ?? null);
  }

  // Insert SMS prices
  const insertSms = sqlite.prepare("INSERT INTO brand_monthly_sms_prices (brand_id, month, price_toman) VALUES (?, ?, ?)");
  for (const row of smsPrices) {
    insertSms.run(brandId, row.month, row.priceToman);
  }

  // Insert currency rates
  const insertRate = sqlite.prepare("INSERT INTO brand_monthly_currency_rates (brand_id, month, try_to_toman) VALUES (?, ?, ?)");
  for (const row of rates) {
    insertRate.run(brandId, row.month, row.tryToToman);
  }

  // Insert rules if present
  if (Object.keys(rules).length > 0) {
    const configJson = JSON.stringify(rules);
    const version = (backup.rules?.version || 1) + 1;
    sqlite.exec(`
      INSERT INTO brand_dashboard_rules (brand_id, config_json, version, updated_at)
      VALUES ('${brandId}', '${configJson.replace(/'/g, "''")}', ${version}, CURRENT_TIMESTAMP)
      ON CONFLICT(brand_id) DO UPDATE SET config_json = excluded.config_json, version = excluded.version, updated_at = CURRENT_TIMESTAMP;
    `);
  }

  console.log("\n🎉 بازیابی با موفقیت کامل انجام شد!");
  console.log(`✅ تمام ${budgets.length} ردیف بودجه به پایگاه داده تزریق شدند.\n`);
}

main().catch(err => {
  console.error("❌ خطا در بازیابی:", err);
  process.exit(1);
});
