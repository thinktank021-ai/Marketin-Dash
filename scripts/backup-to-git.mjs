#!/usr/bin/env node
/**
 * 🚀 Automated Git Backup Sync
 * Backs up the SQLite database to JSON and commits/pushes changes to the private GitHub repository.
 * 
 * Usage:
 *   node scripts/backup-to-git.mjs
 *   npm run db:backup:git
 */

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const projectRoot = process.cwd();

function run(cmd, silent = false) {
  try {
    return execSync(cmd, { cwd: projectRoot, encoding: "utf-8", stdio: silent ? "pipe" : "inherit" });
  } catch (error) {
    if (silent) return null;
    throw error;
  }
}

console.log("\n=======================================================");
console.log(" 🚀 پشتیبان‌گیری و همگام‌سازی خودکار با گیت‌هاب (Git Backup)");
console.log("=======================================================\n");

// Step 1: Run local database backup
console.log("📦 ۱. استخراج پشتیبان از پایگاه داده...");
run("node scripts/backup-db.mjs");

// Step 2: Configure git author if not set (useful for cPanel cron)
try {
  const currentName = run("git config user.name", true);
  if (!currentName || !currentName.trim()) {
    run('git config user.name "Dashboard Auto-Backup"');
    run('git config user.email "backup@donyagardi.com"');
  }
} catch {
  run('git config user.name "Dashboard Auto-Backup"');
  run('git config user.email "backup@donyagardi.com"');
}

// Step 3: Stage canonical JSON backup files
console.log("\n🔍 ۲. بررسی تغییرات فایل‌های پشتیبان در گیت...");
run("git add data/dashboard-backup-*.json");

// Check if there are staged changes
let hasChanges = false;
try {
  const staged = execSync("git diff --cached --name-only", { cwd: projectRoot, encoding: "utf-8" }).trim();
  hasChanges = staged.length > 0;
  if (hasChanges) {
    console.log("  ✓ فایل‌های تغییر یافته:");
    staged.split("\n").forEach(f => console.log(`     - ${f}`));
  }
} catch (e) {
  console.warn("  ! خطا در بررسی تغییرات گیت:", e.message);
}

if (!hasChanges) {
  console.log("  ℹ️ داده‌ها نسبت به آخرین بکاپ تغییری نکرده‌اند. نیازی به کامیت جدید نیست.");
  console.log("\n=======================================================");
  console.log(" ✅ فرآیند با موفقیت پایان یافت.");
  console.log("=======================================================\n");
  process.exit(0);
}

// Step 4: Commit changes with [skip ci]
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const commitMsg = `chore(backup): automated database sync [skip ci] (${timestamp})`;

console.log(`\n💾 ۳. ثبت کامیت در گیت: "${commitMsg}"...`);
try {
  run(`git commit -m "${commitMsg}"`);
  console.log("  ✓ کامیت با موفقیت ثبت شد.");
} catch (e) {
  console.error("  ❌ خطا در ثبت کامیت:", e.message);
  process.exit(1);
}

// Step 5: Push to remote GitHub repository
console.log("\n🌐 ۴. ارسال تغییرات به ریپازیتوری پرایویت گیت‌هاب (git push)...");
try {
  run("git push origin main");
  console.log("\n=======================================================");
  console.log(" 🎉 تمام اطلاعات و بکاپ‌ها با موفقیت در گیت‌هاب ذخیره شدند!");
  console.log("=======================================================\n");
} catch (e) {
  console.warn("\n⚠️ کامیت به صورت محلی ثبت شد، اما ارسال به گیت‌هاب با خطا مواجه شد.");
  console.warn("  علت احتمالی: عدم تنظیم SSH Key یا Personal Access Token روی سرور cPanel.");
  console.warn("  برای فعال‌سازی ارسال خودکار، دسترسی Write گیت‌هاب را روی سرور فعال کنید.");
}
