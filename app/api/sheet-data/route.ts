import { getBrand, getRequestBrandId } from "../brands/storage";
import { canReadBrandSource } from "../../brand-source-policy";
import { recordSheetHealth } from "../brands/sheet-health";
import { fetchGoogleText, parsePublishedMonths, readCsvCache, readMonthRegistryCache, saveCsvCache, saveMonthRegistryCache, sourceFingerprint } from "../brands/sheets";

/** Proxies only the selected brand's Sheet and keeps a same-source five-minute snapshot for speed and outage fallback. */
export async function GET(request: Request) {
  let cache: Awaited<ReturnType<typeof readCsvCache>> = null;
  let brand: Awaited<ReturnType<typeof getBrand>> | null = null;
  try {
    const params = new URL(request.url).searchParams;
    const gid = params.get("gid") || "";
    const sheet = params.get("sheet") || "";
    if (gid && !/^-?\d+$/.test(gid)) return Response.json({ error: "شناسه شیت معتبر نیست." }, { status: 400 });
    if (!gid && (!sheet || sheet.length > 80)) return Response.json({ error: "ماه شیت معتبر نیست." }, { status: 400 });
    const requestedBrandId = getRequestBrandId(request);
    brand = await getBrand(requestedBrandId);
    if (brand.id !== requestedBrandId) return Response.json({ error: "برند انتخاب‌شده وجود ندارد." }, { status: 404, headers: { "cache-control": "no-store" } });
    if (!canReadBrandSource(brand)) return Response.json({ error: "منبع این برند هنوز تأیید نشده است." }, { status: 409, headers: { "cache-control": "no-store" } });
    if (!brand.sheetCsvUrl) return Response.json({ error: "Google Sheets برای این برند تنظیم نشده است." }, { status: 409 });
    let resolvedGid = gid;
    if (!resolvedGid) {
      // Google Publish-to-web CSV endpoints reliably accept gid, while the
      // sheet-name fallback is rejected by some published workbooks. Resolve
      // the human-readable tab name through the published registry first.
      let registry = brand.sheetIndexUrl ? await readMonthRegistryCache(brand.id, brand.sheetIndexUrl) : null;
      if (!registry?.months.length || !registry.fresh) {
        if (!brand.sheetIndexUrl) throw new Error("sheet_tab_not_found");
        const html = await fetchGoogleText(`${brand.sheetIndexUrl}?cachebust=${Date.now()}`, cache ? 8000 : 20000);
        const months = parsePublishedMonths(html);
        if (!months.length) throw new Error("sheet_tab_not_found");
        await saveMonthRegistryCache(brand.id, brand.sheetIndexUrl, months);
        registry = { months, fetchedAt: "", fresh: true };
      }
      const requested = sheet.trim();
      const match = registry.months.find(month => month.sheetName === requested || month.label === requested || month.value === requested);
      if (!match?.gid) throw new Error("sheet_tab_not_found");
      resolvedGid = match.gid;
    }
    const selector = `gid=${resolvedGid}`;
    const cacheKey = `${brand.id}:${sourceFingerprint(brand.sheetCsvUrl)}:${selector}`;
    cache = await readCsvCache(cacheKey, brand.id, brand.sheetCsvUrl);
    if (cache?.fresh && request.headers.get("x-dashboard-refresh") !== "1") return new Response(cache.csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-dashboard-brand": brand.id, "x-sheet-cache": "fresh" } });

    try {
      const remoteSelector = `gid=${encodeURIComponent(resolvedGid)}`;
      const csv = await fetchGoogleText(`${brand.sheetCsvUrl}&${remoteSelector}&cachebust=${Date.now()}`, cache ? 8000 : 20000);
      if (/^\s*<!doctype html|^\s*<html|ServiceLogin|Sign in to continue/i.test(csv)) throw new Error("sheet_returned_html");
      await saveCsvCache(cacheKey, brand.id, brand.sheetCsvUrl, selector, csv);
      await recordSheetHealth(brand.id, brand.sheetCsvUrl, "connected", "اتصال برقرار است؛ دادهٔ تازهٔ Google Sheets با موفقیت دریافت شد.");
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-dashboard-brand": brand.id, "x-sheet-cache": "remote" } });
    } catch (error) {
      await recordSheetHealth(brand.id, brand.sheetCsvUrl, "warning", cache ? "دریافت تازه ناموفق بود؛ آخرین دادهٔ معتبر همین منبع حفظ شده است." : "دریافت تازه ناموفق بود؛ اتصال دوباره بررسی می‌شود.");
      if (cache) return new Response(cache.csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-dashboard-brand": brand.id, "x-sheet-cache": "stale", "x-sheet-stale": "true" } });
      throw error;
    }
  } catch (error) {
    if (brand?.id && brand.sheetCsvUrl) {
      try { await recordSheetHealth(brand.id, brand.sheetCsvUrl, "warning", "دریافت واقعی دادهٔ Google Sheets ناموفق بود؛ اتصال نیازمند بررسی است."); } catch { /* Health persistence must not hide the source error. */ }
    }
    const reason = error instanceof Error ? error.message : "sheet_csv_failed";
    return Response.json({ error: "دریافت داده Google Sheets انجام نشد.", reason }, { status: 502, headers: { "cache-control": "no-store", "x-sheet-error": reason } });
  }
}
