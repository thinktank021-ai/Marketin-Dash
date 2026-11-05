import { getD1 } from "../../../db";
import { repairTelegramSchema } from "../../telegram-schema";
import { decryptSecret, encryptSecret } from "../google-ads/service-account";
import { dispatchTelegramReports } from "../../telegram-report";
import { dispatchFailureMessage, dispatchResponseStatus, schedulerHealthError, telegramOperationError, schedulerSecretMatches } from "../../telegram-scheduler";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS telegram_bot_settings (
  id INTEGER PRIMARY KEY NOT NULL,
  bot_token_encrypted TEXT,
  chat_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  activation_requested INTEGER NOT NULL DEFAULT 0,
  change_alerts_enabled INTEGER NOT NULL DEFAULT 1,
  health_updates_enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 10,
  end_of_day_enabled INTEGER NOT NULL DEFAULT 1,
  normal_report_time TEXT NOT NULL DEFAULT '18:30',
  thursday_report_time TEXT NOT NULL DEFAULT '14:40',
  iran_holiday_calendar TEXT NOT NULL DEFAULT 'fixed',
  suppress_empty_morning INTEGER NOT NULL DEFAULT 1,
  last_bot_username TEXT,
  last_checked_at TEXT,
  last_report_status TEXT NOT NULL DEFAULT 'never',
  last_report_at TEXT,
  last_report_error TEXT,
  scheduler_secret_encrypted TEXT,
  scheduler_secret_previous_encrypted TEXT,
  scheduler_secret_previous_expires_at TEXT,
  last_scheduler_at TEXT,
  last_scheduler_status TEXT NOT NULL DEFAULT 'never',
  last_scheduler_error TEXT,
  automatic_suppressed_day TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
const CREATE_USERS = `CREATE TABLE IF NOT EXISTS telegram_bot_users (
  user_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
const CREATE_BRAND_SETTINGS = `CREATE TABLE IF NOT EXISTS telegram_brand_settings (
  brand_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

type TelegramRow = {
  botTokenEncrypted: string | null;
  chatId: string | null;
  enabled: number;
  activationRequested: number;
  changeAlertsEnabled: number;
  healthUpdatesEnabled: number;
  intervalMinutes: number;
  endOfDayEnabled: number;
  normalReportTime: string;
  thursdayReportTime: string;
  iranHolidayCalendar: string;
  suppressEmptyMorning: number;
  lastBotUsername: string | null;
  lastCheckedAt: string | null;
  lastReportStatus: string;
  lastReportAt: string | null;
  lastReportError: string | null;
  schedulerSecretEncrypted: string | null;
  schedulerSecretPreviousEncrypted: string | null;
  schedulerSecretPreviousExpiresAt: string | null;
  lastSchedulerAt: string | null;
  lastSchedulerStatus: string;
  lastSchedulerError: string | null;
};

async function db() {
  const d1 = getD1();
  await d1.prepare(CREATE_TABLE).run();
  await d1.prepare(CREATE_USERS).run();
  await d1.prepare(CREATE_BRAND_SETTINGS).run();
  // Do not discard a legacy recipient table or encrypted credentials.
  // Older scheduled dispatch created a minimal users table before admin settings loaded.
  await repairTelegramSchema(d1);
  return d1;
}

type TelegramUser = { userId: string; chatId: string; username: string; displayName: string; status: "pending" | "approved" | "rejected"; discoveredAt: string; approvedAt: string | null; lastSeenAt: string };

async function readUsers() {
  const rows = await (await db()).prepare(`SELECT user_id AS userId, chat_id AS chatId, username, display_name AS displayName, status,
    discovered_at AS discoveredAt, approved_at AS approvedAt, last_seen_at AS lastSeenAt
    FROM telegram_bot_users WHERE status <> 'rejected'
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, discovered_at DESC`).all<TelegramUser>();
  return rows.results || [];
}

async function readRow() {
  return (await db()).prepare(`SELECT bot_token_encrypted AS botTokenEncrypted, chat_id AS chatId,
    enabled, activation_requested AS activationRequested, change_alerts_enabled AS changeAlertsEnabled, health_updates_enabled AS healthUpdatesEnabled,
    interval_minutes AS intervalMinutes, end_of_day_enabled AS endOfDayEnabled,
    normal_report_time AS normalReportTime, thursday_report_time AS thursdayReportTime,
    iran_holiday_calendar AS iranHolidayCalendar, suppress_empty_morning AS suppressEmptyMorning,
    last_bot_username AS lastBotUsername, last_checked_at AS lastCheckedAt,
    last_report_status AS lastReportStatus, last_report_at AS lastReportAt, last_report_error AS lastReportError,
    scheduler_secret_encrypted AS schedulerSecretEncrypted,
    scheduler_secret_previous_encrypted AS schedulerSecretPreviousEncrypted,
    scheduler_secret_previous_expires_at AS schedulerSecretPreviousExpiresAt,
    last_scheduler_at AS lastSchedulerAt, last_scheduler_status AS lastSchedulerStatus, last_scheduler_error AS lastSchedulerError
    FROM telegram_bot_settings WHERE id = 1`).first<TelegramRow>();
}

function publicSettings(row: TelegramRow | null) {
  return {
    hasToken: Boolean(row?.botTokenEncrypted),
    chatId: row?.chatId || "",
    enabled: Boolean(row?.enabled),
    activationRequested: Boolean(row?.activationRequested),
    changeAlertsEnabled: row?.changeAlertsEnabled !== 0,
    healthUpdatesEnabled: row?.healthUpdatesEnabled !== 0,
    intervalMinutes: row?.intervalMinutes || 10,
    endOfDayEnabled: row?.endOfDayEnabled !== 0,
    normalReportTime: row?.normalReportTime || "18:30",
    thursdayReportTime: row?.thursdayReportTime || "14:40",
    iranHolidayCalendar: "fixed",
    suppressEmptyMorning: row?.suppressEmptyMorning !== 0,
    lastBotUsername: row?.lastBotUsername || "",
    lastCheckedAt: formatTehranTimestamp(row?.lastCheckedAt || null),
    lastReportStatus: row?.lastReportStatus || "never",
    lastReportAt: formatTehranTimestamp(row?.lastReportAt || null),
    lastReportError: row?.lastReportError || "",
    schedulerSecretSet: Boolean(row?.schedulerSecretEncrypted),
    lastSchedulerAt: formatTehranTimestamp(row?.lastSchedulerAt || null),
    schedulerStatus: row?.lastSchedulerStatus || "never",
    schedulerError: row?.lastSchedulerError || "",
  };
}

async function publicPayload(row: TelegramRow | null) {
  const users = await readUsers();
  const d1 = await db();
  const brands = await d1.prepare(`SELECT b.id AS brandId, b.name AS brandName, COALESCE(t.enabled, 0) AS enabled
    FROM dashboard_brands b LEFT JOIN telegram_brand_settings t ON t.brand_id = b.id
    WHERE b.config_status = 'active' ORDER BY b.is_default DESC, b.name`).all<{ brandId: string; brandName: string; enabled: number }>();
  return { ...publicSettings(row), users, approvedUserCount: users.filter(user => user.status === "approved").length, pendingUserCount: users.filter(user => user.status === "pending").length, brandSettings: (brands.results || []).map(brand => ({ brandId: brand.brandId, brandName: brand.brandName, enabled: brand.enabled === 1 })) };
}

function normalizeToken(value: unknown) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) return "";
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("telegram_token_invalid");
  return token;
}

async function telegramRequest(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json() as { ok?: boolean; result?: Record<string, unknown> | Array<Record<string, unknown>>; description?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.description || `telegram_${response.status}`);
  return payload.result;
}

async function storedToken() {
  const row = await readRow();
  if (!row?.botTokenEncrypted) throw new Error("telegram_token_missing");
  return { row, token: await decryptSecret(row.botTokenEncrypted) };
}

function newSchedulerSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function recordSchedulerHealth(status: "ok" | "error", error: string | null = null) {
  try {
    const d1 = await db();
    await d1.prepare(`UPDATE telegram_bot_settings SET last_scheduler_at = CURRENT_TIMESTAMP,
      last_scheduler_status = ?, last_scheduler_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
      .bind(status, error).run();
  } catch { /* Health telemetry must never hide the original scheduler result. */ }
}

// SQLite CURRENT_TIMESTAMP is UTC. Convert report timestamps at the API boundary
// so every dashboard user sees the actual Tehran time instead of server time.
function formatTehranTimestamp(value: string | null) {
  if (!value) return "";
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed.getTime())) return value;
  // Use the Persian calendar at the API boundary so every Telegram UI consumer
  // receives one stable Shamsi date format instead of reimplementing conversion.
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed).replace(",", " - ");
}

export async function GET() {
  try { return Response.json(await publicPayload(await readRow()), { headers: { "cache-control": "no-store" } }); }
  catch { return Response.json({ error: "تنظیمات Telegram دریافت نشد." }, { status: 500 }); }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const current = await readRow();
    const tokenInput = normalizeToken(body.botToken);
    let encrypted = current?.botTokenEncrypted || null;
    let botUsername = current?.lastBotUsername || "";
    if (tokenInput) {
      const me = await telegramRequest(tokenInput, "getMe") as { username?: string };
      encrypted = await encryptSecret(tokenInput);
      botUsername = me?.username || "";
    }
    const activationRequested = body.activationRequested === true;
    if (!encrypted && !activationRequested) throw new Error("telegram_token_missing");
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : current?.chatId || "";
    const enabled = body.enabled === true && Boolean(chatId) && Boolean(encrypted);
    const changeAlertsEnabled = body.changeAlertsEnabled !== false;
    const healthUpdatesEnabled = body.healthUpdatesEnabled !== false;
    const endOfDayEnabled = body.endOfDayEnabled !== false;
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    const normalReportTime = typeof body.normalReportTime === "string" && timePattern.test(body.normalReportTime) ? body.normalReportTime : "18:30";
    const thursdayReportTime = typeof body.thursdayReportTime === "string" && timePattern.test(body.thursdayReportTime) ? body.thursdayReportTime : "14:40";
    const suppressEmptyMorning = body.suppressEmptyMorning !== false;
    const d1 = await db();
    const intervalInput = Number(body.intervalMinutes);
    const intervalMinutes = Number.isInteger(intervalInput) && intervalInput >= 1 && intervalInput <= 360 ? intervalInput : 10;
    await d1.prepare(`INSERT INTO telegram_bot_settings
      (id, bot_token_encrypted, chat_id, enabled, activation_requested, change_alerts_enabled, health_updates_enabled, interval_minutes, end_of_day_enabled, normal_report_time, thursday_report_time, iran_holiday_calendar, suppress_empty_morning, last_bot_username, last_checked_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET bot_token_encrypted = excluded.bot_token_encrypted, chat_id = excluded.chat_id,
      enabled = excluded.enabled, activation_requested = excluded.activation_requested, change_alerts_enabled = excluded.change_alerts_enabled,
      health_updates_enabled = excluded.health_updates_enabled, interval_minutes = excluded.interval_minutes,
      end_of_day_enabled = excluded.end_of_day_enabled, normal_report_time = excluded.normal_report_time,
      thursday_report_time = excluded.thursday_report_time, iran_holiday_calendar = 'fixed',
      suppress_empty_morning = excluded.suppress_empty_morning,
      last_bot_username = excluded.last_bot_username, last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
      .bind(encrypted, chatId || null, enabled ? 1 : 0, activationRequested ? 1 : 0, changeAlertsEnabled ? 1 : 0, healthUpdatesEnabled ? 1 : 0,
        intervalMinutes, endOfDayEnabled ? 1 : 0, normalReportTime, thursdayReportTime, suppressEmptyMorning ? 1 : 0, botUsername || null).run();
    const brandSettings = Array.isArray(body.brandSettings) ? body.brandSettings as Array<{ brandId?: unknown; enabled?: unknown }> : [];
    for (const item of brandSettings) {
      if (typeof item.brandId !== "string" || !/^[a-z][a-z0-9-]{2,40}$/.test(item.brandId)) continue;
      await d1.prepare(`INSERT INTO telegram_brand_settings (brand_id, enabled, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(brand_id) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP`).bind(item.brandId, item.enabled === true ? 1 : 0).run();
    }
    return Response.json({ saved: true, settings: await publicPayload(await readRow()) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const diagnostic = telegramOperationError(error);
    return Response.json({ error: diagnostic.error, code: diagnostic.code }, {
      status: diagnostic.status, headers: { "cache-control": "no-store" },
    });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "test";
    if (action === "scheduler") {
      const secret = request.headers.get("x-telegram-scheduler-secret") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      const row = await readRow();
      const current = row?.schedulerSecretEncrypted ? await decryptSecret(row.schedulerSecretEncrypted) : null;
      const previous = row?.schedulerSecretPreviousEncrypted ? await decryptSecret(row.schedulerSecretPreviousEncrypted) : null;
      const authMode = secret ? schedulerSecretMatches(secret, current, previous, row?.schedulerSecretPreviousExpiresAt || null) : null;
      if (!authMode) {
        const error = schedulerHealthError("secret_mismatch");
        await recordSchedulerHealth("error", error);
        return Response.json({ error: "scheduler_unauthorized", code: "scheduler_secret_mismatch", message: error }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      await recordSchedulerHealth("ok", authMode === "grace" ? "کلید قبلی Scheduler در مهلت گذار استفاده شد؛ Code.gs را با کلید جدید جایگزین کنید." : null);
      try {
        const result = await dispatchTelegramReports(false);
        const reason = "reason" in result ? result.reason : undefined;
        const status = dispatchResponseStatus(result);
        if (status !== 200) await recordSchedulerHealth("error", `telegram_dispatch_${reason || "failed"}`);
        return Response.json({ ...result, error: dispatchFailureMessage(reason), schedulerAuth: authMode }, { status, headers: { "cache-control": "no-store" } });
      } catch (error) {
        const message = schedulerHealthError("dispatch_failed", error instanceof Error ? error.message.slice(0, 300) : undefined);
        await recordSchedulerHealth("error", message);
        throw error;
      }
    }
    if (action === "rotate_scheduler_secret") {
      const secret = newSchedulerSecret();
      const d1 = await db();
      const current = await readRow();
      const previousExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await d1.prepare(`UPDATE telegram_bot_settings SET scheduler_secret_previous_encrypted = ?,
        scheduler_secret_previous_expires_at = ?, scheduler_secret_encrypted = ?,
        last_scheduler_status = 'never', last_scheduler_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
        .bind(current?.schedulerSecretEncrypted || null, previousExpiry, await encryptSecret(secret)).run();
      return Response.json({ schedulerSecret: secret, settings: await publicPayload(await readRow()) }, { headers: { "cache-control": "no-store" } });
    }
    const stored = await storedToken();
    if (action === "discover") {
      const updates = await telegramRequest(stored.token, "getUpdates", { limit: 100, allowed_updates: ["message"] }) as Array<Record<string, unknown>>;
      const requests = (updates || []).filter(update => {
        const message = update.message as { text?: string; chat?: { id?: number | string } } | undefined;
        return Boolean(message?.chat?.id) && /^(\/start|\/connect)\b/i.test(message?.text || "");
      });
      // Process every queued connection request, not only the last one, so a
      // single discovery click gives the manager the complete pending queue.
      const d1 = await db();
      const seen = new Set<string>();
      let lastUpdateId = 0;
      for (const update of updates || []) {
        const updateId = Number(update.update_id || 0);
        if (updateId > lastUpdateId) lastUpdateId = updateId;
        const message = update.message as { from?: { id?: number | string; username?: string; first_name?: string; last_name?: string }; chat?: { id?: number | string; title?: string; username?: string; first_name?: string }; text?: string } | undefined;
        if (!message?.chat?.id || !/^(\/start|\/connect)\b/i.test(message.text || "")) continue;
        const chatId = String(message.chat.id);
        const from = message.from;
        const userId = from?.id === undefined ? chatId : String(from.id);
        if (seen.has(userId)) continue;
        seen.add(userId);
        const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || message.chat.title || message.chat.username || "کاربر Telegram";
        const username = from?.username || "";
        await d1.prepare(`INSERT INTO telegram_bot_users (user_id, chat_id, username, display_name, status, discovered_at, last_seen_at)
          VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, username = excluded.username, display_name = excluded.display_name,
          status = CASE WHEN telegram_bot_users.status = 'rejected' THEN 'pending' ELSE telegram_bot_users.status END,
          last_seen_at = CURRENT_TIMESTAMP`).bind(userId, chatId, username || null, displayName).run();
      }
      // Acknowledge the Telegram update queue after processing it. This keeps a
      // rejected user's old /start request from returning to the list later;
      // a new /start becomes visible only after the manager runs discovery again.
      if (lastUpdateId) await telegramRequest(stored.token, "getUpdates", { offset: lastUpdateId + 1, limit: 1, allowed_updates: ["message"] });
      await d1.prepare(`UPDATE telegram_bot_settings SET last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run();
      if (!requests.length) return Response.json({ error: "درخواست جدیدی پیدا نشد؛ ابتدا در Telegram برای بات /start یا /connect بفرستید." }, { status: 409 });
      const first = requests[requests.length - 1].message as { from?: { first_name?: string; last_name?: string }; chat?: { title?: string; username?: string } } | undefined;
      const chatTitle = [first?.from?.first_name, first?.from?.last_name].filter(Boolean).join(" ") || first?.chat?.title || first?.chat?.username || "کاربران جدید";
      return Response.json({ connected: false, chatTitle, discoveredCount: requests.length, settings: await publicPayload(await readRow()) });
    }
    if (action === "approve" || action === "reject") {
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!/^\d{1,30}$/.test(userId)) return Response.json({ error: "شناسه کاربر معتبر نیست." }, { status: 400 });
      const d1 = await db();
      const user = await d1.prepare("SELECT user_id AS userId FROM telegram_bot_users WHERE user_id = ?").bind(userId).first<{ userId: string }>();
      if (!user) return Response.json({ error: "این کاربر در فهرست شناسایی‌شده‌ها وجود ندارد." }, { status: 404 });
      if (action === "approve") {
        const count = await d1.prepare("SELECT COUNT(*) AS count FROM telegram_bot_users WHERE status = 'approved'").first<{ count: number }>();
        if ((count?.count || 0) >= 4) return Response.json({ error: "حداکثر ۴ کاربر Telegram قابل تأیید است." }, { status: 409 });
      }
      if (action === "reject") {
        // Rejected users are removed completely from the visible list. Their
        // old Telegram request was already acknowledged during discovery, so
        // they can return only by sending a new request and being rediscovered.
        await d1.prepare("DELETE FROM telegram_bot_users WHERE user_id = ?").bind(userId).run();
      } else {
        await d1.prepare("UPDATE telegram_bot_users SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE user_id = ?").bind(userId).run();
      }
      const firstApproved = await d1.prepare("SELECT chat_id AS chatId FROM telegram_bot_users WHERE status = 'approved' ORDER BY approved_at LIMIT 1").first<{ chatId: string }>();
      await d1.prepare("UPDATE telegram_bot_settings SET chat_id = ?, enabled = CASE WHEN ? IS NOT NULL AND bot_token_encrypted IS NOT NULL THEN enabled ELSE 0 END, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(firstApproved?.chatId || null, firstApproved?.chatId || null).run();
      return Response.json({ updated: true, settings: await publicPayload(await readRow()) });
    }
    // Manual dispatch uses the same report builder as the scheduled Worker,
    // making the button a real end-to-end verification instead of a fake toast.
    if (action === "dispatch") {
      const result = await dispatchTelegramReports(true);
      return Response.json({ ...result, error: dispatchFailureMessage("reason" in result ? result.reason : undefined), settings: await publicPayload(await readRow()) }, { status: dispatchResponseStatus(result), headers: { "cache-control": "no-store" } });
    }
    const row = stored.row;
    if (!row.chatId) return Response.json({ error: "ابتدا چت مقصد را با دکمهٔ شناسایی خودکار متصل کنید." }, { status: 409 });
    const approvedUsers = (await readUsers()).filter(user => user.status === "approved");
    if (!approvedUsers.length) return Response.json({ error: "ابتدا حداقل یک کاربر شناسایی‌شده را تأیید کنید." }, { status: 409 });
    await Promise.all(approvedUsers.map(user => telegramRequest(stored.token, "sendMessage", { chat_id: user.chatId, text: "🤖 اتصال بات داشبورد موفق است. این گفت‌وگو برای دریافت گزارش‌های همهٔ دفترهای فعال تأیید شده است." })));
    await (await db()).prepare(`UPDATE telegram_bot_settings SET last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run();
    return Response.json({ sent: true, settings: await publicPayload(await readRow()) });
  } catch (error) {
    const diagnostic = telegramOperationError(error);
    return Response.json({ error: diagnostic.error, code: diagnostic.code }, {
      status: diagnostic.status, headers: { "cache-control": "no-store" },
    });
  }
}
