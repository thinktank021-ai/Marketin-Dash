#!/usr/bin/env node
/**
 * 🛡️ Automated Database & Multi-Brand Backup CLI
 * Creates safe, point-in-time physical and logical backups.
 * 
 * Usage:
 *   node scripts/backup-db.mjs
 *   npm run db:backup
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = process.cwd();
const dbPath = process.env.DATABASE_FILE || path.join(projectRoot, "data", "dashboard.sqlite");
const backupsDir = path.join(projectRoot, "data", "backups");

if (!fs.existsSync(dbPath)) {
  console.error(`❌ خطا: فایل پایگاه داده در مسیر ${dbPath} پیدا نشد!`);
  process.exit(1);
}

if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

// 1. Format timestamp for backup filename
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;

console.log("\n=======================================================");
console.log(" 🛡️ پشتیبان‌گیری هوشمند و کامل از پایگاه داده داشبورد");
console.log(` ⏱️ زمان: ${now.toISOString()}`);
console.log(` 📂 پوشه ذخیره بکاپ: ${backupsDir}`);
console.log("=======================================================\n");

const sqlite = new DatabaseSync(dbPath);

// 2. Safe WAL checkpoint (flush memory and WAL log to disk)
try {
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  console.log("  ✓ نقاط بازبینی WAL با موفقیت روی دیسک تخلیه و ثبت شدند.");
} catch (e) {
  console.warn("  ! هشدار تخلیه WAL:", e.message);
}

// 3. Create physical SQLite snapshot
const snapshotFileName = `dashboard-snapshot-${timestamp}.sqlite`;
const snapshotFilePath = path.join(backupsDir, snapshotFileName);
fs.copyFileSync(dbPath, snapshotFilePath);
const stats = fs.statSync(snapshotFilePath);
console.log(`  ✓ کپی فیزیکی پایگاه داده ساخته شد: ${snapshotFileName} (${(stats.size / 1024).toFixed(1)} KB)`);

// 4. Export logical JSON backups for every active brand
try {
  const brands = sqlite.prepare("SELECT id, name, short_name FROM dashboard_brands WHERE config_status = 'active'").all();
  for (const b of brands) {
    const brandId = b.id;
    const [budgets, contractorFees, channelDailyCosts, channelMonthlyCosts, smsPrices, rates, contracts, records] = [
      sqlite.prepare("SELECT date, week_start AS weekStart, weekday, sms_toman AS smsToman, instagram_toman AS instagramToman FROM brand_weekly_ad_budgets WHERE brand_id = ? ORDER BY date").all(brandId),
      sqlite.prepare("SELECT month, instagram_toman AS instagramToman, google_ads_toman AS googleAdsToman FROM brand_monthly_channel_contractor_fees WHERE brand_id = ? ORDER BY month").all(brandId),
      sqlite.prepare("SELECT date, channel_id AS channelId, amount_toman AS amountToman FROM brand_channel_daily_costs WHERE brand_id = ? ORDER BY date, channel_id").all(brandId),
      sqlite.prepare("SELECT month, channel_id AS channelId, media_toman AS mediaToman, contractor_toman AS contractorToman FROM brand_channel_monthly_costs WHERE brand_id = ? ORDER BY month, channel_id").all(brandId),
      sqlite.prepare("SELECT month, price_toman AS priceToman FROM brand_monthly_sms_prices WHERE brand_id = ? ORDER BY month").all(brandId),
      sqlite.prepare("SELECT month, try_to_toman AS tryToToman FROM brand_monthly_currency_rates WHERE brand_id = ? ORDER BY month").all(brandId),
      sqlite.prepare("SELECT month, expert, contract_count AS contractCount FROM brand_monthly_expert_contracts WHERE brand_id = ? ORDER BY month, expert").all(brandId),
      sqlite.prepare("SELECT month, expert, lead_ref AS leadRef, sheet_row AS sheetRow, first_contact_date AS firstContactDate, source_channel AS sourceChannel, raw_source_channel AS rawSourceChannel, route FROM brand_expert_contract_records WHERE brand_id = ? ORDER BY id").all(brandId),
    ];

    const ruleRow = sqlite.prepare("SELECT config_json, version FROM brand_dashboard_rules WHERE brand_id = ?").get(brandId);
    let rules = {};
    if (ruleRow && ruleRow.config_json) {
      try { rules = JSON.parse(ruleRow.config_json); } catch {}
    }

    const jsonBackup = {
      format: "marketing-dashboard-backup",
      schemaVersion: 3,
      exportedAt: now.toISOString(),
      brand: { id: brandId, name: b.name, shortName: b.short_name },
      rules: { rules, version: ruleRow?.version || 1 },
      summary: {
        budgets: budgets.length,
        contractorFees: contractorFees.length,
        channelDailyCosts: channelDailyCosts.length,
        channelMonthlyCosts: channelMonthlyCosts.length,
        smsPrices: smsPrices.length,
        rates: rates.length,
        contracts: contracts.length,
      },
      data: {
        budgets,
        contractorFees,
        channelDailyCosts,
        channelMonthlyCosts,
        smsPrices,
        rates,
        contracts,
        contractRecords: records,
      },
    };

    const jsonFileName = `dashboard-backup-${brandId}-${timestamp}.json`;
    const jsonFilePath = path.join(backupsDir, jsonFileName);
    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonBackup, null, 2));
    console.log(`  ✓ خروجی مجزای JSON برای «${b.name}»: ${jsonFileName}`);

    // Update canonical tracked JSON backup in data/ for Git version control
    const canonicalName = brandId === "donyagardi"
      ? "dashboard-backup-donyagardi.json"
      : (brandId === "brand-3f7216ab" || (b.name && b.name.includes("نوآوران")))
        ? "dashboard-backup-novavaran.json"
        : `dashboard-backup-${brandId}.json`;
    const canonicalPath = path.join(projectRoot, "data", canonicalName);
    fs.writeFileSync(canonicalPath, JSON.stringify(jsonBackup, null, 2));
    console.log(`  ✓ همگام‌سازی فایل نسخه گیت: ${canonicalName}`);
  }
} catch (e) {
  console.warn("  ! هشدار تولید بکاپ JSON:", e.message);
}

// 5. Automatic cleanup: keep newest 30 backups, delete older ones
try {
  const allFiles = fs.readdirSync(backupsDir).map(f => ({
    name: f,
    path: path.join(backupsDir, f),
    time: fs.statSync(path.join(backupsDir, f)).mtimeMs,
  })).sort((a, b) => b.time - a.time);

  if (allFiles.length > 50) {
    const toDelete = allFiles.slice(50);
    for (const f of toDelete) {
      fs.unlinkSync(f.path);
    }
    console.log(`  ✓ تعداد ${toDelete.length} فایل بکاپ قدیمی جهت صرفه‌جویی در فضا پاکسازی شد.`);
  }
} catch {}

console.log("\n=======================================================");
console.log(" 🎉 پشتیبان‌گیری با موفقیت کامل به پایان رسید!");
console.log("=======================================================\n");
