import { getD1 } from "../../../../db";
import { getRequestBrandId } from "../../brands/storage";
import { getPublicSearchConsoleSettings, querySearchConsole } from "../service-account";

const LIVE_TTL_MS = 60000;
const DIMENSIONS = new Set(["query", "page", "country", "device"]);
const TYPES = new Set(["web", "image", "video", "news", "discover", "googleNews"]);
function iso(value: string | null): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function toDate(value: string) { return new Date(`${value}T00:00:00Z`); }
function shift(value: string, days: number) { const date = toDate(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function tehranToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
function inclusiveDays(from: string, to: string) { return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86400000) + 1; }
function metric(row?: { clicks?: number; impressions?: number; ctr?: number; position?: number }) { return { clicks: Number(row?.clicks || 0), impressions: Number(row?.impressions || 0), ctr: Number(row?.ctr || 0), position: Number(row?.position || 0) }; }
function fillDaily(from: string, to: string, rows: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>) {
  const byDate = new Map(rows.map(row => [row.keys?.[0] || "", metric(row)]));
  const result: Array<Metric & { date: string }> = [];
  for (let date = from; date <= to; date = shift(date, 1)) result.push({ date, ...(byDate.get(date) || metric()) });
  return result;
}
type Metric = ReturnType<typeof metric>;

export async function GET(request: Request) {
  const brandId = getRequestBrandId(request);
  const params = new URL(request.url).searchParams;
  const from = params.get("from"), to = params.get("to");
  const dimension = DIMENSIONS.has(params.get("dimension") || "") ? params.get("dimension")! : "query";
  const type = TYPES.has(params.get("type") || "") ? params.get("type")! : "web";
  if (!iso(from) || !iso(to) || from > to || inclusiveDays(from, to) > 365) return Response.json({ error: "بازه تاریخ معتبر نیست یا بیشتر از یک سال است." }, { status: 400 });
  if (to >= tehranToday()) return Response.json({ error: "Search Console فقط تا آخرین روز کامل قابل گزارش‌گیری است؛ روز جاری هنوز نهایی نشده است." }, { status: 400, headers: { "cache-control": "no-store" } });
  const settings = await getPublicSearchConsoleSettings(brandId);
  if (!settings.propertyUrl || !settings.hasServiceAccount) return Response.json({ connected: false, pending: true, error: "اتصال Search Console این دفتر کامل نیست." }, { status: 503, headers: { "cache-control": "no-store" } });
  const days = inclusiveDays(from, to);
  const previousTo = shift(from, -1), previousFrom = shift(previousTo, -(days - 1));
  const cacheKey = `${brandId}:${from}:${to}:${dimension}:${type}`;
  const d1 = getD1();
  let cached: { payload: string; savedAt: string } | null = null;
  try { cached = await d1.prepare("SELECT payload, saved_at AS savedAt FROM search_console_report_cache WHERE cache_key = ?").bind(cacheKey).first<{ payload: string; savedAt: string }>(); } catch { /* migrations may still be applying */ }
  if (cached && Date.now() - Date.parse(`${cached.savedAt.replace(" ", "T")}Z`) <= LIVE_TTL_MS && request.headers.get("x-dashboard-refresh") !== "1") return Response.json({ ...JSON.parse(cached.payload), connected: true, stale: false, cached: true, lastSuccessfulAt: cached.savedAt }, { headers: { "cache-control": "no-store" } });
  try {
    const base = { type, dataState: "all" };
    const [currentTotal, previousTotal, currentDaily, previousDaily, currentRows, previousRows] = await Promise.all([
      querySearchConsole(brandId, { ...base, startDate: from, endDate: to }),
      querySearchConsole(brandId, { ...base, startDate: previousFrom, endDate: previousTo }),
      querySearchConsole(brandId, { ...base, startDate: from, endDate: to, dimensions: ["date"], rowLimit: 25000 }),
      querySearchConsole(brandId, { ...base, startDate: previousFrom, endDate: previousTo, dimensions: ["date"], rowLimit: 25000 }),
      querySearchConsole(brandId, { ...base, startDate: from, endDate: to, dimensions: [dimension], rowLimit: 25000 }),
      querySearchConsole(brandId, { ...base, startDate: previousFrom, endDate: previousTo, dimensions: [dimension], rowLimit: 25000 }),
    ]);
    const currentMap = new Map((currentRows.rows || []).map(row => [row.keys?.[0] || "—", metric(row)]));
    const previousMap = new Map((previousRows.rows || []).map(row => [row.keys?.[0] || "—", metric(row)]));
    const keys = new Set([...currentMap.keys(), ...previousMap.keys()]);
    const rows = [...keys].map(key => ({ key, current: currentMap.get(key) || metric(), previous: previousMap.get(key) || metric() }))
      .sort((left, right) => right.current.clicks - left.current.clicks || right.current.impressions - left.current.impressions || left.key.localeCompare(right.key));
    const payload = {
      connected: true, propertyUrl: settings.propertyUrl, dimension, type,
      dateRange: { from, to }, previousDateRange: { from: previousFrom, to: previousTo },
      totals: metric(currentTotal.rows?.[0]), previousTotals: metric(previousTotal.rows?.[0]),
      daily: fillDaily(from, to, currentDaily.rows || []), rows,
      previousDaily: fillDaily(previousFrom, previousTo, previousDaily.rows || []),
      incompleteFrom: String(currentDaily.metadata?.first_incomplete_date || ""),
    };
    try { await d1.prepare(`INSERT INTO search_console_report_cache (cache_key, payload, saved_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, saved_at = CURRENT_TIMESTAMP`).bind(cacheKey, JSON.stringify(payload)).run(); } catch { /* cache is optional */ }
    return Response.json({ ...payload, stale: false }, { headers: { "cache-control": "no-store" } });
  } catch {
    if (cached) return Response.json({ ...JSON.parse(cached.payload), connected: false, stale: true, lastSuccessfulAt: cached.savedAt }, { headers: { "cache-control": "no-store" } });
    return Response.json({ connected: false, stale: true, error: "داده‌ای از Search Console دریافت نشد؛ تنظیمات همین دفتر را بررسی کنید." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
