import { formatDashboardToman } from "./dashboard-format";
import type { FinancialChannel } from "./channel-financials";

/** The same atomic card renders any brand's configured financial sources. */
export function FinancialChannelCards({ channels }: { channels: FinancialChannel[] }) {
  return <div className="rangeInsightCards">{channels.map(channel => <article className={channel.color} key={channel.name}>
    <header><span>{channel.name}</span><strong>{channel.leads.toLocaleString("en-US")} لید</strong></header>
    <div className="rangeInsightOutcome"><span><small>قرارداد منتسب</small><b>{channel.contracts.toLocaleString("en-US")}</b></span><span><small>نرخ تبدیل</small><b>{channel.conversionRate === null ? "—" : `${channel.conversionRate.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`}</b></span></div>
    <div className="rangeInsightMetricGrid">{[["هزینه", channel.costToman], ["CPL", channel.cpl], ["CAC", channel.cac]].map(([label, value]) => <span key={String(label)}><small>{label}</small><b>{typeof value === "number" ? formatDashboardToman(value) : label === "CAC" ? "منتظر قرارداد" : "ثبت نشده"}</b></span>)}</div>
  </article>)}</div>;
}
