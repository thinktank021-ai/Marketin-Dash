import type { OverallRangeMetric } from "./marketing-metrics";
import { formatDashboardToman } from "./dashboard-format";

/** Keep strict brand-wide totals distinct from useful, explicitly scoped partial metrics. */
export function OverallCostCard({ metric, kind }: { metric: OverallRangeMetric; kind: "cpl" | "cac" }) {
  const complete = metric.coverageComplete;
  const value = complete ? metric[kind] : kind === "cpl" ? metric.coveredCpl : metric.coveredCac;
  const cost = complete ? metric.totalCost : metric.coveredCost;
  const denominator = kind === "cpl" ? complete ? metric.paidLeads : metric.coveredLeads : complete ? metric.attributableContracts : metric.coveredContracts;
  const unit = kind === "cpl" ? "لید" : "قرارداد قابل انتساب";
  const reason = cost === null ? "هزینهٔ قابل محاسبه موجود نیست" : `بدون ${unit}`;
  const excluded = metric.missingChannels.length ? `خارج از محاسبه: ${metric.missingChannels.join("، ")}` : "بخشی از اطلاعات هزینه هنوز تأیید نشده است";
  const formula = cost === null ? reason : `${formatDashboardToman(cost)} ÷ ${denominator.toLocaleString("en-US")} ${unit} از همان کانال‌ها`;
  return <div className={`selectedDateOverallMetric ${kind} ${complete ? "" : "partialCoverage"}`} title={formula + (complete ? "" : "؛ " + excluded)}>
    <small>{kind.toUpperCase()} {complete ? "کلی برند" : "هزینه‌های ثبت‌شده"}</small>
    <strong>{value === null ? reason : formatDashboardToman(value)}</strong>
    <em>{denominator.toLocaleString("en-US")} {unit} · {complete ? "پوشش کامل" : "پوشش ناقص؛ عدد نهایی کل برند نیست"}</em>
    {!complete && <em className="metricCoverageReason">{excluded}</em>}
  </div>;
}
