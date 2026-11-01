export type TelegramReportBrand = { name: string };

export type TelegramReportSummary = {
  totalToday: number;
  totalMonth: number;
  contractsToday: number;
  contractsMonth: number;
  channels: Record<string, number>;
  routes: Record<string, number>;
  experts: Record<string, number>;
  budgetToday: number | null;
  clicksToday: number | null;
  sheetReceivedAt: string;
  previousTotal: number | null;
  deltaToday: number | null;
  stale: boolean;
};

function normalizeLabel(value: string) {
  return value.normalize("NFKC").replace(/ي|ى/g, "ی").replace(/ك/g, "ک").replace(/[\s\u200c_\-/،,+–—]+/g, "").toLocaleLowerCase("fa");
}

/** Formats a compact RTL Telegram report with truthful zero and unavailable states. */
export function formatReport(brands: Array<{ brand: TelegramReportBrand; summary: TelegramReportSummary }>, now: { date: string; time: string }, kind: "instant" | "end_of_day" | "manual") {
  const number = (value: number) => value.toLocaleString("en-US");
  const signed = (value: number) => `${value >= 0 ? "+" : "−"}${number(Math.abs(value))}`;
  const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const label = kind === "instant" ? "گزارش لحظه‌ای" : kind === "end_of_day" ? "گزارش پایان روز" : "گزارش دستی";
  const rtl = (value: string) => `\u200F${value}\u200F`;
  const lines = [rtl(`📊 ${label} · ${now.date}`), rtl(`🕒 زمان ارسال: ${now.time}`), ""];
  const channelMeta: Array<{ key: string; label: string; emoji: string }> = [
    { key: "پیامک", label: "اس ام اس", emoji: "📩" },
    { key: "گوگل ادز", label: "ادز", emoji: "📣" },
    { key: "اینستاگرام", label: "اینستا", emoji: "📸" },
    { key: "واتساپ", label: "واتس‌اپ", emoji: "💬" },
    { key: "فرم سایت", label: "فرم سایت", emoji: "📝" },
    { key: "مسافر ثابت", label: "مسافر ثابت", emoji: "🔁" },
    { key: "معرفی", label: "معرفی", emoji: "👥" },
    { key: "سایر", label: "سایر", emoji: "📌" },
  ];
  const channelKey = (name: string) => {
    const normalized = normalizeLabel(name);
    if (["گوگلادز", "تبلیغاتگوگل", "ادز"].includes(normalized)) return "گوگل ادز";
    if (["مسافرمثبت", "مسافرقدیمی", "آژانسی", "همکار", "حضوری"].includes(normalized)) return "مسافر ثابت";
    return channelMeta.find(item => normalizeLabel(item.key) === normalized)?.key || name;
  };
  brands.forEach(({ brand, summary }) => {
    const mergedChannels = Object.entries(summary.channels).reduce<Record<string, number>>((result, [name, count]) => {
      const key = channelKey(name);
      result[key] = (result[key] || 0) + count;
      return result;
    }, {});
    const channelLines = channelMeta.filter(item => (mergedChannels[item.key] || 0) > 0).map(item => `${item.emoji} تعداد خط ${item.label}: ${number(mergedChannels[item.key])}`);
    const unknownLines = Object.entries(mergedChannels).filter(([key, count]) => count > 0 && !channelMeta.some(item => item.key === key)).map(([name, count]) => `• تعداد خط ${escapeHtml(name)}: ${number(count)}`);
    const channels = [...channelLines, ...unknownLines].join("\n");
    const best = Object.entries(mergedChannels).sort((a, b) => b[1] - a[1])[0];
    const bestLabel = channelMeta.find(item => item.key === best?.[0])?.label || best?.[0];
    lines.push(rtl(`🏢 ${escapeHtml(brand.name)}`));
    lines.push(rtl(`🖱 تعداد کلیک امروز: ${summary.clicksToday === null ? "ثبت نشده" : number(summary.clicksToday)}`));
    lines.push(rtl(`💰 بودجه مصرف‌شده امروز: ${summary.budgetToday === null ? "ثبت نشده" : `${summary.budgetToday.toFixed(1)} لیر`}`));
    if (summary.previousTotal === null) lines.push(rtl("📋 گزارش قبل: اولین گزارش امروز"));
    else lines.push(rtl(`📋 مجموع خط گزارش قبل: ${number(summary.previousTotal)}`), rtl(`📈 تغییر نسبت به گزارش قبل: ${signed(summary.deltaToday || 0)} خط`));
    if (channels) lines.push(rtl(channels));
    else lines.push(rtl("🧭 کانال‌های ورودی امروز: بدون ورودی ثبت‌شده"));
    lines.push(rtl(`🤝 تعداد قرارداد امروز: ${number(summary.contractsToday)}`));
    if (best) lines.push(rtl(`🏆 بهترین کانال امروز: ${escapeHtml(bestLabel || "")} با ${number(best[1])} لید`));
    if (summary.stale) lines.push(rtl("⚠ هشدار: دریافت داده با تأخیر مواجه است؛ آخرین داده معتبر نمایش داده شد."));
    lines.push(rtl(`<b>📊 مجموع تعداد خط: ${number(summary.totalToday)}</b>`), "");
  });
  const receivedAt = brands.map(item => item.summary.sheetReceivedAt).filter(Boolean).sort().at(-1) || "نامشخص";
  lines.push(rtl(`🗂 آخرین دریافت: ${receivedAt}`));
  return lines.join("\n").trim();
}
