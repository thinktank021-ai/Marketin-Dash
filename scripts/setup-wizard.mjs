#!/usr/bin/env node
/**
 * 🧙 Setup Wizard for Marketing Manager Dashboard
 * Automates SQLite database setup, migrations, admin credentials, encryption keys, and environment configs.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const projectRoot = process.cwd();
const dataDir = path.join(projectRoot, "data");
const dbPath = path.join(dataDir, "dashboard.sqlite");
const uploadsDir = path.join(dataDir, "uploads");
const drizzleDir = path.join(projectRoot, "drizzle");
const envFile = path.join(projectRoot, ".env");
const devVarsFile = path.join(projectRoot, ".dev.vars");

// Helper to ask questions via readline
function ask(questionText, defaultVal = "") {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = defaultVal ? `${questionText} [${defaultVal}]: ` : `${questionText}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function main() {
  console.log("\n==================================================================");
  console.log(" 🧙 ویزارد نصب و راه‌اندازی آسان داشبورد مارکتینگ (Setup Wizard)");
  console.log(" Marketing Manager Dashboard - Production & Host Installer");
  console.log("==================================================================\n");

  // 1. Check Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  console.log(`[1/5] بررسی محیط ران‌تایم: Node.js ${nodeVersion}`);
  if (major < 20) {
    console.error(`❌ خطا: نسخه Node.js شما ${nodeVersion} است. حداقل نسخه ۲۰ به بالا نیاز است.`);
    process.exit(1);
  }
  console.log("  ✓ نسخه Node.js پشتیبانی می‌شود.");

  // 2. Prepare directories
  console.log("\n[2/5] ایجاد پوشه‌های داده و استوریج لوکال...");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`  ✓ پوشه داده: ${dataDir}`);
  console.log(`  ✓ پوشه آپلودها: ${uploadsDir}`);

  // 3. Admin Credentials Configuration
  console.log("\n[3/5] تنظیم مشخصات کاربری ورود مدیر (Admin Authentication)");
  const isInteractive = !process.argv.includes("--non-interactive");

  let adminUser = "Admin";
  let adminPass = "admin123";

  if (isInteractive) {
    adminUser = await ask("نام کاربری مدیر (Admin Username)", "Admin");
    adminPass = await ask("رمز عبور مدیر (Admin Password)", "admin123");
  } else {
    console.log(`  استفاده از مقادیر پیش‌فرض (--non-interactive)`);
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await derivePassword(adminPass, salt);
  const passwordHash = `scrypt-v1:${salt}:${derivedKey.toString("hex")}`;
  const encryptionKey = crypto.randomBytes(32).toString("hex");

  console.log("  ✓ هش رمز عبور scrypt تولید شد.");
  console.log("  ✓ کلید رمزنگاری ۲۵۶ بیتی AES-GCM تولید شد.");

  // 4. Database Initialization and Migrations
  console.log("\n[4/5] آماده‌سازی پایگاه داده SQLite و اعمال ۲۱ مایگریشن SQL...");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  if (!fs.existsSync(drizzleDir)) {
    console.error("❌ خطا: پوشه مایگریشن‌های drizzle پیدا نشد!");
    process.exit(1);
  }

  const sqlFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")).sort();
  let appliedCount = 0;
  for (const sqlFile of sqlFiles) {
    const sqlContent = fs.readFileSync(path.join(drizzleDir, sqlFile), "utf-8");
    try {
      sqlite.exec(sqlContent);
      appliedCount++;
    } catch (e) {
      // If table already exists, continue safely
      if (!e.message.includes("already exists")) {
        console.warn(`  ! هشدار در اجرای ${sqlFile}:`, e.message);
      }
    }
  }
  console.log(`  ✓ تعداد ${appliedCount} فایل SQL با موفقیت روی پایگاه‌داده اعمال شد.`);

  // 5. Generate .env and .dev.vars files
  console.log("\n[5/5] ذخیره‌سازی فایل‌های پیکربندی (.env و .dev.vars)...");
  const envContent = `# Marketing Manager Dashboard - Production Environment Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
DATABASE_FILE=data/dashboard.sqlite
UPLOADS_DIR=data/uploads

# Admin Credentials
DASHBOARD_ADMIN_USER="${adminUser}"
DASHBOARD_ADMIN_PASSWORD_HASH="${passwordHash}"

# External Secrets Encryption (AES-GCM 64 hex characters)
GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY="${encryptionKey}"
`;

  fs.writeFileSync(envFile, envContent);
  fs.writeFileSync(devVarsFile, envContent);
  console.log("  ✓ فایل .env ساخته شد.");
  console.log("  ✓ فایل .dev.vars ساخته شد.");

  // Success summary
  console.log("\n==================================================================");
  console.log(" 🎉 راه‌اندازی و نصب اولیه با موفقیت کامل انجام شد!");
  console.log("==================================================================");
  console.log(` 👤 نام کاربری: ${adminUser}`);
  console.log(` 🔑 رمز عبور:   ${adminPass}`);
  console.log("------------------------------------------------------------------");
  console.log(" 📌 دستورالعمل‌های راه‌اندازی در سرور و هاست:");
  console.log("");
  console.log(" ۱. اجرای تست در محیط پروداکشن محلی:");
  console.log("    npm run build");
  console.log("    npm run server    # یا: node server.js");
  console.log("");
  console.log(" ۲. راه‌اندازی در سرورهای لینوکس با PM2:");
  console.log("    npm install -g pm2");
  console.log('    pm2 start server.js --name "marketing-dashboard"');
  console.log("    pm2 save && pm2 startup");
  console.log("");
  console.log(" ۳. راه‌اندازی در هاست cPanel (بخش Setup Node.js App):");
  console.log("    - Application root: مسیر پوشه پروژه در هاست");
  console.log("    - Application startup file: server.js");
  console.log("    - Node.js version: انتخاب نسخه 22 یا 20");
  console.log('    - روی "Run NPM Install" و سپس "Restart" کلیک کنید.');
  console.log("==================================================================\n");
}

main().catch((err) => {
  console.error("❌ خطا در اجرای ویزارد:", err);
  process.exit(1);
});
