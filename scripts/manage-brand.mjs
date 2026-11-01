#!/usr/bin/env node
/**
 * 🏢 Brand Management CLI
 * Manage dashboard brands directly in the SQLite database.
 * 
 * Usage:
 *   node scripts/manage-brand.mjs list
 *   node scripts/manage-brand.mjs add [id] [name] [shortName] [sheetUrl]
 *   node scripts/manage-brand.mjs activate [id]
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = process.cwd();
const dbPath = process.env.DATABASE_FILE || path.join(projectRoot, "data", "dashboard.sqlite");

if (!fs.existsSync(dbPath)) {
  console.error(`❌ خطا: فایل پایگاه داده در مسیر ${dbPath} پیدا نشد!`);
  process.exit(1);
}

const sqlite = new DatabaseSync(dbPath);

function normalizeSheetUrl(value) {
  if (!value) return { csvUrl: "", indexUrl: "" };
  const cleaned = value.trim()
    .replace(/^['"“”]+|['"“”]+$/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  try {
    const url = new URL(cleaned);
    const match = url.pathname.match(/^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)(?:\/(?:pubhtml|pub))?\/?$/);
    if (match) {
      const root = `https://docs.google.com/spreadsheets/d/e/${match[1]}`;
      return { csvUrl: `${root}/pub?output=csv`, indexUrl: `${root}/pubhtml` };
    }
  } catch {}
  return { csvUrl: cleaned, indexUrl: cleaned };
}

const action = process.argv[2] || "list";

if (action === "list") {
  console.log("\n=======================================================");
  console.log(" 🏢 فهرست دفاتر و برندهای ثبت‌شده در داشبورد");
  console.log("=======================================================\n");

  const brands = sqlite.prepare(`
    SELECT id, name, short_name, config_status, sheet_status, is_default, sheet_csv_url, updated_at
    FROM dashboard_brands ORDER BY is_default DESC, name ASC
  `).all();

  if (brands.length === 0) {
    console.log("⚠️ هیچ برندی در پایگاه داده ثبت نشده است.");
  } else {
    for (const b of brands) {
      const isDef = b.is_default ? " [پیش‌فرض]" : "";
      console.log(`📌 شناسه: ${b.id}${isDef}`);
      console.log(`   نام کامل: ${b.name}`);
      console.log(`   نام کوتاه: ${b.short_name}`);
      console.log(`   وضعیت در داشبورد: ${b.config_status === "active" ? "🟢 فعال (قابل انتخاب)" : "🟡 پیش‌نویس / نیازمند تکمیل"}`);
      console.log(`   اتصال گوگل شیت: ${b.sheet_status === "connected" ? "🟢 متصل" : "⚪ " + b.sheet_status}`);
      if (b.sheet_csv_url) {
        console.log(`   آدرس شیت: ${b.sheet_csv_url.slice(0, 70)}...`);
      }
      console.log("-------------------------------------------------------");
    }
  }
} else if (action === "add") {
  const id = process.argv[3] || "novavaran";
  const name = process.argv[4] || "دفتر نوآوران";
  const shortName = process.argv[5] || "نوآوران";
  const sheetUrlRaw = process.argv[6] || "";

  const { csvUrl, indexUrl } = normalizeSheetUrl(sheetUrlRaw);
  const sheetStatus = csvUrl ? "connected" : "pending";
  const sheetMsg = csvUrl ? "منبع Google Sheets ثبت شد." : "اتصال Google Sheets هنوز تنظیم نشده است.";

  console.log(`\n➕ در حال ثبت برند: ${name} (${id})...`);

  sqlite.prepare(`
    INSERT INTO dashboard_brands (
      id, name, short_name, sheet_csv_url, sheet_index_url,
      sheet_status, sheet_message, config_status, is_default, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      short_name = excluded.short_name,
      sheet_csv_url = CASE WHEN excluded.sheet_csv_url != '' THEN excluded.sheet_csv_url ELSE dashboard_brands.sheet_csv_url END,
      sheet_index_url = CASE WHEN excluded.sheet_index_url != '' THEN excluded.sheet_index_url ELSE dashboard_brands.sheet_index_url END,
      sheet_status = CASE WHEN excluded.sheet_csv_url != '' THEN 'connected' ELSE dashboard_brands.sheet_status END,
      config_status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `).run(id, name, shortName, csvUrl, indexUrl, sheetStatus, sheetMsg);

  // Seed default rules if not existing
  const defaultRules = JSON.stringify({
    schemaVersion: 1,
    rulesVersion: "1.0.0",
    channels: [
      { id: "sms", name: "پیامک", aliases: ["پیامک", "اس ام اس", "اس‌ام‌اس", "SMS"], costMode: "daily_budget", contractorEnabled: false, color: "gold", icon: "✉", enabled: true },
      { id: "google_ads", name: "گوگل ادز", aliases: ["تبلیغات گوگل", "گوگل ادز", "گوگل‌ادز"], costMode: "google_ads", contractorEnabled: true, color: "teal", icon: "G", enabled: true },
      { id: "instagram", name: "اینستاگرام", aliases: ["اینستاگرام"], costMode: "daily_budget", contractorEnabled: true, color: "coral", icon: "◎", enabled: true },
      { id: "whatsapp", name: "واتساپ", aliases: ["واتساپ", "واتس اپ", "واتس‌آپ"], costMode: "google_ads", contractorEnabled: false, color: "green", icon: "◉", enabled: true },
      { id: "site_form", name: "فرم سایت", aliases: ["فرم سایت"], costMode: "google_ads", contractorEnabled: false, color: "blue", icon: "▤", enabled: true },
      { id: "loyal", name: "مسافر ثابت", aliases: ["مسافر ثابت", "مسافر قدیمی"], costMode: "none", contractorEnabled: false, color: "sand", icon: "♙", enabled: true },
      { id: "other", name: "سایر", aliases: ["سایر", "معرفی"], costMode: "none", contractorEnabled: false, color: "warning", icon: "…", enabled: true }
    ],
    routes: [{ target: "گرجستان", aliases: ["گرجستان", "باتومی", "تفلیس"] }],
    experts: [],
    sheetColumns: { date: "تاریخ", weekday: "روز هفته", source: "منبع فایل", route: "مسیر", expert: "کارشناس", outcome: "نتیجه", notes: "توضیحات" },
    contractOutcomes: ["قرارداد شد"],
    formulas: { cpl: "cost_per_paid_lead", cac: "cost_per_attributed_contract", expertAllocation: "channel_lead_share", includeContractorFees: true }
  });

  sqlite.prepare(`
    INSERT OR IGNORE INTO brand_dashboard_rules (brand_id, config_json, version, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
  `).run(id, defaultRules);

  console.log(`✅ برند «${name}» با موفقیت ثبت و فعال شد.`);
  console.log(`📌 اکنون این دفتر در منوی کشویی بالای داشبورد («انتخاب برند») قابل انتخاب است.\n`);
} else if (action === "activate") {
  const id = process.argv[3];
  if (!id) {
    console.error("❌ شناسه برند را مشخص کنید: node scripts/manage-brand.mjs activate [id]");
    process.exit(1);
  }
  sqlite.prepare("UPDATE dashboard_brands SET config_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  console.log(`✅ برند ${id} فعال شد.`);
} else {
  console.log("دستور نامعتبر است. گزینه‌ها: list, add, activate");
}
