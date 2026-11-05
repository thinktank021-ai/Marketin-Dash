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
