import { ensureBrandStorage, getBrand } from "../storage";
import { fetchGoogleText, parsePublishedMonths, saveMonthRegistryCache } from "../sheets";
import { DEFAULT_DASHBOARD_RULES, validateDashboardRules } from "../../../dashboard-rules";
import { discoverChannelCounts } from "../../../sheet-channel-discovery";

type TestStage = { key: string; label: string; status: "success" | "warning" | "error"; detail: string; solution?: string };

/** Parses enough RFC-style CSV for reliable header discovery and a privacy-bounded preview. */
function parseCsvTable(input: string, rowLimit = 6) {
  const table: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < input.length && table.length < rowLimit; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); table.push(row); row = []; field = ""; }
    else field += char;
  }
  if (table.length < rowLimit && (field.length || row.length)) { row.push(field.replace(/\r$/, "")); table.push(row); }
  return table;
}

const FIELD_ALIASES: Record<keyof ReturnType<typeof validateDashboardRules>["sheetColumns"], string[]> = {
  date: ["تاریخ", "تاریخ تماس", "تاریخ ثبت", "date"],
  weekday: ["روز هفته", "روزهای هفته", "روز های هفته", "weekday"],
  source: ["منبع فایل", "منبع", "کانال ورودی", "ورودی", "source", "lead source"],
  route: ["مسیر", "مقصد", "تور", "route", "destination"],
  expert: ["کارشناس", "نام کارشناس", "پاسخگو", "اپراتور", "expert", "agent"],
  outcome: ["نتیجه", "نتیجه تماس", "نتیجه تماس آخر", "وضعیت", "outcome", "status"],
  notes: ["توضیحات", "یادداشت", "شرح", "notes", "description"],
};

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[‌\s_-]+/g, "").trim().toLowerCase();
}

function channelList(counts: Record<string, number>) {
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "fa"));
}

/** Matches exact semantic aliases first and otherwise leaves an optional module disabled. */
function suggestColumns(headers: string[]) {
  const pairs = Object.entries(FIELD_ALIASES).map(([key, aliases]) => {
    const match = headers.find(header => aliases.some(alias => normalizeHeader(alias) === normalizeHeader(header))) || "";
    return [key, match];
  });
  return Object.fromEntries(pairs) as ReturnType<typeof validateDashboardRules>["sheetColumns"];
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

/** Maps anticipated failures to one exact stage plus a practical repair action. */
function describeFailure(code: string): TestStage {
  if (code === "sheet_not_configured") return { key: "save", label: "ذخیره تنظیمات", status: "error", detail: "لینک فعلی هنوز برای این برند ذخیره نشده است.", solution: "دکمه «ذخیره و آزمایش اتصال» را بزنید؛ ذخیره از این پس خودکار انجام می‌شود." };
  if (code === "index_timeout" || code === "csv_timeout") return { key: "timeout", label: "زمان پاسخ Google", status: "error", detail: "Google Sheets تا 15 ثانیه پاسخ کامل نداد.", solution: "اتصال اینترنت را بررسی کنید و یک دقیقه بعد دوباره آزمایش کنید؛ تنظیمات ذخیره‌شده حذف نشده است." };
  if (code === "google_timeout") return { key: "timeout", label: "زمان پاسخ Google", status: "error", detail: "Google Sheets در مهلت تعیین‌شده پاسخ کامل نداد.", solution: "تنظیمات حفظ شده است؛ یک دقیقه بعد دوباره آزمایش کنید. پس از اولین دریافت موفق، کش پنج‌دقیقه‌ای از تکرار این تأخیر جلوگیری می‌کند." };
  if (/^google_http_/.test(code)) return { key: "access", label: "پاسخ Google", status: "error", detail: `Google Sheets با وضعیت ${code.replace("google_http_", "")} پاسخ داد.`, solution: "انتشار Entire document و دسترسی عمومی را بررسی کنید و سپس آزمایش را تکرار کنید." };
  if (code === "index_network" || code === "csv_network") return { key: "network", label: "دسترسی شبکه", status: "error", detail: "سرور داشبورد نتوانست به Google Sheets دسترسی پیدا کند.", solution: "چند لحظه بعد دوباره امتحان کنید. اگر ادامه داشت، وضعیت دسترسی Google یا شبکه میزبان باید بررسی شود." };
  if (code === "sheet_login_required") return { key: "access", label: "دسترسی عمومی", status: "error", detail: "لینک به صفحه ورود Google منتقل شد و عمومی نیست.", solution: "در Publish to web گزینه Entire document را منتشر کنید؛ Share روی Anyone with the link به‌تنهایی کافی نیست." };
  if (code === "sheet_access_404") return { key: "access", label: "آدرس فایل", status: "error", detail: "Google فایل منتشرشده را با این شناسه پیدا نکرد.", solution: "انتشار را دوباره انجام دهید و لینک جدید Publish to web را جایگزین کنید؛ ممکن است انتشار قبلی متوقف شده باشد." };
  if (code === "sheet_access_401" || code === "sheet_access_403") return { key: "access", label: "مجوز مشاهده", status: "error", detail: "Google اجازه مشاهده عمومی فایل را نداد.", solution: "Publish to web را برای Entire document فعال کنید و محدودیت سازمانی Workspace را نیز بررسی کنید." };
  if (code === "sheet_access_429") return { key: "access", label: "محدودیت موقت Google", status: "error", detail: "Google تعداد درخواست‌ها را موقتاً محدود کرده است.", solution: "1 تا 5 دقیقه صبر کنید و فقط یک‌بار دوباره آزمایش را بزنید." };
  if (/^sheet_access_5\d\d$/.test(code)) return { key: "access", label: "اختلال Google", status: "error", detail: "سرویس Google Sheets موقتاً پاسخ سالم نداد.", solution: "تنظیمات شما درست باقی می‌ماند؛ چند دقیقه بعد دوباره آزمایش کنید." };
  if (code === "month_tabs_missing") return { key: "months", label: "تشخیص ماه‌ها", status: "error", detail: "فایل باز شد اما شیت ماهانه قابل شناسایی نبود.", solution: "نام تب‌ها را با نام ماه شمسی شروع کنید؛ مانند «مرداد 1405». سپس Entire document را دوباره Publish کنید." };
  if (code.startsWith("csv_access_")) return { key: "csv", label: "خروجی CSV", status: "error", detail: "صفحه اصلی باز شد اما خروجی داده یکی از ماه‌ها قابل دریافت نبود.", solution: "انتشار را روی Entire document قرار دهید، نه فقط یک تب؛ سپس لینک جدید را ذخیره و آزمایش کنید." };
  if (code === "csv_returned_html") return { key: "csv", label: "خروجی CSV", status: "error", detail: "به‌جای داده CSV، صفحه HTML یا ورود Google دریافت شد.", solution: "Publish to web را فعال کنید؛ لینک معمولی Share یا Edit برای داشبورد کافی نیست." };
  if (code === "sheet_tab_not_found") return { key: "months", label: "تب ماهانه", status: "error", detail: "تب ماهانه از فهرست منتشرشده پیدا نشد.", solution: "نام تب را با نام ماه شمسی شروع کنید؛ فاصله داشتن یا نداشتن بین نام ماه و سال هر دو پشتیبانی می‌شود." };
  if (code.startsWith("headers_missing")) {
    const [, tab = "ماه", headers = "ستون الزامی"] = code.split(":");
    return { key: "schema", label: "ساختار ستون‌ها", status: "error", detail: `در تب «${tab}» ستون‌های الزامی پیدا نشد: ${headers}.`, solution: "نام هدرها را با بخش «ستون‌های Google Sheets» یکسان کنید؛ سپس همین آزمایش را دوباره اجرا کنید." };
  }
  return { key: "unknown", label: "آزمایش اتصال", status: "error", detail: "اتصال در یک مرحله پیش‌بینی‌نشده کامل نشد.", solution: "لینک Publish to web را دوباره کپی کنید و آزمایش را تکرار کنید؛ در صورت تداوم، متن همین مرحله را برای بررسی نگه دارید." };
}

/** Tests URL access, month discovery, CSV delivery, and required headers, then persists the exact result. */
export async function POST(request: Request) {
  const stages: TestStage[] = [];
  let brandId = "";
  try {
    const payload = await request.json() as { id?: unknown; rules?: unknown; mode?: unknown };
    const id = typeof payload.id === "string" ? payload.id : "";
    brandId = id;
    const brand = await getBrand(id);
    if (brand.id !== id || !brand.sheetIndexUrl || !brand.sheetCsvUrl) throw new Error("sheet_not_configured");
    const mode = payload.mode === "inspect" ? "inspect" : "test";
    const inspectionInput = payload.rules && typeof payload.rules === "object" ? { ...(payload.rules as object), sheetColumns: DEFAULT_DASHBOARD_RULES.sheetColumns } : DEFAULT_DASHBOARD_RULES;
    const rules = validateDashboardRules(mode === "inspect" ? inspectionInput : payload.rules);
    const requiredHeaders = [rules.sheetColumns.date, rules.sheetColumns.source].filter(Boolean);
    const optionalHeaders = [rules.sheetColumns.weekday, rules.sheetColumns.route, rules.sheetColumns.expert, rules.sheetColumns.outcome, rules.sheetColumns.notes].filter(Boolean);
    stages.push({ key: "url", label: "اعتبار لینک", status: "success", detail: "لینک Publish to web نرمال‌سازی و ذخیره شده است." });

    const html = await fetchGoogleText(`${brand.sheetIndexUrl}?cachebust=${Date.now()}`);
    if (/accounts\.google\.com|ServiceLogin|Sign in to continue/i.test(html)) throw new Error("sheet_login_required");
    stages.push({ key: "access", label: "دسترسی عمومی", status: "success", detail: "فایل بدون ورود به حساب Google قابل خواندن است." });

    const tabs = parsePublishedMonths(html);
    if (!tabs.length) throw new Error("month_tabs_missing");
    stages.push({ key: "months", label: "تشخیص ماه‌ها", status: "success", detail: `${tabs.length.toLocaleString("en-US")} شیت ماهانه پیدا شد.` });

    if (mode === "inspect") {
      let inspected: { tab: (typeof tabs)[number]; table: string[][] } | null = null;
      for (const tab of [...tabs].reverse()) {
        const csv = await fetchGoogleText(`${brand.sheetCsvUrl}&gid=${encodeURIComponent(tab.gid)}&cachebust=${Date.now()}`, 30000);
        if (/^\s*<!doctype html|^\s*<html|ServiceLogin|Sign in to continue/i.test(csv)) throw new Error("csv_returned_html");
        const table = parseCsvTable(csv);
        if ((table[0] || []).some(value => value.trim())) { inspected = { tab, table }; break; }
      }
      if (!inspected) throw new Error("csv_access_empty");
      const headers = inspected.table[0].map(value => value.trim().replace(/ي/g, "ی").replace(/ك/g, "ک"));
      const suggestions = suggestColumns(headers);
      // Preserve a recoverable historical date header when the first column's heading was overwritten by a date.
      if (!suggestions.date) {
        const inferredDate = headers.find(header => /^1\d{3}[/.\-]\d{1,2}[/.\-]\d{1,2}$/.test(header));
        if (inferredDate) suggestions.date = inferredDate;
      }
      const sampleRows = inspected.table.slice(1, 4).map(values => Object.fromEntries(headers.map((header, index) => [header || `ستون ${index + 1}`, (values[index] || "").trim().slice(0, 80)])));
      const discoveredCounts: Record<string, number> = {};
      if (suggestions.source) {
        const sourceCounts = await mapWithConcurrency(tabs, 6, async tab => {
          const csv = await fetchGoogleText(`${brand.sheetCsvUrl}&gid=${encodeURIComponent(tab.gid)}&cachebust=${Date.now()}`, 30000);
          return discoverChannelCounts(csv, suggestions.source);
        });
        sourceCounts.forEach(counts => Object.entries(counts).forEach(([name, count]) => { discoveredCounts[name] = (discoveredCounts[name] || 0) + count; }));
      }
      stages.push({ key: "headers", label: "شناسایی ستون‌ها", status: suggestions.date && suggestions.source ? "success" : "warning", detail: `${headers.filter(Boolean).length.toLocaleString("en-US")} ستون از تب «${inspected.tab.label}» خوانده شد.`, ...(!suggestions.date || !suggestions.source ? { solution: "ستون‌های الزامی تاریخ و کانال ورودی را در مرحله نگاشت دستی انتخاب کنید." } : {}) });
      stages.push({ key: "channels", label: "شناسایی کانال‌ها", status: Object.keys(discoveredCounts).length ? "success" : "warning", detail: `${Object.keys(discoveredCounts).length.toLocaleString("en-US")} نام کانال از تمام ماه‌های قابل‌دسترسی خوانده شد.`, ...(!Object.keys(discoveredCounts).length ? { solution: "ستون کانال ورودی را در مرحله نگاشت انتخاب و شناسایی را دوباره اجرا کنید." } : {}) });
      return Response.json({ connected: false, stages, inspection: { headers: headers.filter(Boolean), suggestions, sampleRows, tabLabel: inspected.tab.label, monthCount: tabs.length, discoveredChannels: channelList(discoveredCounts) } });
    }

    const diagnostics = await mapWithConcurrency(tabs, 10, async tab => {
      const csv = await fetchGoogleText(`${brand.sheetCsvUrl}&gid=${encodeURIComponent(tab.gid)}&cachebust=${Date.now()}`, 30000);
      if (/^\s*<!doctype html|^\s*<html|ServiceLogin|Sign in to continue/i.test(csv)) throw new Error("csv_returned_html");
      const headers = (parseCsvTable(csv, 1)[0] || []).map(value => value.trim().replace(/ي/g, "ی").replace(/ك/g, "ک"));
      const dateHeaderRecovered = !headers.includes(rules.sheetColumns.date) && headers.some(header => /^1\d{3}\/\d{1,2}\/\d{1,2}$/.test(header));
      const missing = requiredHeaders.filter(header => !headers.includes(header) && !(header === rules.sheetColumns.date && dateHeaderRecovered));
      if (missing.length) throw new Error(`headers_missing:${tab.label}:${missing.join("، ")}`);
      const missingOptional = optionalHeaders.filter(header => !headers.includes(header));
      const empty = csv.trim().split(/\r?\n/).length <= 2;
      return { tab, dateHeaderRecovered, missingOptional, empty, channelCounts: discoverChannelCounts(csv, rules.sheetColumns.source) };
    });
    const warnings = diagnostics.flatMap(item => [
      ...(item.tab.warning ? [item.tab.warning] : []),
      ...(item.dateHeaderRecovered ? [`عنوان ستون تاریخ در «${item.tab.label}» اشتباه است؛ داشبورد آن را خودکار بازیابی می‌کند.`] : []),
      ...(item.missingOptional.length ? [`ستون‌های اختیاری ${item.missingOptional.join("، ")} در «${item.tab.label}» وجود ندارد.`] : []),
      ...(item.empty ? [`تب «${item.tab.label}» خالی است.`] : []),
    ]);
    const discoveredCounts: Record<string, number> = {};
    diagnostics.forEach(item => Object.entries(item.channelCounts).forEach(([name, count]) => { discoveredCounts[name] = (discoveredCounts[name] || 0) + count; }));
    stages.push({ key: "schema", label: "ساختار همه ماه‌ها", status: warnings.length ? "warning" : "success", detail: `${tabs.length.toLocaleString("en-US")} ماه بررسی شد${warnings.length ? `؛ ${warnings.length.toLocaleString("en-US")} هشدار قابل بازیابی وجود دارد` : " و همگی سالم‌اند"}.`, ...(warnings.length ? { solution: warnings.join(" ") } : {}) });
    await saveMonthRegistryCache(id, brand.sheetIndexUrl, tabs);

    const d1 = await ensureBrandStorage();
    await d1.prepare("UPDATE dashboard_brands SET sheet_status = 'connected', sheet_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(`اتصال موفق · ${tabs.length.toLocaleString("en-US")} ماه قابل دریافت${warnings.length ? ` · ${warnings.length.toLocaleString("en-US")} هشدار بازیابی‌شده` : ""}`, id).run();
    try {
      await d1.prepare("INSERT INTO brand_system_events (brand_id,severity,component,event_code,message,safe_context) VALUES (?,'info','sheet','SHEET_TEST_PASSED',?,?)")
        .bind(id, `آزمایش کامل ${tabs.length.toLocaleString("en-US")} ماه Google Sheets موفق بود.`, JSON.stringify({ monthCount: tabs.length, warningCount: warnings.length, rulesVersion: rules.rulesVersion })).run();
    } catch { /* Health logging must never turn a successful connection into a failure. */ }
    return Response.json({ connected: true, stages, monthCount: tabs.length, warnings, discoveredChannels: channelList(discoveredCounts) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "sheet_test_failed";
    const failure = describeFailure(code);
    stages.push(failure);
    try {
      if (brandId) {
        const d1 = await ensureBrandStorage();
        await d1.prepare("UPDATE dashboard_brands SET sheet_status = 'error', sheet_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(`${failure.detail} راه‌حل: ${failure.solution}`, brandId).run();
        await d1.prepare("INSERT INTO brand_system_events (brand_id,severity,component,event_code,message,safe_context) VALUES (?,'error','sheet','SHEET_TEST_FAILED',?,?)")
          .bind(brandId, failure.detail, JSON.stringify({ code: code.slice(0, 300), solution: failure.solution })).run();
      }
    } catch { /* The visible error must not depend on diagnostic persistence. */ }
    return Response.json({ connected: false, error: failure.detail, solution: failure.solution, code, stages }, { status: 422 });
  }
}
