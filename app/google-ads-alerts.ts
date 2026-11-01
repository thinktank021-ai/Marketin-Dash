export type GoogleAdsAlert = {
  id: string;
  kind: "account" | "campaign" | "policy";
  severity: "critical" | "warning";
  title: string;
  detail: string;
  entityName?: string;
};

const ACCOUNT_STATUS_FA: Record<string, { title: string; detail: string }> = {
  SUSPENDED: { title: "حساب Google Ads تعلیق شده است", detail: "نمایش تبلیغات این حساب متوقف شده است. علت و امکان اعتراض را در Google Ads بررسی کنید." },
  CANCELED: { title: "حساب Google Ads لغو شده است", detail: "این حساب لغو شده و تا فعال‌سازی مجدد امکان نمایش تبلیغات ندارد." },
  CLOSED: { title: "حساب Google Ads بسته شده است", detail: "این حساب بسته شده و کمپین‌های آن امکان ادامهٔ نمایش ندارند." },
};

const CAMPAIGN_REASON_FA: Record<string, string> = {
  BUDGET_CONSTRAINED: "بودجهٔ کمپین برای پوشش تقاضای موجود کافی نیست",
  BUDGET_MISCONFIGURED: "تنظیمات بودجهٔ کمپین نیازمند اصلاح است",
  BUDGET_PENDING: "بودجه هنوز فعال یا تأیید نشده است",
  BUDGET_ENDED: "بازهٔ زمانی بودجه پایان یافته است",
  BIDDING_STRATEGY_MISCONFIGURED: "تنظیمات استراتژی مزایده کامل یا معتبر نیست",
  BIDDING_STRATEGY_LIMITED: "استراتژی مزایده با محدودیت اجرا می‌شود",
  BIDDING_STRATEGY_LEARNING: "استراتژی مزایده در حال یادگیری است",
  BIDDING_STRATEGY_CONSTRAINED: "تنظیمات مزایده دامنهٔ نمایش را محدود کرده است",
  HAS_ASSET_GROUP_DISAPPROVED: "حداقل یک گروه دارایی رد شده است",
  HAS_ASSET_GROUP_LIMITED: "حداقل یک گروه دارایی با محدودیت نمایش روبه‌رو است",
  MOST_ASSET_GROUPS_UNDER_REVIEW: "بیشتر گروه‌های دارایی هنوز در حال بررسی هستند",
  NO_ELIGIBLE_ASSET_GROUPS: "هیچ گروه دارایی واجد شرایط نمایش نیست",
  MISSING_ASSET_GROUP: "گروه دارایی لازم برای نمایش کامل نشده است",
  APP_NOT_RELEASED: "اپلیکیشن معرفی‌شده هنوز منتشر نشده است",
  APP_PARTIALLY_RELEASED: "اپلیکیشن فقط برای بخشی از کاربران منتشر شده است",
  SEARCH_GENERATIVE_EXPERIENCE_RESTRICTED: "نمایش در تجربهٔ جست‌وجوی مولد محدود شده است",
  CAMPAIGN_PENDING: "زمان شروع کمپین هنوز نرسیده است",
  CAMPAIGN_ENDED: "زمان پایان کمپین گذشته است",
  CAMPAIGN_DRAFT: "کمپین هنوز در وضعیت پیش‌نویس است",
  CAMPAIGN_GROUP_PAUSED: "گروه کمپین متوقف شده است",
  CAMPAIGN_GROUP_ALL_GROUP_BUDGETS_ENDED: "بودجه‌های گروه کمپین پایان یافته‌اند",
};

const POLICY_TOPIC_FA: Record<string, string> = {
  DESTINATION_NOT_WORKING: "صفحهٔ مقصد در دسترس یا قابل استفاده نیست",
  DESTINATION_MISMATCH: "دامنه یا مقصد تبلیغ با اطلاعات اعلام‌شده مطابقت ندارد",
  MALICIOUS_SOFTWARE: "در مقصد تبلیغ نشانه‌ای از نرم‌افزار مخرب شناسایی شده است",
  MISREPRESENTATION: "محتوا یا هویت کسب‌وکار گمراه‌کننده تشخیص داده شده است",
  CIRCUMVENTING_SYSTEMS: "تلاش برای دورزدن سامانه‌های بررسی Google تشخیص داده شده است",
  PUNCTUATION_AND_SYMBOLS: "نحوهٔ استفاده از علائم نگارشی یا نمادها مجاز نیست",
  CAPITALIZATION: "استفاده از حروف بزرگ با سیاست نگارشی تبلیغ سازگار نیست",
  EDITORIAL: "متن تبلیغ با الزامات نگارشی Google سازگار نیست",
  TRADEMARKS_IN_AD_TEXT: "متن تبلیغ شامل علامت تجاری محدودشده است",
  HEALTH_IN_PERSONALIZED_ADVERTISING: "استفاده شخصی‌سازی‌شده از محتوای مرتبط با سلامت محدود است",
  FINANCIAL_SERVICES_VERIFICATION: "احراز صلاحیت خدمات مالی کامل نشده است",
  UNRELIABLE_CLAIMS: "ادعای مطرح‌شده قابل اتکا یا قابل اثبات تشخیص داده نشده است",
  DANGEROUS_PRODUCTS_OR_SERVICES: "محصول یا خدمت در دستهٔ خطرناک یا محدودشده قرار گرفته است",
  LEGAL_REQUIREMENTS: "تبلیغ با الزامات قانونی محل نمایش سازگار نیست",
};

export function accountStatusAlert(status = "", accountName = ""): GoogleAdsAlert | null {
  const translated = ACCOUNT_STATUS_FA[status];
  return translated ? { id: `account:${status}`, kind: "account", severity: "critical", title: translated.title, detail: translated.detail, entityName: accountName || undefined } : null;
}

export function campaignLimitedAlert(campaign: { id?: string; name?: string; primaryStatus?: string; primaryStatusReasons?: string[] }): GoogleAdsAlert | null {
  if (campaign.primaryStatus !== "LIMITED") return null;
  const reasons = [...new Set(campaign.primaryStatusReasons || [])];
  const detail = reasons.length
    ? reasons.map(reason => CAMPAIGN_REASON_FA[reason] || "Google برای این کمپین یک محدودیت فنی ثبت کرده است").join("؛ ")
    : "کمپین فعال است اما Google دامنهٔ نمایش آن را محدود کرده است؛ جزئیات بیشتر را در صفحهٔ کمپین بررسی کنید.";
  return { id: `campaign:${campaign.id || campaign.name || "unknown"}`, kind: "campaign", severity: "warning", title: "کمپین با محدودیت نمایش فعال است", detail, entityName: campaign.name || campaign.id };
}

export function policyAlert(input: { adId?: string; campaignName?: string; approvalStatus?: string; topics?: string[] }): GoogleAdsAlert | null {
  if (input.approvalStatus !== "DISAPPROVED" && input.approvalStatus !== "APPROVED_LIMITED") return null;
  const topics = [...new Set(input.topics || [])];
  const detail = topics.length
    ? topics.map(topic => POLICY_TOPIC_FA[topic] || "محتوا با یکی از سیاست‌های تبلیغاتی Google نیازمند بررسی است").join("؛ ")
    : input.approvalStatus === "DISAPPROVED"
      ? "این تبلیغ به‌دلیل سیاست‌های Google امکان نمایش ندارد؛ جزئیات و امکان درخواست بازبینی را در Google Ads بررسی کنید."
      : "این تبلیغ فقط در بعضی شرایط امکان نمایش دارد؛ محدودیت سیاستی آن را در Google Ads بررسی کنید.";
  return {
    id: `policy:${input.adId || input.campaignName || "unknown"}:${input.approvalStatus}`,
    kind: "policy",
    severity: input.approvalStatus === "DISAPPROVED" ? "critical" : "warning",
    title: input.approvalStatus === "DISAPPROVED" ? "تبلیغ به‌دلیل سیاست‌های Google رد شده است" : "تبلیغ با محدودیت سیاستی نمایش داده می‌شود",
    detail,
    entityName: [input.campaignName, input.adId ? `شناسه تبلیغ ${input.adId}` : ""].filter(Boolean).join(" · ") || undefined,
  };
}
