export type ExpertCostAllocationAudit = {
  scope: string;
  channel: string;
  channelCost: number;
  allocatedCost: number;
  channelLeads: number;
  expertLeads: number;
  balanced: boolean;
};

export type ExpertAllocationDiagnostic = {
  title: string;
  diagnosis: string;
  resolution: string;
  difference: number;
};

/** Turns a financial reconciliation failure into a precise, manager-actionable explanation. */
export function buildExpertAllocationDiagnostic(row: ExpertCostAllocationAudit): ExpertAllocationDiagnostic {
  const difference = row.allocatedCost - row.channelCost;
  const absoluteLeadDifference = Math.abs(row.expertLeads - row.channelLeads);
  const title = `${row.scope} · کانال «${row.channel}»`;

  if (row.channelLeads === 0 && row.channelCost !== 0) {
    return {
      title,
      difference,
      diagnosis: "برای این کانال هزینه ثبت شده، اما در همین محدوده زمانی هیچ لیدی وجود ندارد؛ بنابراین هزینه قابل تقسیم بین کارشناسان نیست.",
      resolution: "در «ثبت بودجه تبلیغات» تاریخ و کانال هزینه را بررسی کنید. اگر هزینه درست است، نگاشت یا نام کانال را در «تنظیمات ← کانال‌ها و هزینه‌ها» با مقدار ثبت‌شده در Google Sheets یکسان کنید و سپس «بروزرسانی دستی» را بزنید.",
    };
  }

  if (row.expertLeads !== row.channelLeads) {
    const direction = row.expertLeads < row.channelLeads ? "کمتر" : "بیشتر";
    return {
      title,
      difference,
      diagnosis: `در خلاصه کانال ${row.channelLeads.toLocaleString("en-US")} لید ثبت شده، اما جمع همین کانال در کارت‌های کارشناسان ${row.expertLeads.toLocaleString("en-US")} لید است؛ یعنی ${absoluteLeadDifference.toLocaleString("en-US")} ردیف ${direction} شمرده شده و هزینه بین مجموعه یکسانی از لیدها تقسیم نشده است.`,
      resolution: "بخش «سلامت داده» را باز کنید و ردیف‌های همین کانال را از نظر کارشناس خالی/ناهماهنگ بررسی کنید. سپس در «تنظیمات» نگاشت ستون کارشناس و نام‌های جایگزین کارشناسان را اصلاح و «بروزرسانی دستی» را اجرا کنید.",
    };
  }

  return {
    title,
    difference,
    diagnosis: "تعداد لید کانال و کارشناسان برابر است، اما جمع ریالی تخصیص با هزینه کانال منطبق نیست؛ این وضعیت به داده خام مربوط نیست و یک اختلاف محاسباتی یا داده مالی تازه‌نشده است.",
    resolution: "ابتدا «بروزرسانی دستی» را بزنید. اگر اختلاف باقی ماند، از «تنظیمات ← پشتیبان و عیب‌یابی» بسته عیب‌یابی بگیرید تا فرمول تخصیص بررسی شود؛ بودجه یا اطلاعات Google Sheets را صرفاً برای برابرکردن عدد تغییر ندهید.",
  };
}
