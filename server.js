import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

// 1. Register ESM loader so `cloudflare:workers` resolves cleanly in pure Node.js
register("./server/cloudflare-loader.mjs", pathToFileURL("./"));

// 2. Load .env or .dev.vars if present without external dependencies
function loadEnv() {
  const envFiles = [".env", ".env.local", ".dev.vars"];
  for (const file of envFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}
loadEnv();
process.env.VINEXT_TRUST_PROXY ??= "1";

async function start() {
  // 3. Initialize SQLite database and local uploads bucket
  const { createLocalD1Database, LocalDiskBucket } = await import("./server/sqlite-d1-adapter.js");

  const dbPath = process.env.DATABASE_FILE || path.resolve(process.cwd(), "data", "dashboard.sqlite");
  const uploadsPath = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "data", "uploads");

  console.log(`[Dashboard Server] Initializing SQLite database at: ${dbPath}`);
  const localD1 = createLocalD1Database(dbPath);
  const localBucket = new LocalDiskBucket(uploadsPath);

  // 4. Auto-apply migrations if database tables are not yet created
  async function ensureMigrations() {
    try {
      const tableCheck = await localD1.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='dashboard_brands'").first();
      if (!tableCheck || !tableCheck.count) {
        console.log("[Dashboard Server] Empty database detected. Auto-applying 21 SQL migrations from drizzle/...");
        const drizzleDir = path.resolve(process.cwd(), "drizzle");
        if (fs.existsSync(drizzleDir)) {
          const sqlFiles = fs.readdirSync(drizzleDir).filter(f => f.endsWith(".sql")).sort();
          for (const file of sqlFiles) {
            const sql = fs.readFileSync(path.join(drizzleDir, file), "utf-8");
            await localD1.exec(sql);
            console.log(`  ✓ Applied migration: ${file}`);
          }
          console.log("[Dashboard Server] All migrations applied successfully!");
        }
      }
    } catch (err) {
      console.error("[Dashboard Server] Warning while checking migrations:", err.message);
    }
  }
  await ensureMigrations();

  // 5. Expose runtime bindings to globalThis for worker and Drizzle
  globalThis.__CLOUDFLARE_ENV = {
    DB: localD1,
    BUCKET: localBucket,
    DASHBOARD_ADMIN_USER: process.env.DASHBOARD_ADMIN_USER || "Admin",
    DASHBOARD_ADMIN_PASSWORD_HASH: process.env.DASHBOARD_ADMIN_PASSWORD_HASH || "",
    GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY: process.env.GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY || "",
  };

  // 6. Ensure dist/ exists; if not, suggest running build
  const distDir = path.resolve(process.cwd(), "dist");
  if (!fs.existsSync(distDir)) {
    console.error("\n[Dashboard Server] ERROR: 'dist/' directory not found!");
    console.error("Please run 'npm run build' before starting the server.\n");
    process.exit(1);
  }

  // 7. Start the production server
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";

  const { startProdServer } = await import("vinext/server/prod-server");

  console.log(`\n======================================================`);
  console.log(`  🚀 Marketing Manager Dashboard is starting...`);
  console.log(`  📍 Listening on: http://${host}:${port}`);
  console.log(`  📦 Runtime: Standalone Node.js (cPanel / Server mode)`);
  console.log(`======================================================\n`);

  await startProdServer({
    port,
    host,
    outDir: distDir
  });
}

start().catch((err) => {
  console.error("[Dashboard Server] Fatal startup error:", err);
  process.exit(1);
});
