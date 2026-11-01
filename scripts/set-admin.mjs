#!/usr/bin/env node
/**
 * 🔑 Admin Credentials Manager
 * Allows updating or setting the dashboard administrator username and password securely.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const projectRoot = process.cwd();
const envFile = path.join(projectRoot, ".env");
const devVarsFile = path.join(projectRoot, ".dev.vars");
const dbPath = path.join(projectRoot, "data", "dashboard.sqlite");

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function updateEnvFile(filePath, user, hash) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf-8");

  if (content.includes("DASHBOARD_ADMIN_USER=")) {
    content = content.replace(/DASHBOARD_ADMIN_USER=.*/g, `DASHBOARD_ADMIN_USER="${user}"`);
  } else {
    content += `\nDASHBOARD_ADMIN_USER="${user}"\n`;
  }

  if (content.includes("DASHBOARD_ADMIN_PASSWORD_HASH=")) {
    content = content.replace(/DASHBOARD_ADMIN_PASSWORD_HASH=.*/g, `DASHBOARD_ADMIN_PASSWORD_HASH="${hash}"`);
  } else {
    content += `\nDASHBOARD_ADMIN_PASSWORD_HASH="${hash}"\n`;
  }

  fs.writeFileSync(filePath, content, "utf-8");
}

async function main() {
  const username = process.argv[2] || "ziarati";
  const password = process.argv[3] || "Ziarati@1402";

  console.log(`\n======================================================`);
  console.log(`  🔑 تنظیم مشخصات کاربری مدیر داشبورد`);
  console.log(`  👤 نام کاربری: ${username}`);
  console.log(`======================================================\n`);

  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await derivePassword(password, salt);
  const passwordHash = `scrypt-v1:${salt}:${derivedKey.toString("hex")}`;

  updateEnvFile(envFile, username, passwordHash);
  updateEnvFile(devVarsFile, username, passwordHash);

  // Clear previous sessions in sqlite if db exists so the new credentials take effect immediately
  if (fs.existsSync(dbPath)) {
    try {
      const sqlite = new DatabaseSync(dbPath);
      sqlite.exec("DELETE FROM dashboard_login_sessions;");
      sqlite.exec("DELETE FROM dashboard_login_attempts;");
      console.log("  ✓ نشست‌های قدیمی ورود پاکسازی شدند.");
    } catch (e) {
      // Ignore if table not created yet
    }
  }

  console.log(`  ✓ نام کاربری به "${username}" تنظیم شد.`);
  console.log(`  ✓ هش اختصاصی scrypt برای رمز عبور با موفقیت در .env ذخیره شد.`);
  console.log(`\n🎉 مشخصات جدید مدیر با موفقیت فعال گردید!\n`);
}

main().catch(err => {
  console.error("❌ خطا:", err);
  process.exit(1);
});
