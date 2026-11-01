import { getRequestBrandId } from "../../brands/storage";
import { getPublicSearchConsoleSettings, getSearchConsoleProperty } from "../service-account";

function diagnostic(error = "") {
  const lower = error.toLowerCase();
  if (/permission|forbidden|unauthor|not found|not_found/.test(lower)) return { reason: "search_console_access_failed", field: "access", detail: "ایمیل Service Account در Property انتخاب‌شده دسترسی ندارد؛ آن را با سطح Full اضافه کنید." };
  if (/invalid_grant|token|jwt|signature/.test(lower)) return { reason: "search_console_identity_failed", field: "serviceAccount", detail: "فایل JSON حساب سرویس معتبر نیست یا کلید آن غیرفعال شده است." };
  return { reason: "search_console_unavailable", field: "connection", detail: "Search Console پاسخ قابل‌استفاده‌ای نداد؛ Property، دسترسی ایمیل سرویس و فعال‌بودن API را بررسی کنید." };
}

export async function GET(request: Request) {
  const brandId = getRequestBrandId(request);
  try {
    const settings = await getPublicSearchConsoleSettings(brandId);
    if (!settings.propertyUrl) return Response.json({ status: "pending", reason: "search_console_not_configured", field: "property", detail: "Property این دفتر وارد نشده است.", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    if (!settings.hasServiceAccount) return Response.json({ status: "pending", reason: "search_console_not_configured", field: "serviceAccount", detail: "فایل JSON حساب سرویس این دفتر ذخیره نشده است.", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    try {
      const property = await getSearchConsoleProperty(brandId);
      return Response.json({ status: "connected", propertyUrl: property.siteUrl || settings.propertyUrl, permissionLevel: property.permissionLevel || "unknown", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const result = diagnostic(error instanceof Error ? error.message : "");
      return Response.json({ status: "disconnected", ...result, checkedAt: new Date().toISOString() }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  } catch {
    return Response.json({ status: "disconnected", reason: "search_console_unavailable", field: "connection", detail: "بررسی اتصال Search Console انجام نشد.", checkedAt: new Date().toISOString() }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
