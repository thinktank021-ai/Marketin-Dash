"use client";

import { useEffect, useState } from "react";

type TelegramSettings = {
  hasToken: boolean;
  chatId: string;
  enabled: boolean;
  activationRequested: boolean;
  changeAlertsEnabled: boolean;
  healthUpdatesEnabled: boolean;
  intervalMinutes: number;
  endOfDayEnabled: boolean;
  normalReportTime: string;
  thursdayReportTime: string;
  iranHolidayCalendar: string;
  suppressEmptyMorning: boolean;
  lastBotUsername: string;
  lastCheckedAt: string;
  lastReportStatus: string;
  lastReportAt: string;
  lastReportError: string;
  lastSchedulerAt: string;
  schedulerStatus: string;
  schedulerError: string;
  users: TelegramUser[];
  approvedUserCount: number;
  pendingUserCount: number;
  schedulerSecretSet: boolean;
  brandSettings: Array<{ brandId: string; brandName: string; enabled: boolean }>;
};

type TelegramUser = { userId: string; chatId: string; username: string; displayName: string; status: "pending" | "approved" | "rejected"; discoveredAt: string; approvedAt: string | null; lastSeenAt: string };

const EMPTY: TelegramSettings = { hasToken: false, chatId: "", enabled: false, activationRequested: false, changeAlertsEnabled: true, healthUpdatesEnabled: true, intervalMinutes: 10, endOfDayEnabled: true, normalReportTime: "18:30", thursdayReportTime: "14:40", iranHolidayCalendar: "fixed", suppressEmptyMorning: true, lastBotUsername: "", lastCheckedAt: "", lastReportStatus: "never", lastReportAt: "", lastReportError: "", lastSchedulerAt: "", schedulerStatus: "never", schedulerError: "", users: [], approvedUserCount: 0, pendingUserCount: 0, schedulerSecretSet: false, brandSettings: [] };

export function TelegramBotSettingsCard() {
  const [settings, setSettings] = useState<TelegramSettings>(EMPTY);
  const [botToken, setBotToken] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "testing" | "error">("loading");
  const [message, setMessage] = useState("در حال دریافت تنظیمات بات…");
  const [schedulerSecret, setSchedulerSecret] = useState("");

  const load = async () => {
    try {
      const response = await fetch("/api/telegram-bot", { cache: "no-store" });
      const payload = await response.json() as TelegramSettings & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error || "تنظیمات بات دریافت نشد.");
      setSettings(payload); setStatus("ready"); setMessage(payload.hasToken ? "توکن بات ذخیره و آمادهٔ آزمایش است." : "برای شروع، بات Telegram را بسازید و توکن آن را وارد کنید.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "تنظیمات بات دریافت نشد."); }
  };
  // Defer the first state update until after the initial client render so the
  // settings card does not trigger a synchronous effect-render cascade.
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);

  const save = async () => {
    setStatus("saving"); setMessage("در حال اعتبارسنجی و ذخیرهٔ امن اتصال بات…");
    try {
      const response = await fetch("/api/telegram-bot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ botToken, chatId: settings.chatId, enabled: settings.enabled, activationRequested: settings.activationRequested, intervalMinutes: settings.intervalMinutes, changeAlertsEnabled: settings.changeAlertsEnabled, healthUpdatesEnabled: settings.healthUpdatesEnabled, endOfDayEnabled: settings.endOfDayEnabled, normalReportTime: settings.normalReportTime, thursdayReportTime: settings.thursdayReportTime, suppressEmptyMorning: settings.suppressEmptyMorning, brandSettings: settings.brandSettings }) });
      const payload = await response.json() as { settings?: TelegramSettings; error?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "اتصال بات ذخیره نشد.");
      setSettings(payload.settings); setBotToken(""); setStatus("ready"); setMessage("توکن بات با موفقیت ذخیره شد؛ حالا چت مقصد را شناسایی کنید.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "اتصال بات ذخیره نشد."); }
  };

  const discover = async () => {
    setStatus("testing"); setMessage("حالا در Telegram به بات /start یا /connect بفرستید؛ در حال شناسایی چت…");
    try {
      const response = await fetch("/api/telegram-bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "discover" }) });
      const payload = await response.json() as { settings?: TelegramSettings; error?: string; chatTitle?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "چت مقصد شناسایی نشد.");
      setSettings(payload.settings); setStatus("ready"); setMessage(`کاربر «${payload.chatTitle || "کاربر Telegram"}» شناسایی شد؛ برای دریافت گزارش هنوز باید از همین‌جا تأیید شود.`);
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "چت مقصد شناسایی نشد."); }
  };

  const test = async () => {
    setStatus("testing"); setMessage("در حال ارسال پیام آزمایشی…");
    try {
      const response = await fetch("/api/telegram-bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "test" }) });
      const payload = await response.json() as { settings?: TelegramSettings; error?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "پیام آزمایشی ارسال نشد.");
      setSettings(payload.settings); setStatus("ready"); setMessage("پیام آزمایشی با موفقیت ارسال شد.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "پیام آزمایشی ارسال نشد."); }
  };

  // Sends one real report immediately, which gives the manager a safe way to
  // verify the final format without waiting for the next scheduled tick.
  const dispatch = async () => {
    setStatus("testing"); setMessage("در حال ساخت و ارسال گزارش واقعی…");
    try {
      const response = await fetch("/api/telegram-bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dispatch" }) });
      const payload = await response.json() as { settings?: TelegramSettings; error?: string; sent?: boolean };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "گزارش خودکار ارسال نشد.");
      setSettings(payload.settings); setStatus("ready"); setMessage(payload.sent ? "گزارش واقعی با موفقیت ارسال شد." : "ارسال گزارش انجام نشد؛ وضعیت اتصال و زمان‌بندی را بررسی کنید.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "گزارش خودکار ارسال نشد."); }
  };

  // Generates a one-time scheduler secret without exposing the encrypted value
  // again through the normal settings response.
  const rotateSchedulerSecret = async () => {
    setStatus("testing"); setMessage("در حال ساخت کلید امن Scheduler…");
    try {
      const response = await fetch("/api/telegram-bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rotate_scheduler_secret" }) });
      const payload = await response.json() as { schedulerSecret?: string; settings?: TelegramSettings; error?: string };
      if (!response.ok || !payload.schedulerSecret || !payload.settings) throw new Error(payload.error || "کلید Scheduler ساخته نشد.");
      setSchedulerSecret(payload.schedulerSecret); setSettings(payload.settings); setStatus("ready"); setMessage("کلید Scheduler ساخته شد؛ آن را فقط در Apps Script ذخیره کنید.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "کلید Scheduler ساخته نشد."); }
  };

  const moderateUser = async (userId: string, action: "approve" | "reject") => {
    setStatus("testing"); setMessage(action === "approve" ? "در حال تأیید دسترسی کاربر…" : "در حال رد دسترسی کاربر…");
    try {
      const response = await fetch("/api/telegram-bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, userId }) });
      const payload = await response.json() as { settings?: TelegramSettings; error?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "تغییر دسترسی انجام نشد.");
      setSettings(payload.settings); setStatus("ready"); setMessage(action === "approve" ? "دسترسی کاربر تأیید شد؛ از این پس گزارش‌ها برای او هم ارسال می‌شود." : "دسترسی کاربر رد شد و هیچ گزارشی برای او ارسال نمی‌شود.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "تغییر دسترسی انجام نشد."); }
  };

  const canSave = status !== "saving" && status !== "testing" && (Boolean(botToken) || settings.hasToken);
  const schedulerEndpoint = typeof window === "undefined" ? "https://YOUR-DASHBOARD-URL/api/telegram-bot" : `${window.location.origin}/api/telegram-bot`;
  const schedulerCode = `const ENDPOINT = "${schedulerEndpoint}";
const SECRET = "${schedulerSecret}";
function runDashboardTelegramScheduler() {
  const response = UrlFetchApp.fetch(ENDPOINT, {
    method: "post",
    contentType: "application/json",
    headers: { "x-telegram-scheduler-secret": SECRET },
    payload: JSON.stringify({ action: "scheduler" }),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  Logger.log("Dashboard scheduler response: " + status + " " + body);
  if (status === 401) throw new Error("Scheduler secret mismatch: create a new key in the dashboard and replace SECRET in Code.gs.");
  if (status < 200 || status >= 300) throw new Error("Dashboard scheduler failed with HTTP " + status);
}`;
  const schedulerGuide = [
    "این اتصال دو بخش دارد: Apps Script فقط هر دقیقه یک درخواست بیدارباش می‌فرستد و داشبورد زمان‌بندی و ارسال Telegram را کنترل می‌کند.",
    "۱) کد نمایش‌داده‌شده را کامل و بدون حذف هیچ خطی، داخل فایل Code.gs در Google Apps Script قرار دهید.",
    "۲) روی Save یا کلیدهای Ctrl+S / Cmd+S بزنید و صبر کنید عبارت Unsaved changes حذف شود.",
    "۳) اگر کنار Run عبارت No functions دیده شد، ابتدا فایل را Save کنید و اگر برطرف نشد صفحه را Refresh کنید؛ معمولاً علت، ذخیره‌نشدن کد است.",
    "۴) از منوی انتخاب تابع در کنار Run، تابع runDashboardTelegramScheduler را انتخاب کنید.",
    "۵) روی Run بزنید و مجوزهای Google را تأیید کنید؛ در پیام Authorization required روی Review permissions، حساب Google خودتان و سپس Allow بزنید.",
    "۶) از نوار سمت چپ روی آیکون ساعت Triggers بزنید و Add Trigger را انتخاب کنید.",
    "۷) تابع runDashboardTelegramScheduler، گزینهٔ Event source = Time-driven و بازهٔ Every minute را انتخاب کنید و Save بزنید.",
    "۸) برای تست، به بخش Executions بروید و اجرای تابع را باز کنید؛ در Logs باید Dashboard scheduler response: 200 را ببینید. کد 401 یعنی Secret قدیمی است؛ از داشبورد کلید جدید بسازید و کل فایل Code.gs را جایگزین کنید.",
    "۹) فاصلهٔ واقعی ارسال از تنظیمات داشبورد خوانده می‌شود و بین ۱ تا ۳۶۰ دقیقه قابل تنظیم است؛ بنابراین Trigger همیشه روی Every minute باقی می‌ماند.",
    "اگر Secret گم شد یا احتمال افشای آن وجود داشت، در داشبورد کلید جدید بسازید، مقدار SECRET را در Code.gs جایگزین کنید و Trigger را دوباره تست کنید. کلید قبلی فقط ۷ روز برای جلوگیری از قطعی هنگام جابه‌جایی معتبر می‌ماند.",
  ];
  return <article id="telegram-bot-connection" className={`settingsCard telegramBotCard ${settings.enabled && settings.chatId ? "connected" : "pending"}`}>
    <div className="settingsCardTitle"><i>TB</i><div><strong>اتصال و اعلان‌های Telegram</strong><small>یک بات و یک گفت‌وگو برای گزارش همهٔ دفترهای فعال</small></div></div>
    <div className="telegramSection"><div className="telegramSectionTitle"><strong>اتصال بات</strong><small>توکن امن است؛ مقصدها با تأیید مدیر فعال می‌شوند</small></div><div className="telegramFields"><label><span>توکن Telegram Bot</span><input dir="ltr" type="password" value={botToken} onChange={event => setBotToken(event.target.value)} placeholder={settings.hasToken ? "توکن ذخیره شده؛ برای تغییر وارد کنید" : "توکن دریافتی از BotFather"} autoComplete="off"/></label><label><span>بات شناسایی‌شده</span><input dir="ltr" value={settings.lastBotUsername ? `@${settings.lastBotUsername}` : "هنوز ثبت نشده"} readOnly/></label></div></div>
    <div className="telegramSection telegramUsersSection"><div className="telegramSectionTitle"><strong>کاربران مجاز دریافت گزارش</strong><small>{settings.approvedUserCount.toLocaleString("en-US")} از 4 کاربر تأیید شده · {settings.pendingUserCount.toLocaleString("en-US")} درخواست در انتظار بررسی</small></div><p className="telegramUserHelp">در Telegram برای بات <strong dir="ltr">/start</strong> بفرستید، سپس «شناسایی کاربران» را بزنید. فقط نام‌هایی که تأیید می‌کنید گزارش دریافت خواهند کرد.</p><div className="telegramUsersList">{settings.users.length ? settings.users.slice(0, 4).map(user => <div className={`telegramUserRow ${user.status}`} key={user.userId}><div><strong>{user.displayName}</strong><span dir="ltr">{user.username ? `@${user.username}` : `ID ${user.userId}`}</span></div><b>{user.status === "approved" ? "تأییدشده" : user.status === "rejected" ? "ردشده" : "در انتظار تأیید"}</b><div className="telegramUserActions">{user.status !== "approved" && <button type="button" onClick={() => void moderateUser(user.userId, "approve")} disabled={status === "testing" || settings.approvedUserCount >= 4}>تأیید</button>}{user.status !== "rejected" && <button type="button" className="reject" onClick={() => void moderateUser(user.userId, "reject")} disabled={status === "testing"}>رد</button>}</div></div>) : <div className="telegramUsersEmpty">هنوز کاربری شناسایی نشده است.</div>}</div></div>
    <div className="telegramSection"><div className="telegramSectionTitle"><strong>فعال‌سازی مستقل دفاتر</strong><small>تا وقتی هر دفتر جداگانه فعال نشود، هیچ دیتایی از آن دفتر ارسال نمی‌شود</small></div><div className="telegramBrandSettings">{settings.brandSettings.length ? settings.brandSettings.map(brand => <label className="ruleCheckbox" key={brand.brandId}><input type="checkbox" checked={brand.enabled} onChange={event => setSettings(current => ({ ...current, brandSettings: current.brandSettings.map(item => item.brandId === brand.brandId ? { ...item, enabled: event.target.checked } : item) }))}/><span>{brand.brandName}</span></label>) : <small>دفتر فعال برای ارسال گزارش پیدا نشد.</small>}</div></div>
    <div className="telegramSection"><div className="telegramSectionTitle"><strong>زمان‌بندی گزارش‌ها</strong><small>داشبورد هر ۲ تا ۳ دقیقه بررسی می‌شود و خودش زمان ارسال را کنترل می‌کند</small></div><div className="telegramSchedule"><label><span>فاصلهٔ ارسال گزارش · دقیقه</span><input type="number" min="1" max="360" step="1" dir="ltr" value={settings.intervalMinutes} onChange={event => setSettings(current => ({ ...current, intervalMinutes: Math.max(1, Math.min(360, Number(event.target.value) || 1)) }))}/></label><label><span>گزارش پایان روز عادی</span><input type="time" dir="ltr" value={settings.normalReportTime} onChange={event => setSettings(current => ({ ...current, normalReportTime: event.target.value }))}/></label><label><span>گزارش پایان روز پنجشنبه</span><input type="time" dir="ltr" value={settings.thursdayReportTime} onChange={event => setSettings(current => ({ ...current, thursdayReportTime: event.target.value }))}/></label><label className="ruleCheckbox"><input type="checkbox" checked={settings.endOfDayEnabled} onChange={event => setSettings(current => ({ ...current, endOfDayEnabled: event.target.checked }))}/><span>گزارش پایان روز فعال باشد</span></label><small>حداقل فاصله ۱ دقیقه و حداکثر ۶ ساعت است. جمعه‌ها و تعطیلات رسمی ارسال خودکار ندارند.</small></div></div>
    <div className="telegramSection telegramSchedulerSection"><div className="telegramSectionTitle"><strong>اتصال Google Apps Script Scheduler</strong><small>Apps Script فقط زمان‌بندی را اجرا می‌کند؛ ارسال گزارش داخل داشبورد انجام می‌شود</small></div><div className="telegramGuideText">{schedulerGuide.map((item, index) => <p key={index}>{item}</p>)}</div><button type="button" className="secondarySetupAction" onClick={() => void rotateSchedulerSecret()} disabled={status === "saving" || status === "testing"}>{settings.schedulerSecretSet ? "ساخت کلید جدید Scheduler" : "ساخت کلید Scheduler"}</button>{schedulerSecret && <pre className="telegramSchedulerCode" dir="ltr">{schedulerCode}</pre>}<small>کلید فقط یک‌بار نمایش داده می‌شود. اگر گم شد، کلید جدید بسازید و Secret قبلی را در Apps Script جایگزین کنید.</small></div>
    <div className="telegramSection"><div className="telegramSectionTitle"><strong>فعال‌سازی ارسال</strong><small>این گزینهٔ اصلی ارسال خودکار Telegram است</small></div><label className="ruleCheckbox"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings(current => ({ ...current, enabled: event.target.checked }))}/><span>ارسال خودکار پس از تکمیل اتصال</span></label></div>
    <div className={`settingsMessage ${status === "error" ? "error" : status === "ready" ? "success" : "testing"}`}><i/><span>{message}</span></div>
    <div className="telegramActions"><button type="button" className="primarySetupAction" onClick={() => void save()} disabled={!canSave}>{status === "saving" ? "در حال ذخیره…" : "ذخیره تنظیمات تلگرام"}</button><button type="button" className="secondarySetupAction" onClick={() => void discover()} disabled={!settings.hasToken || status === "saving" || status === "testing"}>شناسایی کاربران</button><button type="button" className="secondarySetupAction" onClick={() => void test()} disabled={!settings.approvedUserCount || status === "saving" || status === "testing"}>ارسال پیام آزمایشی به کاربران تأییدشده</button><button type="button" className="secondarySetupAction" onClick={() => void dispatch()} disabled={!settings.enabled || !settings.approvedUserCount || status === "saving" || status === "testing"}>ارسال گزارش واقعی الآن</button></div>
    <div className="telegramReportStatus" role="status"><span>آخرین ارسال خودکار</span><strong>{settings.lastReportStatus === "success" ? "موفق" : settings.lastReportStatus === "error" ? "ناموفق" : "هنوز ارسال نشده"}</strong>{settings.lastReportAt && <small dir="ltr">{settings.lastReportAt}</small>}{settings.lastReportError && <small className="telegramStatusError">{settings.lastReportError}</small>}<span>آخرین اتصال Scheduler</span><strong className={settings.schedulerStatus === "ok" ? "schedulerOk" : settings.schedulerStatus === "error" ? "schedulerError" : "schedulerPending"}>{settings.schedulerStatus === "ok" ? "متصل" : settings.schedulerStatus === "error" ? "خطا در اتصال" : "هنوز بررسی نشده"}</strong>{settings.lastSchedulerAt && <small dir="ltr">{settings.lastSchedulerAt}</small>}{settings.schedulerError && <small className="telegramStatusError">{settings.schedulerError}</small>}</div>
    <div className="telegramReportPreview"><strong>قالب گزارش</strong><span>کلیک Google Ads · کل لید · SMS · Ads (با تجمیع فرم سایت و WhatsApp) · Instagram · مسافر ثابت (با تجمیع آژانسی و حضوری) · معرفی · قرارداد · بودجه مصرف‌شده</span><small>همهٔ دفترهای فعال در یک پیام بخش‌بندی‌شده، راست‌به‌چپ و با اعداد انگلیسی ارسال می‌شوند.</small></div>
  </article>;
}
