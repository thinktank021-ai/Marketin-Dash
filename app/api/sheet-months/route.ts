import { NextResponse } from "next/server";
import { getBrand, getRequestBrandId } from "../brands/storage";
import { canReadBrandSource } from "../../brand-source-policy";
import { recordSheetHealth } from "../brands/sheet-health";
import { fetchGoogleText, parsePublishedMonths, readMonthRegistryCache, saveMonthRegistryCache } from "../brands/sheets";

/** Returns the selected brand's complete month registry with a five-minute cache and same-source stale fallback. */
export async function GET(request: Request) {
  let cached: Awaited<ReturnType<typeof readMonthRegistryCache>> = null;
  try {
    const requestedBrandId = getRequestBrandId(request);
    const brand = await getBrand(requestedBrandId);
    if (brand.id !== requestedBrandId) throw new Error("brand_not_found");
    if (!canReadBrandSource(brand)) throw new Error("brand_source_unverified");
    if (!brand.sheetIndexUrl) throw new Error("brand_sheet_not_configured");
    cached = await readMonthRegistryCache(brand.id, brand.sheetIndexUrl);
    if (cached?.fresh && cached.months.length && request.headers.get("x-dashboard-refresh") !== "1") return NextResponse.json({ months: cached.months, cached: true, stale: false }, {
      headers: { "cache-control": "no-store", "x-dashboard-brand": brand.id },
    });

    try {
      const html = await fetchGoogleText(`${brand.sheetIndexUrl}?cachebust=${Date.now()}`, cached ? 8000 : 20000);
      const months = parsePublishedMonths(html);
      if (!months.length) throw new Error("no_month_tabs");
      await saveMonthRegistryCache(brand.id, brand.sheetIndexUrl, months);
      await recordSheetHealth(brand.id, brand.sheetCsvUrl, "connected", "اتصال برقرار است؛ فهرست تازهٔ ماه‌های Google Sheets دریافت شد.");
      return NextResponse.json({ months, cached: false, stale: false, warnings: months.flatMap(month => month.warning ? [month.warning] : []) }, {
        headers: { "cache-control": "no-store", "x-dashboard-brand": brand.id },
      });
    } catch (error) {
      await recordSheetHealth(brand.id, brand.sheetCsvUrl, "warning", cached ? "دریافت فهرست تازه ناموفق بود؛ آخرین فهرست معتبر همین منبع حفظ شده است." : "فهرست ماه‌ها فعلاً دریافت نشد؛ اتصال دوباره بررسی می‌شود.");
      if (cached?.months.length) return NextResponse.json({ months: cached.months, cached: true, stale: true, warning: "Google Sheets دیر پاسخ داد؛ آخرین فهرست معتبر ماه‌های همین برند نمایش داده شد." }, {
        headers: { "cache-control": "no-store", "x-dashboard-brand": brand.id, "x-sheet-stale": "true" },
      });
      throw error;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "sheet_month_discovery_failed";
    return NextResponse.json({ error: "فهرست ماه‌های Google Sheets دریافت نشد.", reason }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
