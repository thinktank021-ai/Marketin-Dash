import { getD1 } from "../../../db";

export const PERSIAN_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const CACHE_TTL_MS = 5 * 60 * 1000;

export type PublishedMonth = { value: string; label: string; gid: string; sheetName: string; warning?: string };

function normalizeDigits(value: string) {
  return value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function decodePublishedName(value: string) {
  try { return JSON.parse(`"${value}"`) as string; }
  catch { return value.replace(/\\u200c/g, "‌").replace(/\\"/g, "\""); }
}

function editDistance(left: string, right: string) {
  const rows = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = rows[0];
    rows[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = rows[j];
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return rows[right.length];
}

/** Recognizes exact and small spelling variants so one typo cannot silently hide an old month. */
function identifyPersianMonth(rawName: string) {
  const name = normalizeDigits(rawName).replace(/[،,:؛\-–—]/g, " ").replace(/[\s‌]+/g, " ").trim();
  const token = name.split(" ")[0] || "";
  const compact = name.replace(/\s+/g, "");
  // Google sometimes publishes a tab as «شهریور1405» and sometimes as
  // «شهریور 1405». Treat both forms identically so the current month cannot
  // disappear from the registry only because the editor omitted one space.
  const exact = PERSIAN_MONTHS.findIndex(month => token === month || name.startsWith(`${month} `) || (compact.startsWith(month) && /^1\d{3}$/.test(compact.slice(month.length))));
  if (exact >= 0) return { monthNumber: exact + 1, normalized: PERSIAN_MONTHS[exact], warning: "" };
  const ranked = PERSIAN_MONTHS.map((month, index) => ({ month, index, distance: editDistance(token, month) })).sort((a, b) => a.distance - b.distance);
  if (ranked[0] && ranked[0].distance <= 2) return { monthNumber: ranked[0].index + 1, normalized: ranked[0].month, warning: `نام تب «${rawName}» با املای «${ranked[0].month}» بازیابی شد.` };
  return null;
}

/** Parses every published month and infers omitted years in ascending or descending workbook order. */
export function parsePublishedMonths(html: string): PublishedMonth[] {
  const pattern = /items\.push\(\{name:\s*"((?:\\.|[^"\\])*)"[\s\S]*?gid:\s*"?(-?\d+)"?/g;
  const raw = [...html.matchAll(pattern)].map(match => {
    const sheetName = normalizeDigits(decodePublishedName(match[1]).trim());
    const identified = identifyPersianMonth(sheetName);
    if (!identified) return null;
    const year = sheetName.match(/(1\d{3})(?:\s|$)/)?.[1];
    return { sheetName, gid: match[2], monthNumber: identified.monthNumber, normalized: identified.normalized, explicitYear: year ? Number(year) : null, warning: identified.warning };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (!raw.length) return [];

  const ordinaryDeltas = raw.slice(1).map((tab, index) => tab.monthNumber - raw[index].monthNumber).filter(delta => Math.abs(delta) <= 6 && delta !== 0);
  const descending = ordinaryDeltas.reduce((sum, delta) => sum + Math.sign(delta), 0) < 0;
  let activeYear = raw.find(tab => tab.explicitYear !== null)?.explicitYear
    || Number(new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric" }).format(new Date()));
  let previousMonth: number | null = null;
  return raw.map(tab => {
    if (tab.explicitYear !== null) activeYear = tab.explicitYear;
    else if (previousMonth !== null) {
      if (descending && tab.monthNumber > previousMonth) activeYear -= 1;
      if (!descending && tab.monthNumber < previousMonth) activeYear += 1;
    }
    previousMonth = tab.monthNumber;
    const month = String(tab.monthNumber).padStart(2, "0");
    return { value: `${activeYear}/${month}`, label: `${tab.normalized} ${activeYear}`, gid: tab.gid, sheetName: tab.sheetName, ...(tab.warning ? { warning: tab.warning } : {}) };
  });
}

function sqliteUtcToMs(value: string) { return Date.parse(`${value.replace(" ", "T")}Z`); }

export async function fetchGoogleText(url: string, timeoutMs = 25000) {
  try {
    const response = await fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`google_http_${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("google_timeout");
    throw error;
  }
}

export async function readMonthRegistryCache(brandId: string, sourceUrl: string) {
  const row = await getD1().prepare("SELECT payload, fetched_at AS fetchedAt FROM sheet_month_registry_cache WHERE brand_id = ? AND source_url = ?")
    .bind(brandId, sourceUrl).first<{ payload: string; fetchedAt: string }>();
  if (!row) return null;
  return { months: JSON.parse(row.payload) as PublishedMonth[], fetchedAt: row.fetchedAt, fresh: Date.now() - sqliteUtcToMs(row.fetchedAt) <= CACHE_TTL_MS };
}

export async function saveMonthRegistryCache(brandId: string, sourceUrl: string, months: PublishedMonth[]) {
  await getD1().prepare(`INSERT INTO sheet_month_registry_cache (brand_id, source_url, payload, fetched_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(brand_id) DO UPDATE SET source_url = excluded.source_url, payload = excluded.payload, fetched_at = CURRENT_TIMESTAMP`)
    .bind(brandId, sourceUrl, JSON.stringify(months)).run();
}

export async function readCsvCache(cacheKey: string, brandId: string, sourceUrl: string) {
  const row = await getD1().prepare("SELECT payload, fetched_at AS fetchedAt FROM sheet_csv_cache WHERE cache_key = ? AND brand_id = ? AND source_url = ?")
    .bind(cacheKey, brandId, sourceUrl).first<{ payload: string; fetchedAt: string }>();
  if (!row) return null;
  return { csv: row.payload, fetchedAt: row.fetchedAt, fresh: Date.now() - sqliteUtcToMs(row.fetchedAt) <= CACHE_TTL_MS };
}

export async function saveCsvCache(cacheKey: string, brandId: string, sourceUrl: string, selector: string, csv: string) {
  await getD1().prepare(`INSERT INTO sheet_csv_cache (cache_key, brand_id, source_url, selector, payload, fetched_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = CURRENT_TIMESTAMP`)
    .bind(cacheKey, brandId, sourceUrl, selector, csv).run();
}

export function sourceFingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
