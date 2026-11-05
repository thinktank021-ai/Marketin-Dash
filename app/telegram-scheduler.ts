/** Scheduler authentication helpers are kept pure so rotation and grace-period
 * behavior can be verified without a live D1 database or Telegram credential. */
export function constantTimeEqual(left: string, right: string) {
  const leftLength = left.length;
  const rightLength = right.length;
  const length = Math.max(leftLength, rightLength);
  let difference = leftLength ^ rightLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function schedulerSecretMatches(secret: string, current: string | null, previous: string | null, previousExpiresAt: string | null, now = Date.now()) {
  if (current && constantTimeEqual(secret, current)) return "current" as const;
  if (previous && previousExpiresAt && Date.parse(previousExpiresAt) > now && constantTimeEqual(secret, previous)) return "grace" as const;
  return null;
}

export function schedulerHealthError(code: "secret_mismatch" | "dispatch_failed", detail?: string) {
  if (code === "secret_mismatch") return "کلید Scheduler با Code.gs یکسان نیست؛ از داشبورد کلید جدید بسازید و کد تولیدشده را کامل جایگزین کنید.";
  return detail ? `ارسال گزارش از Scheduler با خطا متوقف شد: ${detail}` : "ارسال گزارش از Scheduler با خطا متوقف شد.";
}

/** A failed source load is a scheduler failure, not a successful HTTP 200 tick. */
export function dispatchResponseStatus(result: { sent: boolean; reason?: string }) {
  return result.reason === "source_unavailable" ? 503
    : result.reason === "no_enabled_brands" || result.reason === "no_recipients" || result.reason === "disabled" ? 409
    : 200;
}

/** Safe operator-facing reason; never include upstream response bodies or credentials. */
export function dispatchFailureMessage(reason?: string) {
  switch (reason) {
    case "source_unavailable": return "داده معتبر یکی از دفترهای فعال دریافت نشد؛ علت را در آخرین خطای گزارش بررسی کنید.";
    case "no_enabled_brands": return "هیچ دفتر فعال دارای منبع Google Sheets برای گزارش تلگرام انتخاب نشده است.";
    case "no_recipients": return "حداقل یک کاربر تلگرام را شناسایی و تأیید کنید.";
    case "disabled": return "ارسال خودکار بات غیرفعال است یا توکن آن تنظیم نشده است.";
    default: return undefined;
  }
}

/** Sanitized, actionable errors for manual Telegram actions. Never echo secrets or upstream bodies. */
export function telegramOperationError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "telegram_token_missing") return { status: 409, code: "telegram_token_missing", error: "توکن بات در تنظیمات ذخیره نشده است." };
  if (message === "google_ads_encryption_not_configured" || message.startsWith("encryption_key_invalid_"))
    return { status: 503, code: "encryption_configuration", error: "کلید رمزنگاری سرور موجود نیست یا قالب آن نامعتبر است؛ تنظیمات cPanel را بدون تعویض کلید قبلی بررسی کنید." };
  if (message === "google_ads_secret_invalid" || /decrypt|OperationError/i.test(message))
    return { status: 503, code: "credential_decryption_failed", error: "رمزگشایی توکن بات ناموفق بود؛ کلید رمزنگاری این نصب را با کلید اولیه دیتابیس تطبیق دهید." };
  if (message === "telegram_401" || /unauthorized/i.test(message))
    return { status: 502, code: "telegram_token_rejected", error: "Telegram توکن بات را نپذیرفت؛ اعتبار آن را در تنظیمات بررسی کنید." };
  if (message === "telegram_403" || /bot was blocked|forbidden/i.test(message))
    return { status: 502, code: "telegram_recipient_forbidden", error: "Telegram ارسال را رد کرد؛ کاربر باید گفت‌وگو با بات را شروع کند و بات را مسدود نکرده باشد." };
  if (/SQLITE|no such (table|column)|database binding/i.test(message))
    return { status: 503, code: "database_unavailable", error: "پایگاه داده یا جدول‌های تلگرام آماده نیستند؛ مسیر SQLite و ساختار دیتابیس cPanel را بررسی کنید." };
  if (/fetch failed|timeout|abort/i.test(message))
    return { status: 503, code: "upstream_unavailable", error: "ارتباط سرور با Google Sheets یا Telegram برقرار نشد؛ دسترسی خروجی HTTPS سرور را بررسی کنید." };
  return { status: 500, code: "telegram_dispatch_failed", error: "ساخت یا ارسال گزارش ناموفق بود؛ وضعیت آخرین گزارش و لاگ امن سرور را بررسی کنید." };
}
