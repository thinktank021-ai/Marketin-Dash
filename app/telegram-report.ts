import { getD1 } from "../db";
import { DEFAULT_DASHBOARD_RULES, normalizeCoreDashboardRules, type DashboardRules } from "./dashboard-rules";
import { canonicalRoute } from "./route-normalization";
import { decryptSecret, queryGoogleAds } from "./api/google-ads/service-account";
import { fetchGoogleText, parsePublishedMonths, readCsvCache, readMonthRegistryCache, saveCsvCache, saveMonthRegistryCache, sourceFingerprint } from "./api/brands/sheets";
import { selectCurrentReportMonth, type ReportPublishedMonth } from "./telegram-report-source";
import { formatReport, type TelegramReportBrand, type TelegramReportSummary } from "./telegram-report-format";

type TelegramRecipient = { userId: string; chatId: string; status: string };
type TelegramSettingsRow = {
  botTokenEncrypted: string | null;
  enabled: number;
  intervalMinutes: number;
  endOfDayEnabled: number;
  normalReportTime: string;
  thursdayReportTime: string;
  suppressEmptyMorning: number;
  lastReportAt: string | null;
  schedulerSecretEncrypted: string | null;
  automaticSuppressedDay: string | null;
};
type ReportBrand = TelegramReportBrand & { id: string; sheetCsvUrl: string; sheetIndexUrl: string; googleAdsCustomerId: string; googleAdsLoginCustomerId: string; telegramEnabled: number };
type ReportSummary = TelegramReportSummary;

const REPORT_TIME_ZONE = "Asia/Tehran";
const REPORT_TABLES = `
CREATE TABLE IF NOT EXISTS telegram_bot_settings (
  id INTEGER PRIMARY KEY NOT NULL,
  bot_token_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 10,
  end_of_day_enabled INTEGER NOT NULL DEFAULT 1,
  normal_report_time TEXT NOT NULL DEFAULT '18:30',
  thursday_report_time TEXT NOT NULL DEFAULT '14:40',
  suppress_empty_morning INTEGER NOT NULL DEFAULT 1,
  last_report_at TEXT,
  last_report_status TEXT NOT NULL DEFAULT 'never',
  last_report_error TEXT,
  scheduler_secret_encrypted TEXT,
  automatic_suppressed_day TEXT,
  telegram_update_offset INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS telegram_bot_users (
  user_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS telegram_report_dispatch_lock (
  id INTEGER PRIMARY KEY NOT NULL,
  locked_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_brand_settings (
  brand_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS telegram_report_brand_state (
  brand_id TEXT PRIMARY KEY NOT NULL,
  last_total_today INTEGER NOT NULL DEFAULT 0,
  last_report_day TEXT,
  last_report_at TEXT,
  last_sheet_at TEXT
);
CREATE TABLE IF NOT EXISTS telegram_official_holidays (
  date TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'official_iran_calendar'
)`;

// Official public holidays for the current Persian year. The table is deliberately
// persisted so a scheduler outage or a temporary network issue cannot change the
// decision after deployment; future years can be added without changing report code.
const CURRENT_IRAN_HOLIDAYS = [
  "1405/01/01", "1405/01/02", "1405/01/03", "1405/01/04", "1405/01/12", "1405/01/13", "1405/01/25",
  "1405/03/06", "1405/03/14", "1405/03/15", "1405/04/03", "1405/04/04", "1405/05/13", "1405/05/21",
  "1405/05/22", "1405/05/30", "1405/06/08", "1405/08/22", "1405/10/02", "1405/10/16", "1405/11/04",
  "1405/11/22", "1405/12/09", "1405/12/19", "1405/12/20", "1405/12/29",
];

/** Returns the current Tehran date, time, weekday, and a stable minute key for idempotent dispatches. */
function tehranNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: REPORT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long", hour12: false,
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return {
    date: `${pick("year")}/${pick("month")}/${pick("day")}`,
    time: `${pick("hour").padStart(2, "0")}:${pick("minute").padStart(2, "0")}`,
    weekday: pick("weekday"),
  };
}

/** Returns true for Friday or a persisted official Iranian public holiday. */
async function isIranNonWorkingDay(d1: D1Database, now: ReturnType<typeof tehranNow>) {
  if (now.weekday === "جمعه") return true;
  for (const date of CURRENT_IRAN_HOLIDAYS) {
    try { await d1.prepare("INSERT OR IGNORE INTO telegram_official_holidays (date) VALUES (?)").bind(date).run(); } catch { /* Legacy D1 can retry on the next scheduler tick. */ }
  }
  const holiday = await d1.prepare("SELECT 1 AS found FROM telegram_official_holidays WHERE date = ?").bind(now.date).first<{ found: number }>();
  return Boolean(holiday);
}

/** Parses CSV with quoted cells so Sheet notes and names containing commas remain intact. */
function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell.trim()); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "").trim()); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "").trim()); rows.push(row); }
  const headers = (rows.shift() || []).map(value => value.replace(/ي/g, "ی").replace(/ك/g, "ک"));
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

/** Normalizes Arabic/Persian digits and separators before comparing Sheet dates. */
function normalizeDate(value: string) {
  return value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)).replace(/[.-]/g, "/")).trim();
}

/** Applies the Sheet's block-date convention: a blank date inherits the latest explicit date above it. */
function withEffectiveDates(rows: Array<Record<string, string>>, dateColumn: string) {
  let activeDate = "";
  return rows.map(row => {
    const candidate = normalizeDate(row[dateColumn] || "");
    if (/^1\d{3}\/\d{1,2}\/\d{1,2}$/.test(candidate)) {
      const [year, month, day] = candidate.split("/");
      activeDate = `${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`;
    }
    return { row, effectiveDate: activeDate };
  });
}

/** Collapses spacing and Arabic/Persian typography differences for channel and outcome matching. */
function normalizeLabel(value: string) {
  return value.normalize("NFKC").replace(/ي|ى/g, "ی").replace(/ك/g, "ک").replace(/[\s\u200c_\-/،,+–—]+/g, "").toLocaleLowerCase("fa");
}

/** Loads persisted no-code rules, falling back safely when a legacy database has no rule row yet. */
async function rulesFor(d1: D1Database, brandId: string): Promise<DashboardRules> {
  const row = await d1.prepare("SELECT config_json AS configJson FROM brand_dashboard_rules WHERE brand_id = ?").bind(brandId).first<{ configJson: string }>();
  if (!row?.configJson) return DEFAULT_DASHBOARD_RULES;
  try { return normalizeCoreDashboardRules(JSON.parse(row.configJson)).rules; } catch { return normalizeCoreDashboardRules(DEFAULT_DASHBOARD_RULES).rules; }
}

/** Resolves a raw Sheet source to the report-facing channel name. */
function channelName(value: string, rules: DashboardRules) {
  const key = normalizeLabel(value);
  return rules.channels.find(channel => channel.enabled && channel.aliases.some(alias => normalizeLabel(alias) === key))?.name || (key === normalizeLabel("معرفی") ? "معرفی" : value.trim() || "منبع ثبت نشده");
}

/** Counts only rows that have a source, matching the dashboard's definition of a real lead. */
function summarizeRows(rows: Array<Record<string, string>>, rules: DashboardRules, today: string, sheetReceivedAt: string): ReportSummary {
  const dated = withEffectiveDates(rows, rules.sheetColumns.date).filter(item => Boolean(item.row[rules.sheetColumns.source]?.trim()));
  const month = today.slice(0, 7);
  const monthRows = dated.filter(item => item.effectiveDate.startsWith(month));
  const todayRows = monthRows.filter(item => item.effectiveDate === today);
  const summary = (items: typeof dated): Omit<ReportSummary, "stale"> => {
    const channels: Record<string, number> = {}, routes: Record<string, number> = {}, experts: Record<string, number> = {};
    let contracts = 0;
    items.forEach(({ row }) => {
      const source = channelName(row[rules.sheetColumns.source] || "", rules);
      channels[source] = (channels[source] || 0) + 1;
      const route = canonicalRoute(row[rules.sheetColumns.route] || "", rules.routes);
      if (route !== "مسیر ثبت نشده") routes[route] = (routes[route] || 0) + 1;
      const expert = (row[rules.sheetColumns.expert] || "").trim() || "کارشناس ثبت نشده";
      experts[expert] = (experts[expert] || 0) + 1;
      const outcome = normalizeLabel(row[rules.sheetColumns.outcome] || "");
      if (rules.contractOutcomes.some(value => normalizeLabel(value) === outcome)) contracts += 1;
    });
    return { totalToday: items.length, totalMonth: items.length, contractsToday: contracts, contractsMonth: contracts, channels, routes, experts, budgetToday: null, clicksToday: null, sheetReceivedAt, previousTotal: null, deltaToday: null };
  };
  const todaySummary = summary(todayRows), monthSummary = summary(monthRows);
  // Telegram reports are explicitly daily reports. Keep every displayed
  // breakdown aligned with today's total; month-level aggregates must never
  // leak into the daily message even though the source contains the full tab.
  return { totalToday: todaySummary.totalToday, totalMonth: monthSummary.totalMonth, contractsToday: todaySummary.contractsToday, contractsMonth: monthSummary.contractsMonth, channels: todaySummary.channels, routes: todaySummary.routes, experts: todaySummary.experts, budgetToday: null, clicksToday: null, sheetReceivedAt, previousTotal: null, deltaToday: null, stale: false };
}

/** Finds the live current-month tab through the published registry instead of guessing a sheet name. */
async function currentReportMonth(brand: ReportBrand, reportDate: string): Promise<ReportPublishedMonth> {
  let cached: Awaited<ReturnType<typeof readMonthRegistryCache>> = null;
  try { cached = brand.sheetIndexUrl ? await readMonthRegistryCache(brand.id, brand.sheetIndexUrl) : null; } catch { /* Refresh below. */ }
  const cachedMonth = selectCurrentReportMonth(cached?.months || [], reportDate);
  if (cached?.fresh && cachedMonth) return cachedMonth;
  if (!brand.sheetIndexUrl) throw new Error("sheet_month_registry_missing");
  try {
    const html = await fetchGoogleText(`${brand.sheetIndexUrl}?cachebust=${Date.now()}`, 20000);
    const months = parsePublishedMonths(html);
    if (!months.length) throw new Error("sheet_month_registry_empty");
    await saveMonthRegistryCache(brand.id, brand.sheetIndexUrl, months);
    const current = selectCurrentReportMonth(months, reportDate);
    if (current) return current;
  } catch (error) {
    if (cachedMonth) return cachedMonth;
    throw error;
  }
  if (cachedMonth) return cachedMonth;
  throw new Error(`sheet_current_month_not_found_${reportDate.slice(0, 7)}`);
}

/** Fetches the exact current Persian month by gid and preserves a same-source stale fallback. */
async function currentReportSheet(brand: ReportBrand, reportDate: string) {
  const month = await currentReportMonth(brand, reportDate);
  const selector = `gid=${month.gid}`;
  const cacheKey = `${brand.id}:${sourceFingerprint(brand.sheetCsvUrl)}:${selector}`;
  let cache: Awaited<ReturnType<typeof readCsvCache>> = null;
  try { cache = await readCsvCache(cacheKey, brand.id, brand.sheetCsvUrl); } catch { /* A remote fetch can still provide the report. */ }
  try {
    const csv = await fetchGoogleText(`${brand.sheetCsvUrl}&gid=${encodeURIComponent(month.gid)}&cachebust=${Date.now()}`, cache ? 8000 : 20000);
    if (/^\s*<!doctype html|^\s*<html|ServiceLogin|Sign in to continue/i.test(csv)) throw new Error("sheet_returned_html");
    await saveCsvCache(cacheKey, brand.id, brand.sheetCsvUrl, selector, csv);
    return { csv, stale: false, fetchedAt: "" };
  } catch (error) {
    if (cache) return { csv: cache.csv, stale: true, fetchedAt: cache.fetchedAt };
    throw error;
  }
}

function cacheTimeInTehran(value: string) {
  const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat("en-GB", { timeZone: REPORT_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(parsed))
    : "نامشخص";
}

/** Fetches the current Persian month from one brand's published Sheet and preserves stale-cache headers. */
async function summarizeBrand(brand: ReportBrand, now: ReturnType<typeof tehranNow>): Promise<ReportSummary> {
  const d1 = getD1();
  const rules = await rulesFor(d1, brand.id);
  const sheet = await currentReportSheet(brand, now.date);
  const receivedAt = sheet.stale && sheet.fetchedAt ? cacheTimeInTehran(sheet.fetchedAt) : new Intl.DateTimeFormat("en-GB", { timeZone: REPORT_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const result = summarizeRows(parseCsv(sheet.csv), rules, now.date, receivedAt);
  // Google Ads is queried independently per office; missing Ads credentials
  // never turns clicks or budget into fabricated zeros for another office.
  if (brand.googleAdsCustomerId) {
    try {
      const adsDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const adsRows = await queryGoogleAds(brand.id, brand.googleAdsCustomerId, brand.googleAdsLoginCustomerId, `SELECT metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date = '${adsDate}'`);
      result.clicksToday = adsRows.reduce((total, raw) => total + Number((raw as { metrics?: { clicks?: string | number } }).metrics?.clicks || 0), 0);
      result.budgetToday = adsRows.reduce((total, raw) => total + Number((raw as { metrics?: { costMicros?: string | number } }).metrics?.costMicros || 0) / 1_000_000, 0);
    } catch { /* A disconnected Ads account must not block the Sheet report. */ }
  }
  return { ...result, stale: sheet.stale };
}

/** Sends a Telegram message to every approved recipient and returns the delivery count. */
async function sendTelegram(token: string, chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }), signal: AbortSignal.timeout(15000) });
  const payload = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.description || `telegram_${response.status}`);
}

/** Reads bot commands so approved recipients can request a report without opening the dashboard. */
async function consumeManualReportCommand(token: string, d1: D1Database) {
  const row = await d1.prepare("SELECT telegram_update_offset AS offset FROM telegram_bot_settings WHERE id = 1").first<{ offset: number }>();
  const offset = Number(row?.offset || 0);
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: offset || undefined, limit: 100, allowed_updates: ["message"] }), signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json() as { ok?: boolean; result?: Array<Record<string, unknown>>; description?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.description || `telegram_${response.status}`);
  let nextOffset = offset;
  let manualRequested = false;
  for (const update of payload.result || []) {
    const updateId = Number(update.update_id || 0);
    if (updateId >= nextOffset) nextOffset = updateId + 1;
    const message = update.message as { text?: string; from?: { id?: number | string } } | undefined;
    if (!/^\/report(?:@[^\s]+)?\b/i.test(message?.text || "") || message?.from?.id === undefined) continue;
    const approved = await d1.prepare("SELECT 1 AS ok FROM telegram_bot_users WHERE user_id = ? AND status = 'approved'").bind(String(message.from.id)).first<{ ok: number }>();
    if (approved) manualRequested = true;
  }
  if (nextOffset > offset) await d1.prepare("UPDATE telegram_bot_settings SET telegram_update_offset = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(nextOffset).run();
  return manualRequested;
}

/** Determines whether the configured interval or the configured end-of-day report is due. */
function isDue(settings: TelegramSettingsRow, now: ReturnType<typeof tehranNow>) {
  if (!settings.lastReportAt) return true;
  const last = Date.parse(settings.lastReportAt.replace(" ", "T") + "Z");
  const elapsed = Number.isFinite(last) ? Date.now() - last : Number.POSITIVE_INFINITY;
  const intervalDue = elapsed >= Math.max(1, settings.intervalMinutes || 10) * 60_000;
  const configuredTime = now.weekday === "پنجشنبه" ? settings.thursdayReportTime : settings.normalReportTime;
  return intervalDue || (settings.endOfDayEnabled !== 0 && now.time === configuredTime);
}

/** Runs one idempotent scheduled dispatch; the Worker scheduled handler and manual API both use this function. */
export async function dispatchTelegramReports(force = false) {
  const d1 = getD1();
  // Keep legacy production databases self-healing while creating the tiny
  // lease table that prevents two cron invocations sending the same report.
  for (const statement of REPORT_TABLES.split(";").map(value => value.trim()).filter(Boolean)) {
    try { await d1.prepare(statement).run(); } catch { /* Legacy columns are added below without breaking old deployments. */ }
  }
  try { await d1.prepare("ALTER TABLE telegram_bot_settings ADD COLUMN scheduler_secret_encrypted TEXT").run(); } catch { /* Column already exists. */ }
  try { await d1.prepare("ALTER TABLE telegram_bot_settings ADD COLUMN automatic_suppressed_day TEXT").run(); } catch { /* Column already exists. */ }
  try { await d1.prepare("ALTER TABLE telegram_bot_settings ADD COLUMN telegram_update_offset INTEGER NOT NULL DEFAULT 0").run(); } catch { /* Column already exists. */ }
  try { await d1.prepare("ALTER TABLE telegram_report_brand_state ADD COLUMN last_report_day TEXT").run(); } catch { /* Column already exists. */ }
  const leaseUntil = Date.now() + 120_000;
  const lock = await d1.prepare(`INSERT INTO telegram_report_dispatch_lock (id, locked_until) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET locked_until = excluded.locked_until
    WHERE telegram_report_dispatch_lock.locked_until <= ? RETURNING id`).bind(leaseUntil, Date.now()).first<{ id: number }>();
  if (!lock) return { sent: false, reason: "already_running" };
  try {
  const settings = await d1.prepare(`SELECT bot_token_encrypted AS botTokenEncrypted, enabled, interval_minutes AS intervalMinutes,
    end_of_day_enabled AS endOfDayEnabled, normal_report_time AS normalReportTime, thursday_report_time AS thursdayReportTime,
    suppress_empty_morning AS suppressEmptyMorning, last_report_at AS lastReportAt,
    automatic_suppressed_day AS automaticSuppressedDay FROM telegram_bot_settings WHERE id = 1`).first<TelegramSettingsRow>();
  if (!settings?.botTokenEncrypted || settings.enabled !== 1) return { sent: false, reason: "disabled" };
  const token = await decryptSecret(settings.botTokenEncrypted);
  const commandRequested = !force ? await consumeManualReportCommand(token, d1) : false;
  const now = tehranNow();
  const manual = force || commandRequested;
  if (!manual && await isIranNonWorkingDay(d1, now)) return { sent: false, reason: "iran_non_working_day" };
  if (!manual && !isDue(settings, now)) return { sent: false, reason: "not_due" };
  const brands = await d1.prepare(`SELECT b.id, b.name, b.sheet_csv_url AS sheetCsvUrl, b.sheet_index_url AS sheetIndexUrl,
    b.google_ads_customer_id AS googleAdsCustomerId, b.google_ads_login_customer_id AS googleAdsLoginCustomerId,
    COALESCE(t.enabled, 0) AS telegramEnabled
    FROM dashboard_brands b LEFT JOIN telegram_brand_settings t ON t.brand_id = b.id
    WHERE b.config_status = 'active' AND b.sheet_csv_url != '' AND COALESCE(t.enabled, 0) = 1
    ORDER BY b.is_default DESC, b.name`).all<ReportBrand>();
  const sourceFailures: string[] = [];
  const summaries = (await Promise.all((brands.results || []).map(async brand => {
    try { return { brand, summary: await summarizeBrand(brand, now) }; }
    catch (error) {
      // Never print a source URL, token or passenger data in report diagnostics.
      const code = error instanceof Error ? error.message : "";
      const safeCode = /^(sheet_[a-z0-9_]+|sheet_current_month_not_found_\d{4}\/\d{2})$/.test(code)
        ? code : "source_fetch_failed";
      sourceFailures.push(`${brand.id}: ${safeCode}`);
      return null;
    }
  }))).filter(Boolean) as Array<{ brand: ReportBrand; summary: ReportSummary }>;
  if (!summaries.length) {
    const reason = (brands.results || []).length ? "source_unavailable" : "no_enabled_brands";
    await d1.prepare("UPDATE telegram_bot_settings SET last_report_status = 'error', last_report_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .bind(sourceFailures.length ? sourceFailures.join("; ").slice(0, 500) : reason).run();
    return { sent: false, reason };
  }
  if (sourceFailures.length) {
    // A partially successful brand load must never look like a complete multi-brand report.
    await d1.prepare("UPDATE telegram_bot_settings SET last_report_status = 'error', last_report_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .bind(sourceFailures.join("; ").slice(0, 500)).run();
    return { sent: false, reason: "source_unavailable" };
  }
  if (!manual && settings.automaticSuppressedDay === now.date) return { sent: false, reason: "empty_workday_window" };
  if (!manual && settings.suppressEmptyMorning !== 0 && now.time < "11:00" && summaries.every(item => item.summary.totalToday === 0)) return { sent: false, reason: "empty_morning" };
  if (!manual && settings.suppressEmptyMorning !== 0 && now.time >= "11:00" && summaries.every(item => item.summary.totalToday === 0)) {
    await d1.prepare("UPDATE telegram_bot_settings SET automatic_suppressed_day = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(now.date).run();
    return { sent: false, reason: "empty_workday_window" };
  }
  const recipients = await d1.prepare("SELECT user_id AS userId, chat_id AS chatId, status FROM telegram_bot_users WHERE status = 'approved' ORDER BY approved_at").all<TelegramRecipient>();
  if (!recipients.results?.length) return { sent: false, reason: "no_recipients" };
  const withState = await Promise.all(summaries.map(async item => {
    const state = await d1.prepare("SELECT last_total_today AS lastTotalToday, last_report_day AS lastReportDay FROM telegram_report_brand_state WHERE brand_id = ?").bind(item.brand.id).first<{ lastTotalToday: number; lastReportDay: string | null }>();
    const previousTotal = state?.lastReportDay === now.date ? Number(state.lastTotalToday || 0) : null;
    return { ...item, summary: { ...item.summary, previousTotal, deltaToday: previousTotal === null ? null : item.summary.totalToday - previousTotal } };
  }));
  const text = formatReport(withState, now, manual ? "manual" : now.time === (now.weekday === "پنجشنبه" ? settings.thursdayReportTime : settings.normalReportTime) ? "end_of_day" : "instant");
  try {
    for (const recipient of recipients.results) await sendTelegram(token, recipient.chatId, text);
    for (const item of withState) await d1.prepare(`INSERT INTO telegram_report_brand_state (brand_id, last_total_today, last_report_day, last_report_at, last_sheet_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(brand_id) DO UPDATE SET last_total_today = excluded.last_total_today, last_report_day = excluded.last_report_day,
      last_report_at = CURRENT_TIMESTAMP, last_sheet_at = excluded.last_sheet_at`).bind(item.brand.id, item.summary.totalToday, now.date, item.summary.sheetReceivedAt).run();
    await d1.prepare("UPDATE telegram_bot_settings SET last_report_status = 'success', last_report_at = CURRENT_TIMESTAMP, last_report_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run();
    return { sent: true, recipients: recipients.results.length, brands: summaries.length };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "telegram_send_failed";
    await d1.prepare("UPDATE telegram_bot_settings SET last_report_status = 'error', last_report_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(message).run();
    throw error;
  }
  } finally {
    // Release only our own lease: a slow execution must not unlock a newer scheduler run.
    try {
      await d1.prepare("DELETE FROM telegram_report_dispatch_lock WHERE id = 1 AND locked_until = ?")
        .bind(leaseUntil).run();
    } catch {
      // Keep the original dispatch result; the lease will expire by itself.
    }
  }
}
