export function normalizeAdsId(value: string) {
  return value.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632)).replace(/[-\s]/g, "");
}

export function validateAdsAccountIds(customerId: string, managerId: string) {
  if (!/^\d{10}$/.test(normalizeAdsId(customerId))) return "Customer ID باید شناسه ۱۰ رقمی حساب تبلیغاتی باشد؛ نه ایمیل، شناسه کمپین یا شماره حساب مدیر.";
  if (managerId.trim() && !/^\d{10}$/.test(normalizeAdsId(managerId))) return "MCC ID باید شناسه ۱۰ رقمی حساب مدیر باشد. اگر دسترسی مستقیم دارید، این فیلد را خالی بگذارید.";
  return "";
}

export function adsSetupError(message: string) {
  if (message.includes("google_ads_encryption_not_configured")) return "ذخیره امن اتصال روی سرور آماده نیست. مدیر فنی باید کلید رمزگذاری Google Ads را در تنظیمات سرور فعال کند؛ تغییر شناسه حساب یا تکرار ورود این مشکل را حل نمی‌کند.";
  if (message.includes("google_ads_credentials_incomplete")) return "فایل JSON حساب سرویس و Developer Token همین دفتر را تکمیل کنید. اگر قبلاً ذخیره شده‌اند، می‌توانید فیلدهای محرمانه را خالی بگذارید.";
  if (message.includes("google_ads_service_account_json_invalid")) return "فایل JSON معتبر Service Account نیست. محتوای کامل فایل دانلودشده از Google Cloud را بدون تغییر وارد کنید.";
  if (message.includes("google_ads_service_account_key_invalid")) return "کلید خصوصی داخل JSON معتبر نیست. در Google Cloud برای همین Service Account یک کلید JSON جدید بسازید.";
  if (/invalid_grant/.test(message)) return "گوگل امضای Service Account را نپذیرفت. کلید JSON، ساعت سرور و فعال‌بودن حساب سرویس را بررسی کنید.";
  if (/DEVELOPER_TOKEN_NOT_APPROVED|only.*test accounts/i.test(message)) return "Developer Token فقط مجوز حساب آزمایشی دارد. برای حساب واقعی، سطح دسترسی مجاز به حساب واقعی را در API Center دریافت کنید.";
  if (/USER_PERMISSION_DENIED|does not have permission/i.test(message)) return "ایمیل Service Account همین دفتر به حساب دسترسی ندارد. Access and security، Customer ID و در صورت استفاده MCC ID را کنترل کنید.";
  return "اتصال تأیید نشد. فایل JSON، سطح دسترسی Developer Token و دسترسی ایمیل Service Account همین دفتر را طبق راهنما بررسی کنید.";
}
