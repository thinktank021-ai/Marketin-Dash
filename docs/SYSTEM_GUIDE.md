# Ziarati Marketing Dashboard — Technical Architecture & Operations Guide

> Comprehensive technical documentation for developers, system administrators, and AI assistants.

---

## 1. Executive Summary & Purpose

The **Ziarati Marketing Dashboard** is an enterprise-grade analytics, lead tracking, financial reconciliation, and SEO intelligence platform tailored for multi-branch tourism and pilgrimage agencies (e.g., **Donyagardi** and **Novavaran Rah Sepid**).

The application operates under **strict non-negotiable principles**:
1. **Anti-Zeroing Guarantee:** In the event of upstream API downtime (Google Sheets, Google Ads, Search Console), metrics must never drop to zero. Instead, the last known healthy state is rendered with visual stale-data indicators.
2. **Multi-Brand Tenant Isolation:** Every financial record, budget entry, lead, and API token is strictly scoped to a unique `brand_id`. Data never leaks across offices.
3. **Storage Durability & Data Persistence:** All user-entered data (daily budgets, channel fees, contractor commissions, SMS unit costs, and currency exchange rates) is written to durable persistent media with immediate write-ahead logging.

---

## 2. System Architecture & Runtime Environments

The dashboard utilizes a **dual-mode runtime architecture**:

```
                       ┌────────────────────────────────────────────────────────┐
                       │                   Client Browser                       │
                       │           (React 19 + Tailwind CSS 4)                  │
                       └──────────────────────────┬─────────────────────────────┘
                                                  │
                                                  ▼
                       ┌────────────────────────────────────────────────────────┐
                       │               Nginx / Reverse Proxy                    │
                       │             (SSL Termination, Port 443)                │
                       └──────────────────────────┬─────────────────────────────┘
                                                  │ (proxy_pass)
                                                  ▼
      ┌─────────────────────────────────────────────────────────────────────────────────┐
      │                  Standalone Node.js 22 Runtime (Production Host)                │
      │                                                                                 │
      │  ┌───────────────────────┐   ┌────────────────────────┐   ┌──────────────────┐  │
      │  │      server.js        │──▶│  Vinext / Next.js RSC  │──▶│  API Route Handlers│ │
      │  │  (HTTP / Passenger)  │   │     (App Router)       │   │  (/api/budgets)  │  │
      │  └───────────────────────┘   └────────────────────────┘   └────────┬─────────┘  │
      │                                                                    │            │
      │                                                                    ▼            │
      │                                                           ┌──────────────────┐  │
      │                                                           │ node:sqlite ORM  │  │
      │                                                           │   (Drizzle ORM)  │  │
      │                                                           └────────┬─────────┘  │
      └────────────────────────────────────────────────────────────────────┼────────────┘
                                                                           │
                                                                           ▼
                                                ┌──────────────────────────────────────┐
                                                │        Persistent Storage            │
                                                │  /home/donyagar/mashboard/data/      │
                                                │         dashboard.sqlite             │
                                                │       (WAL Mode, NVMe Disk)          │
                                                └──────────────────────────────────────┘
```

### Runtime Modes:
1. **Standalone Production Mode (cPanel / Linux VPS):**
   - Executed via `node server.js` using Node.js `>=22.13.0`.
   - Utilizes native `node:sqlite` directly interacting with `/data/dashboard.sqlite`.
   - Does **not** require external serverless bindings or Cloudflare D1 dependencies.
2. **Edge Worker Mode (Cloudflare Workers / Pages):**
   - Bundled via `vite.config.ts` and `worker/index.ts`.
   - Binds to Cloudflare D1 for distributed relational storage and Cloudflare R2 for asset storage.

---

## 3. Database Durability & Memory Model (Resolution of Historical Data Loss)

### Root Cause of Previous Data Disappearance
In earlier revisions running inside ephemeral sandbox environments (such as ChatGPT Sites or Miniflare), the database ran entirely in transient worker memory. Every deployment, code rebuild, or container sleep cycle recycled the memory state, obliterating manually entered budgets.

### Current Production Durability Guarantee
On the production server (`cPanel / Cloud Linux`):
1. **Physical On-Disk Storage:** All tables reside in a physical SQLite file:
   `/home/donyagar/mashboard/data/dashboard.sqlite`
2. **Git Immunity (`.gitignore`):**
   The `.gitignore` configuration explicitly blocks all database files:
   ```gitignore
   # database files
   *.sqlite
   *.sqlite*
   *.db
   /data/backups/*
   !/data/backups/.gitkeep
   ```
   **Crucial Implication:** Running `git pull`, `git fetch`, or updating application source code **never** touches, overwrites, or truncates the live database.
3. **Write-Ahead Logging (WAL):**
   The database operates with `PRAGMA journal_mode = WAL;` and `PRAGMA synchronous = NORMAL;`.
   - Changes are immediately recorded into a dedicated write-ahead log (`dashboard.sqlite-wal`).
   - Sudden process termination or host reboots do not cause data corruption.
   - Point-in-time commits are guaranteed (ACID compliant).

---

## 4. Multi-Brand Isolation Architecture

The database partitions data by `brand_id`. Two offices are actively supported:
- **Donyagardi (`donyagardi`):** Main pilgrimage and tourism agency.
- **Novavaran Rah Sepid (`brand-3f7216ab`):** Specialized visa and corporate travel division.

### Data Partitioning Model:
All relational tables enforce `brand_id` scoping:
- `brand_weekly_ad_budgets`: Daily SMS and Instagram spending records per brand.
- `brand_monthly_channel_contractor_fees`: Agency and media management fees per brand.
- `brand_channel_daily_costs`: Daily breakdown of paid channels (Google Ads, Taplighat, Influencer).
- `brand_monthly_sms_prices`: Unit price per SMS in Iranian Toman.
- `brand_monthly_currency_rates`: Dynamic conversion rates (e.g., Turkish Lira TRY to IRR Toman).
- `brand_monthly_expert_contracts` & `brand_expert_contract_records`: Deal attribution per consultant.
- `brand_dashboard_rules`: JSON configuration for business logic and attribution rules.

---

## 5. Security & Cryptographic Specifications

| Security Domain | Standard / Algorithm | Implementation Details |
| :--- | :--- | :--- |
| **Password Hashing** | `scrypt-v1` | Key derivation with random 16-byte salt, `N=16384`, `r=8`, `p=1`. Resilient to brute-force and ASIC attacks. |
| **Session Cookies** | `__Host-dashboard_session` | Flags: `HttpOnly` (blocks XSS exfiltration), `Secure` (HTTPS only), `SameSite=None` (cross-context allowed), rolling 20-minute idle TTL. |
| **API Secret Encryption** | `AES-256-GCM` | Google Ads and Google Sheets service account credentials encrypted with random 12-byte IV and authenticated tag. |
| **Reverse Proxy Protection** | Same-Origin Validation | Checks `x-forwarded-host`, `x-forwarded-proto`, and `Origin` to mitigate CSRF attacks behind reverse proxies. |
| **Host Isolation** | Isolated Directory | Dashboard lives in `/home/donyagar/mashboard/`, completely separated from the primary WordPress webroot (`/home/donyagar/public_html/`). |

---

## 6. Complete Backup & Disaster Recovery Architecture

To ensure zero risk of data loss, the project features a **3-tier backup strategy**:

```
                       ┌─────────────────────────────────────────────────────────┐
                       │          Live Database: dashboard.sqlite                │
                       └────────────┬───────────────────┬────────────────────┬───┘
                                    │                   │                    │
              Tier 1: Scheduled     │   Tier 2: Manual  │    Tier 3: Cloud   │
              Local Snapshots       │   UI Export       │    Git Repo Sync   │
                                    │                   │                    │
                                    ▼                   ▼                    ▼
                           ┌─────────────────┐ ┌─────────────────┐  ┌─────────────────┐
                           │ data/backups/   │ │ Web Download:   │  │ Private GitHub  │
                           │  - .sqlite copy │ │  JSON backup    │  │  Repository     │
                           │  - Brand JSONs  │ │  (Settings UI)  │  │  (Auto Commit & │
                           │ (Auto-trimmed)  │ │                 │  │   Push via CLI) │
                           └─────────────────┘ └─────────────────┘  └─────────────────┘
```

### Tier 1: Automated Local Snapshots (`npm run db:backup`)
- Executes `scripts/backup-db.mjs`.
- Issues `PRAGMA wal_checkpoint(TRUNCATE)` to flush transient RAM cache to disk.
- Copies the SQLite database to `data/backups/dashboard-snapshot-[timestamp].sqlite`.
- Exports standalone JSON backups for each active brand (`data/backups/dashboard-backup-[brandId]-[timestamp].json`).
- Automatically rotates historical backups, retaining the **50 most recent snapshots**.

### Tier 2: Web Interface Backup & Restore
- Accessible via **تنظیمات داشبورد (Settings) > پشتیبان‌گیری و بازیابی**.
- Administrators can download full logical JSON backups anytime.
- Supports restoring `schemaVersion: 1`, `2`, and `3`. Restoring a backup automatically activates the brand without requiring a manual SQL query.

### Tier 3: Automated GitHub Repository Sync (`npm run db:backup:git`)
Because the repository is **private**, storing data backups directly in Git gives:
- **Full Version History:** Every budget edit, price adjustment, or rate modification is diffable and tracked over time.
- **Geographic Redundancy:** Even if the hosting server suffers catastrophic disk failure, all historical records are preserved on GitHub's secure infrastructure.
- **Instant Disaster Recovery:** Running `npm run db:restore:all` on a fresh server restores 100% of both offices' data in under 2 seconds.

---

## 7. How to Configure Automated GitHub Backups from cPanel

To enable the cPanel server to automatically commit and push database backups to your private GitHub repo every midnight:

### Step 1: Add a Deploy Key to GitHub
1. Open the cPanel Terminal and generate an SSH key (if not already present):
   ```bash
   ssh-keygen -t ed25519 -C "backup@donyagardi.com" -f ~/.ssh/id_ed25519_github -N ""
   ```
2. Display the public key:
   ```bash
   cat ~/.ssh/id_ed25519_github.pub
   ```
3. Copy the key and go to your GitHub repository:
   - Navigate to: **Settings > Deploy keys > Add deploy key**.
   - Title: `cPanel Production Backup Key`.
   - Key: Paste the public key.
   - **Important:** Check **"Allow write access"** so the server can push commits.
4. Configure SSH on cPanel to use this key for GitHub:
   ```bash
   cat << 'EOF' >> ~/.ssh/config
   Host github.com
       HostName github.com
       User git
       IdentityFile ~/.ssh/id_ed25519_github
       IdentitiesOnly yes
   EOF
   chmod 600 ~/.ssh/config ~/.ssh/id_ed25519_github
   ```
5. Test the connection:
   ```bash
   ssh -T git@github.com
   # Expected output: Hi am333ni7y/ziarati-marketing-dashboard! You've successfully authenticated...
   ```

### Step 2: Configure the Cron Job in cPanel
1. In cPanel, navigate to **Cron Jobs**.
2. Select frequency (e.g., **Once Per Day at 00:00**):
   ```bash
   0 0 * * *
   ```
3. Enter the following command:
   ```bash
   cd /home/donyagar/mashboard && /opt/cpanel/ea-nodejs22/bin/node scripts/backup-to-git.mjs >> /home/donyagar/mashboard/data/backups/git-backup.log 2>&1
   ```
   *(Note: replace `/opt/cpanel/ea-nodejs22/bin/node` with your server's Node 22 binary path, discoverable via `which node`)*.

---

## 8. CLI Command Reference

| Command | Description |
| :--- | :--- |
| `npm run build` | Builds client assets and React Server Components using Vinext. |
| `npm run server` | Starts the production standalone Node.js server. |
| `npm run setup` | Interactive initialization wizard for fresh environments. |
| `npm run set-admin` | Resets administrator username and password with `scrypt-v1`. |
| `npm run db:backup` | Takes a local point-in-time SQLite snapshot and JSON exports. |
| `npm run db:backup:git` | Runs backup and pushes changes to the private GitHub repository with `[skip ci]`. |
| `npm run db:restore` | Restores default Donyagardi seed data. |
| `npm run db:restore:novavaran` | Restores Novavaran Rah Sepid historical data and activates the brand. |
| `npm run db:restore:all` | Restores all registered brands simultaneously. |
| `npm run brand:list` | Lists all configured offices and their active/draft statuses. |
| `npm run brand:add` | Interactively provisions a new brand in the database. |

---

## 9. Troubleshooting & FAQ

### Q: Why did an uploaded backup JSON do nothing in the web UI?
**A:** Prior to v0.260, the frontend strictly checked `[1, 2].includes(Number(backup.schemaVersion))`. Current backups use `schemaVersion: 3`. This has been resolved in `app/dashboard-client.tsx`.

### Q: Why was Novavaran stuck on "پیش‌نویس" (Draft)?
**A:** The brand activation logic previously blocked switching to `active` if Google Sheets credentials had not completed a live handshake. This validation has been decoupled so that manual financial records, budgets, and contractor costs are immediately active.

### Q: Will updating code via `git pull` wipe database changes?
**A:** No. `dashboard.sqlite` and the `data/backups/` directories are gitignored. Git does not track or overwrite live SQLite files.
