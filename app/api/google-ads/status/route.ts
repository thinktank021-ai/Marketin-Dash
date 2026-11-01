import { getD1 } from "../../../../db";
import { getBrand, getRequestBrandId } from "../../brands/storage";
import { getPublicGoogleAdsSettings, queryGoogleAds } from "../service-account";
import { accountStatusAlert } from "../../../google-ads-alerts";

function googleAdsDiagnostic(error = "") {
  const lower = error.toLowerCase();
  if (/account[_ -]?suspended|customer[_ -]?suspended/.test(lower)) return { reason: "google_ads_account_suspended", field: "account", accountStatus: "SUSPENDED", detail: "Google Ads به‌طور صریح وضعیت این حساب را تعلیق‌شده اعلام کرده است." };
  if (/cancelled[_ -]?account|canceled[_ -]?account/.test(lower)) return { reason: "google_ads_account_canceled", field: "account", accountStatus: "CANCELED", detail: "Google Ads به‌طور صریح وضعیت این حساب را لغوشده اعلام کرده است." };
  if (/closed[_ -]?account/.test(lower)) return { reason: "google_ads_account_closed", field: "account", accountStatus: "CLOSED", detail: "Google Ads به‌طور صریح وضعیت این حساب را بسته‌شده اعلام کرده است." };
  if (/developer.?token|developer_token|access.?level|not.?approved/.test(lower)) return { reason: "google_ads_access_failed", field: "developerToken", detail: "Developer Token این دفتر تأیید نشده یا سطح دسترسی آن برای حساب واقعی کافی نیست." };
  if (/login.?customer|manager|mcc/.test(lower)) return { reason: "google_ads_mcc_failed", field: "loginCustomerId", detail: "MCC ID معتبر نیست یا به Customer ID انتخاب‌شده دسترسی ندارد. در دسترسی مستقیم، MCC را خالی بگذارید." };
  if (/customer.?not.?found|customer.*(invalid|inactive)|resource.*not.*found/.test(lower)) return { reason: "google_ads_customer_failed", field: "customerId", detail: "Customer ID پیدا نشد یا Service Account این دفتر به آن دسترسی ندارد." };
  if (/service.?account|unauthor|forbidden|permission|access denied|invalid_grant/.test(lower)) return { reason: "google_ads_identity_failed", field: "serviceAccount", detail: "ایمیل Service Account این دفتر به حساب Google Ads دسترسی ندارد یا کلید JSON آن معتبر نیست." };
  return { reason: "google_ads_unavailable", field: "connection", detail: "Google Ads پاسخ قابل‌استفاده‌ای برنگرداند؛ Customer ID، MCC اختیاری، Developer Token و دسترسی ایمیل Service Account همین دفتر را بررسی کنید." };
}

export async function GET(request: Request) {
  try {
    const brandId = await getRequestBrandId(request);
    const brand = await getBrand(brandId);
    const settings = await getPublicGoogleAdsSettings(brandId);
    if (!brand.googleAdsCustomerId) return Response.json({ status: "pending", reason: "service_account_not_configured", field: "customerId", detail: "Customer ID این دفتر وارد نشده است.", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    if (!settings.hasServiceAccount) return Response.json({ status: "pending", reason: "service_account_not_configured", field: "serviceAccount", detail: "فایل JSON حساب سرویس این دفتر ذخیره نشده است.", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    if (!settings.hasDeveloperToken) return Response.json({ status: "pending", reason: "service_account_not_configured", field: "developerToken", detail: "Developer Token این دفتر ذخیره نشده است.", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    try {
      const rows = await queryGoogleAds(brandId, brand.googleAdsCustomerId, brand.googleAdsLoginCustomerId, "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 1");
      const customer = (rows[0] as { customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string; status?: string } } | undefined)?.customer;
      const message = `اتصال Service Account موفق است${customer?.descriptiveName ? ` · ${customer.descriptiveName}` : ""}.`;
      await getD1().prepare("UPDATE dashboard_brands SET google_ads_status = 'connected', google_ads_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(message, brandId).run();
      return Response.json({ status: "connected", checkedAt: new Date().toISOString(), accountName: customer?.descriptiveName || brand.googleAdsCustomerId, accountStatus: customer?.status || "UNKNOWN", accountAlert: accountStatusAlert(customer?.status, customer?.descriptiveName || brand.googleAdsCustomerId), currencyCode: customer?.currencyCode || null, timeZone: customer?.timeZone || null }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const diagnostic = googleAdsDiagnostic(error instanceof Error ? error.message : "");
      await getD1().prepare("UPDATE dashboard_brands SET google_ads_status = 'error', google_ads_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(diagnostic.detail, brandId).run();
      return Response.json({ status: "disconnected", ...diagnostic, accountAlert: accountStatusAlert("accountStatus" in diagnostic ? diagnostic.accountStatus : ""), checkedAt: new Date().toISOString() }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  } catch {
    return Response.json({ status: "disconnected", reason: "google_ads_unavailable", field: "connection", detail: "بررسی اتصال Service Account انجام نشد.", checkedAt: new Date().toISOString() }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
