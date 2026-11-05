# Telegram reporting bot — production runbook
Date: 2026-11-05 (UTC). Repo: https://github.com/thinktank021-ai/Marketin-Dash

## Scope and current status
This guide describes configuration and verification. A code PR does **not** activate a live bot or remote scheduler. Credentials, production D1 state, actual Telegram API availability, trigger deployment and Google Sheets permissions cannot be inferred from GitHub source.

## Components
- `app/api/telegram-bot/route.ts`: token, discovery, up to four approved recipients, per-brand opt-in, scheduler authentication and manual dispatch.
- `app/telegram-report.ts`: current Jalali month Sheet, validated cache fallback, daily summary, sendMessage, dispatch locking, Telegram /report commands.
- `app/telegram-scheduler.ts`: rotation grace and safe health/status mapping.
- `app/telegram-bot-settings-card.tsx`: admin UI and generated Apps Script code.
- `worker/index.ts`: Cloudflare cron scheduled handler (requires an actual configured trigger).
- `drizzle/0017_telegram_bot_settings.sql` and `0018_telegram_schedule_settings.sql`: legacy schema migrations.

## Activation checklist (do not paste secrets in GitHub)
1. Deploy the reviewed build and verify database migrations and the `DB` D1/SQLite binding on the *actual environment*.
2. Verify encryption configuration `GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY` is available at runtime; inspect only presence, never its value. A change of key can make stored encrypted bot token/secret unreadable.
3. In dashboard Telegram settings, enter a valid BotFather token, save it and verify the bot name. Send `/start` to the bot in a private Telegram chat, click **Discover users**, approve the intended recipients (maximum four).
4. Enable only the intended active brand(s), verify each brand's Google Sheets URL and published current Persian month and valid numeric `gid`. Brands must be isolated. Refresh the Sheet registry if a new month is missing. Check the bot has permission to send messages.
5. Enable automatic delivery and save. Use **Send test message** to verify outbound Telegram; use **Send real report now** to check Sheets-to-Telegram end-to-end. For failures consult the dashboard's last report error.
6. Choose **one** scheduler source per deployment:
   - **Google Apps Script** (portable, recommended for Node/VPS/cPanel): Generate a scheduler secret, copy the generated `Code.gs` into Apps Script, run once to authorize, configure a time-driven trigger every minute. Inspect Apps Script Executions; HTTP 200 with `sent:false,reason:not_due` is a valid idle tick, not proof of actual delivery.
   - **Cloudflare Workers**: Ensure a cron trigger is actually configured on the deployed Worker and verify scheduled invocation logs. A `scheduled()` function in code is not enough by itself.
   - **Node/VPS/cPanel**: `server.js` starts a web server only and **does not run a background scheduler**. Use the external Apps Script trigger or a managed cron with an authenticated POST request. Never embed secrets in URLs or Git history.
7. Verify one actual `sent:true` outcome, expected recipient count, report date/time in Asia/Tehran, and exact brand segmentation; recheck once interval time elapses. Observe stale-cache warning when source fails, rather than fake zeros.

## Expected API responses (POST /api/telegram-bot, action=scheduler, authenticated with x-telegram-scheduler-secret)
- `200 { sent:true, ... }`: an actual report was delivered.
- `200 { sent:false, reason:"not_due" }`: trigger worked, but no scheduled delivery is due.
- `200 { sent:false, reason:"already_running" }`: another invocation has the lease.
- `200 { sent:false, reason:"iran_non_working_day" }`: deliberate calendar skip.
- `200 { sent:false, reason:"empty_morning" }` or `empty_workday_window`: deliberate empty-window skip.
- `409 ... reason:"disabled" | "no_recipients" | "no_enabled_brands"`: incomplete setup.
- `503 ... reason:"source_unavailable"`: one or more opted-in brands failed source validation; no partial multi-brand message sent.
- `401 ... code:"scheduler_secret_mismatch"`: reconfigure the scheduler secret.
- `400/500`: inspect sanitized app/Worker logs and database schema; no token, URL, or personal data should be logged.

## Common failure causes
- Wrong scheduler endpoint, DNS, Access protection, token mismatch, missing App Script authorization, or disabled trigger.
- Telegram bot token invalid/revoked, recipients never approved, recipient blocked the bot, or webhook/getUpdates conflict.
- No opted-in active brand, missing D1 tables/columns, wrong `DB` binding, unavailable encryption key.
- Unpublished or malformed Google Sheets CSV, current Persian month not discoverable, source returning HTML, or upstream timeout.
- VPS/cPanel process up but no external scheduler. A successful page load is **not** proof of cron delivery.

## Security and rollback
- Keep bot token and scheduler secret only in encrypted storage and protected scheduler settings; never commit secrets, console dumps, CSV payloads or Telegram user IDs.
- Do not fabricate zero on upstream failure. The fallback must be the last validated same-brand/same-source cache only.
- Roll back the dedicated PR if an unexpected regression is detected; retain D1 backups and avoid destructive migrations. Validate tests and deployments before merging.

## cPanel / Passenger activation — 2026-11-05

**Runtime verification before starting scheduler**
1. In cPanel **Setup Node.js App**, verify application root points to the deployed repo and startup is `server.js` or the configured Passenger `loader.cjs`. Use **Node.js >= 22.13** (the installed project uses `node:sqlite`). Restart only after deployment and back up the live SQLite file and its WAL/SHM state safely.
2. Verify deployment contains `dist/` and uses the same existing SQLite database (`DATABASE_FILE` or `data/dashboard.sqlite` relative to application root). Do **not** rerun `npm run setup` on an established installation: `scripts/setup-wizard.mjs` overwrites `.env`, generates a **new encryption key**, and may reset admin credentials.
3. Confirm `GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY` exists in cPanel Environment Variables or the protected `.env`. Preserve the **exact existing value**: older setup wizard generates 64 hexadecimal characters; updated runtime accepts both this legacy format and base64 for the same 32 bytes. **Never regenerate a key for an existing database.**
4. In the dashboard admin UI, open the Telegram card; confirm the bot token is saved, selected brands are explicitly opted in, and at least one Telegram user is approved (maximum four). Clicking **Send test message** proves only bot delivery, not Google Sheets reads.
5. Click **Send real report now** and confirm the message arrived with correct brand counts. If it fails, read **Last report status/error** in the card; for a blocked or stale current-month Sheet, repair the published Sheet before activating a cron.
6. Set a single external time trigger. Recommended for cPanel: Google Apps Script (script snippet generated by the dashboard). Paste the code in a **private** Apps Script project, save, authorize a one-time Run and configure **Time-driven / Every minute**. The script's `SECRET` is sensitive; do not copy it into GitHub or public logs. Do not duplicate the trigger with cPanel cron unless intentionally implementing a supervised failover.
7. In Apps Script **Executions**, distinguish HTTP 200 idle responses from `sent:true`; after enabling Telegram and opting in brand(s), wait for a due interval and verify both an actual received Telegram message and a fresh scheduler timestamp in the dashboard.

**HTTP diagnostic interpretation**
- 401 means Scheduler secret mismatch or wrong server deployment; rotate using the dashboard and replace the Apps Script secret.
- 403/redirect/HTML login indicates domain, application authentication, WAF or proxy rules intercepting the scheduler route. The scheduler must reach the actual app API, not a cPanel login page.
- 409 means configuration incomplete (disabled, no approved recipients or no enabled brands); resolve it in the UI.
- 503 with `source_unavailable` means source data validation failed and no partial-brand Telegram report was sent. Inspect the safely recorded last report error.
- 200 with `not_due` (or `empty_morning`, `iran_non_working_day`) is normal. Only `sent:true` proves a report was sent to all approved recipients.

**cPanel path/persistence warnings**
- `.cpanel.yml` installs/builds/restarts the web application; it does not create an Apps Script trigger, cPanel cron, or guarantee background execution.
- The Node.js app must be able to write to the persistent SQLite directory and its WAL/SHM files. Do not store production secrets or the persistent database in a deployment directory that will be overwritten.
- The dashboard is standalone: Cloudflare's `scheduled()` is **never invoked by Passenger**.

## Failed test-message triage — confirmed 2026-11-05 on cPanel

**Observed:** cPanel Node application `Started (v22.23.4)`, Telegram **test message fails**, and manual real report also fails. This means diagnosing Apps Script cron or Sheet aggregation first would be premature; the test message does not use Google Sheets.

Do these read-only checks in order, without sending any secrets or chat IDs:
1. In the dashboard Telegram card, record whether **Bot recognized** shows an @username, whether a token is saved, whether at least one recipient shows **Approved**, and the **exact displayed error text** after **Send test message**. If these metadata fields do not load, investigate the cPanel API and SQLite schema first.
2. If the test button returns **APP_LOGIN_REQUIRED** or HTTP **401** from the dashboard, reauthenticate in the dashboard (not BotFather). If it returns a Telegram-token-related code such as `telegram_token_rejected`, validate/reenter the token **only in the authenticated dashboard**.
3. If it returns `encryption_configuration` or `credential_decryption_failed`, verify that `GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY` has **exactly the same value as when this SQLite database was populated**. The database contains encrypted tokens; do not generate a replacement key, share its value, or run `npm run setup` again.
4. If it returns `database_unavailable`, verify `DATABASE_FILE` and SQLite write permissions in the same deployed Passenger application. Back up first; avoid deleting/overwriting any database file.
5. If it returns `telegram_recipient_forbidden`, have the intended recipient open the bot and send `/start`, then retry. If no one is approved, run discovery, approve an intended user and retry. Never add Telegram IDs to issue/PR logs.
6. If it returns `upstream_unavailable`, ask the hosting operator to verify **outbound HTTPS to api.telegram.org** and DNS from the running Node environment. Avoid public curl commands containing the bot token.
7. If the dashboard still shows the older generic error message, check whether **PR #2 has actually been merged and deployed**, and whether cPanel Passenger restarted the new build. A GitHub PR does not update cPanel on its own.

**Checkpoint:** a delivered Telegram test message is required before testing **Send real report now**; an actual delivered real report is required before enabling Google Apps Script automation. The code and document changes do not by themselves prove production activation.

## Specific save-settings error identified — 2026-11-05

If the dashboard displays **«اتصال Telegram برقرار نشد؛ توکن را بررسی کنید»**, this exact text originates from the **PUT /api/telegram-bot** legacy save-settings catch block, not from the manual test-message POST path. Do not conclude that BotFather token is invalid from this message alone.

On an existing cPanel SQLite install, the scheduled report module may have created a legacy 3-column `telegram_bot_users` table, while the admin API requires additional user metadata columns. This version of the PR adds non-destructive `repairTelegramSchema()`, preserving recipient approvals and encrypted settings; other causes (wrong encryption key, Telegram API failure, old build, inaccessible database) remain possible.

**Safe pre-deploy checklist**
1. Back up the *current persistent SQLite database* with a consistent backup mechanism, including any WAL state. Record a secret-free release identifier and a rollback path. Never share the backup.
2. Preserve the current `GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY` value **unchanged**. Do not invoke `npm run setup` on an existing installation.
3. Review and merge PR #2 only after `tests/telegram-schema.test.mjs`, `tests/encryption-key-format.test.mjs` and `tests/telegram-scheduler.test.mjs` plus build/tests pass.
4. Deploy new `main` to the existing cPanel application root, run normal build and restart Passenger. Confirm the live release actually includes the new code; a merged PR alone does not restart cPanel.
5. In Telegram settings, try **Save settings** with an existing token (no need to re-enter). If it fails, capture only returned error code/text (not headers, payloads or secrets).
6. If save succeeds, perform **Send test message**. Only after it arrives, try **Send real report now**; then enable Apps Script trigger and verify a scheduled real delivery.

## cPanel deployment blocker found in actual GitHub Actions logs — 2026-11-05

- Historical failed run: [cPanel deploy run 41342418455](https://github.com/thinktank021-ai/Marketin-Dash/actions/runs/41342418455).
- Source-backed finding: the server-side `vinext build` completed successfully, then the workflow's broad `pkill -u ... -f node` terminated the SSH action itself; the job finished with SIGTERM/exit 143.
- Remediation committed in this Telegram recovery PR: `.github/workflows/deploy.yml` **no longer executes broad process termination**, and uses Passenger's per-app `tmp/restart.txt` marker only.
- The same workflow previously reset administrator credentials on every deploy using a hard-coded command. That step was removed so deploy preserves current credentials. **Previously exposed credentials require secure out-of-band rotation by the operator**; removing the step does not erase Git history. No credentials are reproduced in this runbook.
- Guardrail: `tests/cpanel-deploy-safety.test.mjs` and Telegram CI validate those two workflow invariants.
- PR checks are not the live cPanel deployment. The first fresh `main` deploy run after approved merge must have **success** status, followed by manual verification of the running app and test Telegram message. If SSH still fails, inspect that run's *sanitized* log before retrying.
