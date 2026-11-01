# Changelog

All notable changes to the **Ziarati Marketing Dashboard** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.260.0] - 2026-09-23

### 🛡️ Critical Persistence & Architecture Fixes
- **Solved Cloud vs On-Premises Data Loss (Miniflare to cPanel Migration):**
  - Identified the root cause of previously missing marketing budgets: ChatGPT's ephemeral Miniflare sandbox held the database purely in temporary memory, resetting on every code rebuild or container recycle.
  - Implemented persistent on-disk SQLite storage on cPanel NVMe storage (`/home/donyagar/mashboard/data/dashboard.sqlite`).
  - Added strict `.gitignore` rules for `*.sqlite`, `*.sqlite*`, and `*.db`, ensuring that `git pull` operations on the production server can never overwrite or tamper with the live production database.
  - Configured SQLite with **WAL (Write-Ahead Logging)** mode (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`) to ensure ACID compliance, instant transaction durability, and immunity against process crashes or power drops.

### 🏢 Multi-Brand & Multi-Office Support
- **Full Support for "Novavaran Rah Sepid" Office:**
  - Resolved the issue where "دفتر نوآوران" appeared stuck in `draft` ("پیش‌نویس") status with empty metrics.
  - Migrated and seeded complete historical data for Novavaran (`brand-3f7216ab`), including 80 daily budget records, 160 channel daily costs, 3 contractor fees, 3 SMS prices, and 3 TRY exchange rates.
  - Updated `scripts/restore-backup.mjs` and `/api/dashboard-rules` to automatically switch restored brands to `config_status = 'active'` upon backup import using `ON CONFLICT DO UPDATE`.
  - Relaxed brand activation constraints in `app/api/brands/route.ts` and `app/dashboard-client.tsx` to allow activating brands even if a Google Sheets connection is pending, ensuring manual budgets and rates remain fully functional.
  - Added multi-brand CLI tools:
    - `npm run brand:list`: Inspect all registered brands and activation status.
    - `npm run brand:add`: Interactively add new branches and offices.
    - `npm run db:restore:novavaran`: One-click restore for Novavaran data.
    - `npm run db:restore:all`: Restores both Donyagardi and Novavaran offices simultaneously.

### 🔄 Backup & Recovery System (3-Tier Protection)
- **Web UI Backup Restore Fix:**
  - Fixed a silent failure in `app/dashboard-client.tsx` where file uploads rejected current backups due to an outdated check (`[1, 2].includes(backup.schemaVersion)`). Updated to support `schemaVersion: 3`.
- **Automated Backup CLI (`scripts/backup-db.mjs`):**
  - Introduced `npm run db:backup` command.
  - Triggers `PRAGMA wal_checkpoint(TRUNCATE)` to flush WAL memory caches to disk cleanly.
  - Creates physical point-in-time SQLite snapshots (`data/backups/dashboard-snapshot-[timestamp].sqlite`).
  - Generates isolated, per-brand JSON exports for all active brands.
  - Automatically rotates and trims historical backups, retaining the 50 newest snapshots.
- **GitHub Repository Backup Sync CLI (`scripts/backup-to-git.mjs`):**
  - Added `npm run db:backup:git` command.
  - Exports database state to version-controlled JSON files (`data/dashboard-backup-*.json`).
  - Automatically stages, commits with `[skip ci]`, and pushes updates directly to the private GitHub repository.
  - Provides instant off-site versioning, diff tracking, and disaster recovery.

### 🔒 Security, Authentication & Reverse Proxy Hardening
- **Reverse Proxy / Subdomain CSRF Fix:**
  - Updated origin verification in `worker/index.ts` to honor `x-forwarded-host` and `x-forwarded-proto` headers behind cPanel Nginx reverse proxies, fixing "درخواست ورود معتبر نیست" (Invalid login request) errors.
- **Password & Session Security:**
  - Standardized on `scrypt-v1` password hashing with per-user cryptographic salts.
  - Protected sessions using `__Host-dashboard_session` cookies with `HttpOnly`, `SameSite=None`, and `Secure` attributes, coupled with a 20-minute rolling idle timeout.
  - Encrypted Google Ads service accounts and client credentials via military-grade **AES-256-GCM** with random IVs.
- **Credential Management CLI:**
  - Added `npm run set-admin` (`scripts/set-admin.mjs`) to easily reset or inspect admin usernames and passwords directly from the server CLI.

### ⚙️ Production Server & Deployment Compatibility
- **cPanel & Phusion Passenger Compatibility:**
  - Refactored `server.js` and `app.js` to ensure compatibility with CommonJS loaders without requiring top-level `await`.
  - Added configurable `NEXT_BASE_PATH` support for hosting the dashboard under subpaths (e.g., `/mashboard`).
  - Included `.cpanel.yml` deployment script and GitHub Actions CI/CD workflow (`.github/workflows/deploy.yml`).

---

## [0.250.0] - 2026-09-15

### Added
- **SEO Opportunity Radar:**
  - Dynamic Google Search Console analyzer identifying low-risk, high-CTR content gaps.
  - Integrated 14-day comparison charts and ranking distribution metrics.
- **Automated Telegram Bot Reporting:**
  - Daily summary reports dispatched at 18:30 (and Thursday afternoon reports at 14:40).
  - Persian official holiday calendar integration to suppress non-working day notifications.
- **Dynamic Google Sheets Engine:**
  - Automated tab detection and sheet CSV caching with anti-zeroing fallback mechanisms.

---

## [0.200.0] - 2026-08-01

### Added
- Multi-office data partitioning (`brand_id` foreign keys on all relational tables).
- Persian Jalali 7-column calendar picker with comparison periods.
- Dual-mode server runtime (Node.js 22 Standalone + Cloudflare Workers / Miniflare).
- Drizzle ORM schema with 21 versioned migrations.
