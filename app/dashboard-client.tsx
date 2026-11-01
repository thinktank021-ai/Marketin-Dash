"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Image from "next/image";
import { LogoutButton, clearDashboardCache } from "./logout-button";
import { AliasInput } from "./alias-input";
import { GoogleAdsConnectionCard } from "./google-ads-connection-card";
import { SearchConsoleConnectionCard } from "./search-console-connection-card";
import { TelegramBotSettingsCard } from "./telegram-bot-settings-card";
import { SearchConsolePage } from "./search-console-page";
import { validateAdsAccountIds } from "./google-ads-setup";
import { canonicalRoute } from "./route-normalization";
import { canReadBrandSource } from "./brand-source-policy";
import { manualRefresh, RefreshGate } from "./manual-refresh";
import { DEFAULT_DASHBOARD_RULES, type DashboardRules, type MergeRule } from "./dashboard-rules";
import { aggregateDisplayCosts, calculateOverallRangeMetric, rankContractRoutes } from "./marketing-metrics";
import { buildFinancialChannels, findMissingDailyCosts, type MissingDailyCost } from "./channel-financials";
import { FinancialChannelCards } from "./financial-channel-cards";
import { MissingDailyCostNotice } from "./missing-daily-cost-notice";
import { readFinancialSource } from "./financial-source-loader";
import { OverallCostCard } from "./overall-cost-card";
import { applyDetailedContractDelta, type ContractTableRow } from "./contract-table-state";
import { formatDashboardNumber, formatDashboardToman } from "./dashboard-format";
import { buildCsv, extractPhoneNumbers, findPhoneCellValue, matchesPhoneFilters, resolveExtractionDateRange, type NormalizedPhone } from "./phone-extraction";
import { buildExpertAllocationDiagnostic, type ExpertCostAllocationAudit } from "./financial-diagnostics";
import { resolveGoogleAdsLeadChannels, resolveSheetMonthRequests } from "./google-ads-leads";
import { attributeRouteMetricToCampaigns, buildRoutePerformance, sortGoogleAdsCampaigns } from "./google-ads-campaigns";
import { nextTableSort, sortTableRows, type TableSortState } from "./table-sort";
import { calculateFunnelRates, combineInitialInteractions, estimateSmsMessages } from "./funnel-metrics";
import type { GoogleAdsAlert } from "./google-ads-alerts";
import { resolveDailyReportDate } from "./dashboard-date-selection";
import { RangeAnalyticsDashboard } from "./range-analytics-dashboard";
import { DashboardSectionBoundary } from "./dashboard-runtime-boundary";
import { AppCopyright } from "./app-copyright";

// The original public source remains the safe initial value until the persistent brand registry loads.
const DEFAULT_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRduzbL7dxZ6Wauu8BGoEvq1wH75BV3Qv43Li9kttKrSkDO3yvSQPImduF2UKVwuy1NwzLv3nucNgQu/pub?output=csv";

type DashboardBrand = {
  id: string; name: string; shortName: string; logoUrl: string; sheetCsvUrl: string; sheetIndexUrl: string;
  sheetStatus: "pending" | "connected" | "warning" | "error"; sheetMessage: string;
  googleAdsCustomerId: string; googleAdsLoginCustomerId: string;
  googleAdsStatus: "pending" | "connected" | "warning" | "error"; googleAdsMessage: string;
  configStatus: "draft" | "active"; isDefault: boolean; updatedAt: string;
};

const DEFAULT_BRAND: DashboardBrand = {
  id: "donyagardi", name: "دفتر دنیاگردی", shortName: "دنیاگردی", logoUrl: "/assets/donyagardi-logo-transparent.png",
  sheetCsvUrl: DEFAULT_SHEET_CSV_URL, sheetIndexUrl: "", sheetStatus: "connected", sheetMessage: "منبع فعلی فعال است.",
  googleAdsCustomerId: "6077217562", googleAdsLoginCustomerId: "", googleAdsStatus: "pending",
  googleAdsMessage: "Service Account این دفتر هنوز تنظیم و آزمایش نشده است.", configStatus: "active", isDefault: true, updatedAt: "",
};

// Persists the manager's explicit brand choice independently from cookie timing or browser cookie duplication.
const ACTIVE_BRAND_STORAGE_KEY = "marketing-dashboard:active-brand";

/** Adds an immutable brand identity to every brand-scoped request. */
function withBrand(brandId: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("x-dashboard-brand", brandId);
  return { ...init, headers };
}

/** Fetches data only for the requested brand; API routes reject unknown identities instead of falling back. */
function fetchForBrand(url: string, brandId: string, init: RequestInit = {}) {
  if (manualRefresh.active && (!init.method || init.method === "GET")) {
    const headers = new Headers(init.headers); headers.set("x-dashboard-refresh", "1");
    const signals = [init.signal, manualRefresh.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    init = { ...init, headers, signal: AbortSignal.any(signals) };
  }
  return fetch(url, withBrand(brandId, init)).catch(error => {
    if (manualRefresh.active) manualRefresh.warn("یک منبع پاسخ نداد یا مهلت دریافت تمام شد؛ دادهٔ قبلی حفظ شده است.");
    throw error;
  }).then(async response => {
    if (manualRefresh.active) {
      if (!response.ok) {
        const details = await response.clone().json().catch(() => ({})) as { error?: string };
        manualRefresh.warn(details.error || `دریافت اطلاعات ناموفق بود (کد ${response.status}).`);
      }
      if (response.headers.get("x-sheet-stale") === "true") manualRefresh.warn("گوگل‌شیت پاسخ تازه نداد؛ آخرین دادهٔ معتبر حفظ شد.");
    }
    if (response.status === 401 && response.headers.get("x-dashboard-auth-required") === "1") {
      clearDashboardCache(); window.location.replace("/login");
    }
    return response;
  });
}

// Maps each supported Persian month to its published Google Sheet tab identifier.
type SheetMonthDefinition = { value: string; label: string; gid: string; sheetName?: string };

// Runtime registry is refreshed from the published workbook so new month tabs need no code release.
const sheetMonthRegistries = new Map<string, Map<string, SheetMonthDefinition>>();

/** Registers dynamically discovered month tabs for every Sheet consumer in this browser session. */
function registerSheetMonths(brandId: string, months: SheetMonthDefinition[]) {
  const registry = new Map<string, SheetMonthDefinition>();
  months.forEach(month => registry.set(month.value, month));
  sheetMonthRegistries.set(brandId, registry);
}

// Keeps manager-approved spelling aliases centralized; add new groups only after explicit approval.
let EXPERT_ALIAS_GROUPS: Record<string, string[]> = {};
let ROUTE_MERGE_RULES: MergeRule[] = DEFAULT_DASHBOARD_RULES.routes;
let runtimeRules: DashboardRules = DEFAULT_DASHBOARD_RULES;

// Defines canonical dashboard channel labels and the source aliases merged into each channel.
let channelDefs = DEFAULT_DASHBOARD_RULES.channels.filter(channel => channel.enabled).map(channel => ({ name: channel.name, keys: channel.aliases, color: channel.color, icon: channel.icon }));

type NavigationIconName = "menu" | "dashboard" | "ads" | "search" | "contracts" | "phone" | "budget" | "settings";

/** Uses one consistent outline icon language while keeping the dashboard dependency-free. */
function NavigationIcon({ name }: { name: NavigationIconName }) {
  const paths: Record<NavigationIconName, ReactNode> = {
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
    ads: <><path d="M4 16.5 9.2 9l4 4 6.8-8"/><path d="M4 20V4M4 20h16"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5M7.5 13l2.5-3 2.2 2 3-4"/></>,
    contracts: <><path d="M8 4h8l2 2v14H6V6l2-2Z"/><path d="M9 4v3h6V4M9 14l2 2 4-4"/></>,
    phone: <><path d="M7.2 4.5 9.5 9l-2 1.7a14.2 14.2 0 0 0 5.8 5.8l1.7-2 4.5 2.3-.7 3a2 2 0 0 1-2.2 1.5C9.2 20.4 3.6 14.8 2.7 7.4A2 2 0 0 1 4.2 5.2l3-.7Z"/><path d="M15.5 4.5h4M17.5 2.5v4"/></>,
    budget: <><path d="M3.5 7.5h17v12h-17z"/><path d="M5.5 7.5V5.7a2 2 0 0 1 2-2h9l2 2M16 13.5h4.5v3H16a1.5 1.5 0 0 1 0-3Z"/></>,
    settings: <><path d="m12 3 1.2 2.1 2.4.6 2.1-1.2 1.8 1.8-1.2 2.1.6 2.4L21 12l-2.1 1.2-.6 2.4 1.2 2.1-1.8 1.8-2.1-1.2-2.4.6L12 21l-1.2-2.1-2.4-.6-2.1 1.2-1.8-1.8 1.2-2.1-.6-2.4L3 12l2.1-1.2.6-2.4-1.2-2.1 1.8-1.8 2.1 1.2 2.4-.6L12 3Z"/><circle cx="12" cy="12" r="3"/></>,
  };
  return <svg className="navigationIcon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

// Applies only inside the Google Ads report; the main dashboard keeps these channels separate.
const googleAdsLeadChannels = () => resolveGoogleAdsLeadChannels(runtimeRules.channels);
const primaryGoogleAdsChannel = () => runtimeRules.channels.find(channel => channel.enabled && channel.id === "google_ads")?.name || "گوگل ادز";
// Daily cards show financial KPIs only on channels with a distinct manager-facing budget source.
const DAILY_COST_CHANNELS = new Set(["پیامک", "اینستاگرام", "گوگل ادز"]);
// These manager-approved organic/referral sources must never receive spend or enter financial CPL/CAC denominators.
const NON_COST_CHANNELS = new Set(["مسافر ثابت", "مسافر قدیمی", "همکار", "آژانسی", "سایر", "معرفی"]);

/** Publishes one validated brand configuration to every centralized parser and financial classifier. */
function applyRuntimeRules(rules: DashboardRules) {
  runtimeRules = rules;
  channelDefs = rules.channels.filter(channel => channel.enabled).map(channel => ({ name: channel.name, keys: channel.aliases, color: channel.color, icon: channel.icon }));
  EXPERT_ALIAS_GROUPS = Object.fromEntries(rules.experts.map(rule => [rule.target, rule.aliases]));
  ROUTE_MERGE_RULES = rules.routes;
  DAILY_COST_CHANNELS.clear();
  rules.channels.filter(channel => channel.enabled && (["daily_budget", "monthly_budget"].includes(channel.costMode) || channel.id === "google_ads")).forEach(channel => DAILY_COST_CHANNELS.add(channel.name));
  NON_COST_CHANNELS.clear();
  rules.channels.filter(channel => channel.costMode === "none").forEach(channel => { NON_COST_CHANNELS.add(channel.name); channel.aliases.forEach(alias => NON_COST_CHANNELS.add(alias)); });
}

/** Returns the permanent visual identity assigned to a canonical marketing channel. */
function channelColor(name: string) {
  return channelDefs.find(channel => channel.name === name)?.color || "warning";
}

/** Treats the three approved Google Ads lead surfaces as one financial/filter group in range reports. */
function rangeFilterChannels(filter: string | null) {
  if (!filter) return [];
  return filter === primaryGoogleAdsChannel() ? googleAdsLeadChannels() : [filter];
}

// Connection and data-model types shared by the live and historical report sections.
type SheetState = "checking" | "connected" | "unstable" | "disconnected";
type SheetConnectionSnapshot = { brandId: string; status: SheetState; lastCheck: string; lastSuccessAt: number };
let sheetConnectionSnapshot: SheetConnectionSnapshot = { brandId: "", status: "checking", lastCheck: "—", lastSuccessAt: 0 };
const sheetConnectionListeners = new Set<() => void>();

/** Publishes connection-only changes without rerendering the full analytics tree. */
function updateSheetConnection(patch: Partial<SheetConnectionSnapshot>) {
  const next = { ...sheetConnectionSnapshot, ...patch };
  if (next.brandId === sheetConnectionSnapshot.brandId && next.status === sheetConnectionSnapshot.status && next.lastCheck === sheetConnectionSnapshot.lastCheck && next.lastSuccessAt === sheetConnectionSnapshot.lastSuccessAt) return;
  sheetConnectionSnapshot = next;
  sheetConnectionListeners.forEach(listener => listener());
}

/** Subscribes the compact status component to the isolated connection store. */
function subscribeSheetConnection(listener: () => void) {
  sheetConnectionListeners.add(listener);
  return () => sheetConnectionListeners.delete(listener);
}
type GoogleAdsConnection = {
  status: "checking" | "pending" | "connected" | "disconnected";
  reason?: string;
  degraded?: boolean;
  checkedAt?: string;
  accountName?: string;
  currencyCode?: string | null;
  timeZone?: string | null;
  accountStatus?: string;
  accountAlert?: GoogleAdsAlert | null;
  field?: string;
  detail?: string;
};
type SearchConsoleConnection = {
  status: "checking" | "pending" | "connected" | "disconnected";
  reason?: string;
  checkedAt?: string;
  propertyUrl?: string;
  permissionLevel?: string;
  field?: string;
  detail?: string;
};
type SheetRow = Record<string, string>;
type MonthOption = { value: string; label: string };
type DataConflict = { source: string; rows: string[]; suggestion?: string };
const formatDataConflictNotice = (conflicts: DataConflict[]) => {
  const unique = [...new Map(conflicts.map(conflict => [conflict.source, conflict])).values()];
  if (!unique.length) return "";
  const channels = unique.map(conflict => `«${conflict.source}»`).join("، ");
  const rows = unique.flatMap(conflict => conflict.rows).join("، ");
  return `کانال جدید ${channels} شناسایی شد؛ لیدهای آن مستقل و در آمار محاسبه شده‌اند. برای محاسبهٔ هزینه، روش هزینهٔ این کانال را در تنظیمات مشخص کنید (ردیف‌های ${rows}).`;
};
type AcceptedSnapshot = { signature: string; total: number };
type PendingSnapshot = { signature: string; hits: number };
type ExpertMatrix = Record<string, {
  total: number;
  sheetContracts?: number;
  channelContracts?: Record<string, number>;
  contractRoutes?: Record<string, number>;
  contractRouteChannels?: Record<string, Record<string, number>>;
  aliases?: string[];
  channels: Record<string, number>;
  routes: Record<string, number>;
  routeChannels?: Record<string, Record<string, number>>;
}>;
type MonthlyExpertPerformance = Record<string, { calls: number; sheetContracts: number }>;
type DataHealth = {
  monthTotal: number;
  channelTotal: number;
  routeTotal: number;
  expertTotal: number;
  unknownSources: DataConflict[];
  dateIssueRows: string[];
  missingRouteRows: string[];
  missingExpertRows: string[];
};
type DashboardData = {
  sheetRows: number;
  todayTotal: number;
  average: number;
  change: number;
  sourceCounts: Record<string, number>;
  previousSourceCounts: Record<string, number>;
  routeCounts: Record<string, number>;
  expertMatrix: ExpertMatrix;
  dataConflicts: DataConflict[];
  dateIssueRows: string[];
  monthlyExpertPerformance: MonthlyExpertPerformance;
  channelContractCounts: Record<string, number>;
  activeDateKey: string;
  health: DataHealth;
  activeDateLabel: string;
  monthRecordTotal: number;
  monthRecordDate: string;
};

/** Creates an isolated empty snapshot before a brand's own source is accepted. */
function createEmptyDashboardData(activeDateLabel: string): DashboardData {
  return {
    sheetRows: 0,
    todayTotal: 0,
    average: 0,
    change: 0,
    sourceCounts: {},
    previousSourceCounts: {},
    routeCounts: {},
    expertMatrix: {},
    dataConflicts: [],
    dateIssueRows: [],
    monthlyExpertPerformance: {},
    channelContractCounts: {},
    activeDateKey: "",
    health: { monthTotal: 0, channelTotal: 0, routeTotal: 0, expertTotal: 0, unknownSources: [], dateIssueRows: [], missingRouteRows: [], missingExpertRows: [] },
    activeDateLabel,
    monthRecordTotal: 0,
    monthRecordDate: "",
  };
}
type CachedDashboard = DashboardData & { savedAt: number; signature: string; total: number };
type SelectedDateData = {
  total: number;
  resolvedOutcomeCount: number;
  outcomeCountsByChannel: Record<string, number>;
  average: number;
  recordedDays: number;
  dailyCounts: Array<{ date: string; value: number; contracts: number; weekday: string }>;
  dailyChannelCounts: Record<string, Record<string, number>>;
  dailyChannelContracts: Record<string, Record<string, number>>;
  sourceCounts: Record<string, number>;
  routeCounts: Record<string, number>;
  expertMatrix: ExpertMatrix;
  expertEfficiency: Record<string, { contracts: number; percentage: number; source: string; anomaly: boolean }>;
  expertChannelContracts: Record<string, Record<string, number>>;
  expertContractRouteChannels: Record<string, Record<string, Record<string, number>>>;
  channelContractCounts: Record<string, number>;
  contractAttributionGap: number;
  resolvedContractTotal: number | null;
  manualContractsUnavailable: boolean;
  conflicts: DataConflict[];
  dateIssueRows: string[];
  label: string;
};

function formatFunnelRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value < 0.01) return "<0.01";
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 2 : 1 });
}

function RangeConversionFunnel({ awarenessTotal, adsImpressions, smsEstimatedSent, awarenessIssues, total, resolved, contracts }: {
  awarenessTotal: number | null;
  adsImpressions: number | null;
  smsEstimatedSent: number | null;
  awarenessIssues: string[];
  total: number;
  resolved: number;
  contracts: number;
}) {
  const funnelRates = calculateFunnelRates(awarenessTotal, total, resolved, contracts);
  const leadRate = funnelRates.leadsRate;
  const resolvedRate = funnelRates.resolvedRate;
  const contractRate = funnelRates.contractsRate;
  const overallRate = funnelRates.overallLeadToContractRate;
  const unconvertedExposure = awarenessTotal === null ? null : Math.max(0, awarenessTotal - total);
  const pendingOutcome = Math.max(0, total - resolved);
  const withoutContract = Math.max(0, resolved - contracts);
  const metric = (value: number | null) => value === null ? "ثبت نشده" : value.toLocaleString("en-US");
  const help = (label: string, text: string) => <details className="funnelStageHelp"><summary aria-label={`توضیح ${label}`}>i</summary><div className="funnelStageHelpPanel">{text}</div></details>;
  return <section className="conversionFunnel" aria-label={`فانل بازه انتخابی؛ ${metric(awarenessTotal)} نمایش و ارسال اولیه، ${total} لید، ${resolved} نتیجه ثبت‌شده و ${contracts} قرارداد قابل انتساب`}>
    <header className="conversionFunnelHeader"><div><span>فانل بازهٔ انتخابی</span><strong>از دیده‌شدن تبلیغ تا قرارداد</strong><small>درصد کنار هر مرحله نسبت به ورودی اولیه است · نرخ تبدیل مستقیم داخل توضیح مرحله</small></div><b>{formatFunnelRate(overallRate)}% <small>لید تا قرارداد</small></b></header>
    {awarenessIssues.length > 0 && <p className="funnelCoverageWarning" role="status"><b>داده مرحله اول کامل نیست.</b> عدد فعلی فقط از منابع در دسترس محاسبه شده است؛ {awarenessIssues.join("، ")}.</p>}
    <div className="conversionFunnelStack">
      <article className={`conversionFunnelStage awareness ${awarenessIssues.length ? "incomplete" : ""}`}><div><span>نمایش و ارسال اولیه</span><strong>{metric(awarenessTotal)}</strong><small>Impressions گوگل ادز + برآورد پیامک‌های ارسالی</small></div><em>{funnelRates.awarenessRate === null ? "—" : `${formatFunnelRate(funnelRates.awarenessRate)}%`}</em>{help("نمایش و ارسال اولیه", `این مرحله مبنای فانل است و همیشه 100% ورودی معتبر را نشان می‌دهد. Google Ads: ${metric(adsImpressions)} نمایش + پیامک: ${metric(smsEstimatedSent)} ارسال برآوردی.${awarenessIssues.length ? ` داده ناقص: ${awarenessIssues.join("، ")}. عدد فعلی فقط از منابع موجود است و بخش گمشده صفر فرض نشده است.` : ""} پیامک از جمع روزانهٔ کفِ (هزینه واقعی ÷ قیمت همان ماه) محاسبه می‌شود.`)}<i><b style={{ width: "100%" }}/></i></article>
      <div className="conversionFunnelDrop"><i/> {unconvertedExposure === null ? "تبدیل به لید تا تکمیل داده قابل محاسبه نیست" : `${unconvertedExposure.toLocaleString("en-US")} نمایش/ارسال بدون لید ثبت‌شده`}</div>
      <article className="conversionFunnelStage leads"><div><span>لیدهای دریافت‌شده</span><strong>{total.toLocaleString("en-US")}</strong><small>افرادی که اطلاعات تماسشان در Google Sheets ثبت شده</small></div><em>{formatFunnelRate(leadRate)}%</em>{help("لیدهای دریافت‌شده", "هر ردیف معتبر در Google Sheets که منبع فایل دارد یک لید محسوب می‌شود. درصد این مرحله نسبت لیدها به مجموع نمایش و ارسال اولیه است و نرخ Reach یکتا نیست.")}<i><b style={{ width: `${Math.min(100, leadRate ?? 0)}%` }}/></i></article>
      <div className="conversionFunnelDrop"><i/> {pendingOutcome.toLocaleString("en-US")} لید در انتظار ثبت نتیجه</div>
      <article className="conversionFunnelStage resolved"><div><span>پیگیری انجام‌شده</span><strong>{resolved.toLocaleString("en-US")}</strong><small>لیدهایی که نتیجه تماس برایشان ثبت شده</small></div><em>{formatFunnelRate(resolvedRate)}%</em>{help("پیگیری انجام‌شده", `این مرحله ${resolvedRate === null ? "تا تکمیل ورودی اولیه قابل محاسبه نیست" : `${formatFunnelRate(resolvedRate)}% از ورودی اولیه`} را نشان می‌دهد؛ نرخ تبدیل مستقیم از لید به پیگیری ${funnelRates.resolvedStepRate === null ? "قابل محاسبه نیست" : `${formatFunnelRate(funnelRates.resolvedStepRate)}%`} است.`)}<i><b style={{ width: `${Math.min(100, resolvedRate ?? 0)}%` }}/></i></article>
      <div className="conversionFunnelDrop"><i/> {withoutContract.toLocaleString("en-US")} لید بدون قرارداد ثبت‌شده</div>
      <article className="conversionFunnelStage contracts"><div><span>قرارداد نهایی</span><strong>{contracts.toLocaleString("en-US")}</strong><small>قراردادهای متصل به یک لید مشخص</small></div><em>{formatFunnelRate(contractRate)}%</em>{help("قرارداد نهایی", `این مرحله ${contractRate === null ? "تا تکمیل ورودی اولیه قابل محاسبه نیست" : `${formatFunnelRate(contractRate)}% از ورودی اولیه`} را نشان می‌دهد؛ نرخ مستقیم از لید به قرارداد ${funnelRates.overallLeadToContractRate === null ? "قابل محاسبه نیست" : `${formatFunnelRate(funnelRates.overallLeadToContractRate)}%`} و نرخ از پیگیری به قرارداد ${funnelRates.contractStepRate === null ? "قابل محاسبه نیست" : `${formatFunnelRate(funnelRates.contractStepRate)}%`} است.`)}<i><b style={{ width: `${Math.min(100, contractRate ?? 0)}%` }}/></i></article>
    </div>
  </section>;
}
type RangeComparisonData = {
  total: number;
  average: number;
  recordedDays: number;
  contracts: number | null;
  startDate: string;
  endDate: string;
};
type RangeInsightChannel = { name: string; color: string; leads: number; costToman: number | null; cpl: number | null; cac: number | null };
type RangeInsightFinancials = { totalCost: number | null; totalCpl: number | null; totalCac: number | null; coverageIncomplete: boolean; channels: RangeInsightChannel[] };
type GoogleAdsCampaign = {
  campaignId: string;
  name: string;
  status: "ENABLED" | "PAUSED" | string;
  cost: number;
  impressions: number;
  clicks: number;
  lastActivityDate?: string;
};
type GoogleAdsDaily = {
  date: string;
  cost: number;
  impressions: number;
  clicks: number;
};
type GoogleAdsCampaignDaily = GoogleAdsDaily & { campaignId: string };
type GoogleAdsDailySortKey = "date" | "channel" | "clicks" | "leads" | "contracts" | "cost" | "leadRate" | "cpc" | "cpl" | "cplToman" | "cacToman";
type GoogleAdsCampaignSortKey = "name" | "status" | "impressions" | "clicks" | "cost" | "leads" | "contracts" | "costToman" | "ctr" | "cpc";
type GoogleAdsReport = {
  connected: boolean;
  stale?: boolean;
  checkedAt?: string;
  lastSuccessfulAt?: string;
  account?: { currencyCode?: string; timeZone?: string; status?: string };
  alerts?: GoogleAdsAlert[];
  alertScan?: { campaignsComplete: boolean; policiesComplete: boolean };
  dateRange?: { from: string; to: string };
  totals: { cost: number; impressions: number; clicks: number };
  campaigns: GoogleAdsCampaign[];
  campaignDaily?: GoogleAdsCampaignDaily[];
  daily: GoogleAdsDaily[];
};

function GoogleAdsAlertCenter({ alerts, scan, stale = false }: { alerts: GoogleAdsAlert[]; scan?: GoogleAdsReport["alertScan"]; stale?: boolean }) {
  const criticalCount = alerts.filter(alert => alert.severity === "critical").length;
  const scanIncomplete = scan && (!scan.campaignsComplete || !scan.policiesComplete);
  return <section className={`adsAlertCenter ${criticalCount ? "critical" : alerts.length || scanIncomplete ? "warning" : "healthy"}`} aria-label="مرکز هشدار Google Ads" aria-live="polite">
    <header><div className="adsAlertCenterTitle"><i aria-hidden="true">!</i><div><strong>مرکز هشدار Google Ads</strong><small>{stale ? "آخرین وضعیت سالم ذخیره‌شده؛ بررسی زنده در دسترس نیست" : alerts.length ? `${alerts.length.toLocaleString("en-US")} هشدار فعال برای همین دفتر` : scanIncomplete ? "بررسی بخشی از وضعیت‌ها کامل نشد" : "تعلیق، محدودیت کمپین یا مشکل سیاستی فعالی پیدا نشد"}</small></div></div><span>{stale ? "ذخیره‌شده" : criticalCount ? `${criticalCount.toLocaleString("en-US")} فوری` : alerts.length ? "نیازمند بررسی" : scanIncomplete ? "بررسی ناقص" : "وضعیت عادی"}</span></header>
    {alerts.length > 0 && <div className="adsAlertList">{alerts.map(alert => <article className={alert.severity} key={alert.id}><i aria-hidden="true"/><div><strong>{alert.title}</strong>{alert.entityName && <small>{alert.entityName}</small>}<p>{alert.detail}</p></div></article>)}</div>}
    {scanIncomplete && <p className="adsAlertScanNotice">بررسی {!scan?.campaignsComplete && !scan?.policiesComplete ? "وضعیت کمپین‌ها و سیاست‌های تبلیغ" : !scan?.campaignsComplete ? "وضعیت کمپین‌ها" : "سیاست‌های تبلیغ"} موقتاً کامل نشد؛ این پیام به معنی سالم‌بودن یا وجود مشکل نیست. در بروزرسانی بعدی دوباره بررسی می‌شود.</p>}
  </section>;
}
type ManualContractEntry = {
  expert: string;
  contractCount: number;
  hasLegacyAggregate?: boolean;
  legacyContractCount?: number;
  detailedContractCount?: number;
  updatedAt?: string;
};
type DetailedContractRecord = {
  id: number;
  month: string;
  expert: string;
  leadRef: string;
  sheetRow: string;
  firstContactDate: string;
  sourceChannel: string;
  rawSourceChannel: string;
  route?: string | null;
  createdAt?: string;
};

/** Merges safely normalized expert spellings without losing contract counts from either stored source. */
function aggregateManualContractEntries(entries: ManualContractEntry[]) {
  const totals = new Map<string, ManualContractEntry>();
  entries.forEach(entry => {
    const expert = canonicalExpertName(entry.expert);
    const current = totals.get(expert);
    totals.set(expert, {
      expert,
      contractCount: (current?.contractCount || 0) + Number(entry.contractCount || 0),
      hasLegacyAggregate: Boolean(current?.hasLegacyAggregate || entry.hasLegacyAggregate),
      legacyContractCount: (current?.legacyContractCount || 0) + Number(entry.legacyContractCount || 0),
      detailedContractCount: (current?.detailedContractCount || 0) + Number(entry.detailedContractCount || 0),
      updatedAt: entry.updatedAt || current?.updatedAt,
    });
  });
  return totals;
}

// Namespaces the last-known-valid browser cache by month; this cache is only a resilience fallback.
const DASHBOARD_CACHE_PREFIX = "marketing-dashboard:v2:last-valid:";

// Persian month names used by all user-facing date labels.
const persianMonths = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const persianWeekdays = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];

/** Converts a YYYY/MM month key into a readable Persian month label. */
function formatMonth(monthKey: string) {
  const [year, month] = monthKey.split("/");
  return `${persianMonths[Number(month) - 1] || month} ${year}`;
}

/** Formats a normalized Persian date while keeping every numeral in English. */
function formatRecordedDate(date: string, weekday = "") {
  const [year, month, day] = date.split("/");
  return `${weekday ? `${weekday.trim()} ` : ""}${Number(day)} ${persianMonths[Number(month) - 1] || month} ماه ${year}`;
}

/** Formats only the Persian day and month for compact chart tooltips. */
function formatRecordedDayMonth(date: string) {
  const [, month, day] = date.split("/");
  return `${Number(day)} ${persianMonths[Number(month) - 1] || month}`;
}

/** Removes spacing variants so equivalent source labels can be reconciled reliably. */
function normalizeSource(value: string) {
  return value.replace(/[\s‌_-]/g, "").trim();
}

/** Normalizes only typography-safe expert-name variants without guessing that two different people are the same. */
function normalizeExpertIdentity(value: string) {
  return value
    .trim()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[\s‌_-]+/g, "")
    .toLocaleLowerCase("fa");
}

/** Resolves an expert to the canonical manager-approved name while preserving raw spellings for tooltips. */
function canonicalExpertName(value: string) {
  const clean = value.trim().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\s‌]+/g, " ");
  const normalized = normalizeExpertIdentity(clean);
  const approved = Object.entries(EXPERT_ALIAS_GROUPS).find(([canonical, aliases]) =>
    [canonical, ...aliases].some(alias => normalizeExpertIdentity(alias) === normalized));
  return approved?.[0] || clean;
}

/** Returns a supported month definition and uses the published tab name for newly added Persian months. */
function getSheetMonthDefinition(brandId: string, monthKey: string) {
  return sheetMonthRegistries.get(brandId)?.get(monthKey) || { value: monthKey, label: formatMonth(monthKey), gid: "" };
}

/** Builds a CSV URL that keeps known GIDs stable and discovers future tabs by their Persian month label. */
function getSheetCsvUrl(brandId: string, monthKey: string, nonce: string) {
  const month = getSheetMonthDefinition(brandId, monthKey);
  const selector = month.gid ? `gid=${encodeURIComponent(month.gid)}` : `sheet=${encodeURIComponent(month.label)}`;
  return `/api/sheet-data?${selector}&cachebust=${encodeURIComponent(nonce)}`;
}

/** Enumerates every Persian month touched by a date range, including newly started months. */
function getRangeMonths(startDate: string, endDate: string): MonthOption[] {
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  const months: MonthOption[] = [];
  for (let month = startMonth; month <= endMonth; month = shiftPersianMonth(month, 1)) {
    months.push({ value: month, label: formatMonth(month) });
    if (months.length > 24) break;
  }
  return months;
}

/** Normalizes route labels and applies only the brand's published no-code merge rules. */
function normalizeRoute(value: string) {
  return canonicalRoute(value, ROUTE_MERGE_RULES);
}

/** Resolves a raw Sheet source value to its canonical dashboard channel label. */
function getChannelName(source: string) {
  return channelDefs.find(channel => channel.keys.some(key => normalizeSource(key) === normalizeSource(source)))?.name || source.trim();
}

/** Reads the outcome column across known Sheet header variants without changing its meaning. */
function getRowOutcome(row: SheetRow) {
  return (row["نتیجه"] || row["نتیجه تماس"] || row["نتیجه تماس آخر"] || "").trim();
}

/** Counts only the manager-approved completed-contract result. */
function isContractOutcome(value: string) {
  const normalized = value.replace(/[\s‌_-]/g, "");
  return runtimeRules.contractOutcomes.some(outcome => outcome.replace(/[\s‌_-]/g, "") === normalized);
}

/** Attributes the three manager-approved Sheet sources to Google Ads without changing the main dashboard taxonomy. */
function isGoogleAdsLeadSource(source: string) {
  return googleAdsLeadChannels().includes(getChannelName(source));
}

/** Parses RFC-style CSV, including quoted fields, and preserves the original Sheet row number. */
function parseCsv(input: string): SheetRow[] {
  const table: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); table.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); table.push(row); }
  const rawHeaders = (table.shift() || []).map(h => h.trim().replace(/ي/g, "ی").replace(/ك/g, "ک"));
  const knownHeaderAliases: Record<string, string> = {
    "روز هفته": "روز هفته", "روزهای هفته": "روزهای هفته", "روز های هفته": "روز های هفته",
    "تاریخ": "تاریخ", "منبع فایل": "منبع فایل", "مسیر": "مسیر", "کارشناس": "کارشناس",
    "نتیجه": "نتیجه", "نتیجه تماس": "نتیجه تماس", "نتیجه تماس آخر": "نتیجه تماس آخر",
  };
  const configuredHeaders: Record<string, string> = {
    [runtimeRules.sheetColumns.date]: "تاریخ", [runtimeRules.sheetColumns.weekday]: "روز هفته",
    [runtimeRules.sheetColumns.source]: "منبع فایل", [runtimeRules.sheetColumns.route]: "مسیر",
    [runtimeRules.sheetColumns.expert]: "کارشناس", [runtimeRules.sheetColumns.outcome]: "نتیجه",
    [runtimeRules.sheetColumns.notes]: "توضیحات",
  };
  Object.entries(configuredHeaders).filter(([raw]) => raw.trim()).forEach(([raw, canonical]) => { knownHeaderAliases[raw.replace(/[\s‌]+/g, " ").trim()] = canonical; });
  // Recover a date column whose header was accidentally overwritten by a date, as happened in the historical Novavaran workbook.
  const dateColumnIndex = rawHeaders.findIndex(header => header === "تاریخ");
  const inferredDateColumnIndex = dateColumnIndex >= 0 ? dateColumnIndex : rawHeaders.findIndex((header, index) => {
    if (/^1\d{3}[/.-]\d{1,2}[/.-]\d{1,2}$/.test(normalizeDateDigits(header))) return true;
    const samples = table.slice(0, 20).map(values => normalizeDateDigits((values[index] || "").trim())).filter(Boolean);
    return samples.length >= 3 && samples.filter(value => /^1\d{3}[/.-]\d{1,2}[/.-]\d{1,2}$/.test(value)).length / samples.length >= 0.8;
  });
  const headers = rawHeaders.map((header, index) => index === inferredDateColumnIndex ? "تاریخ" : knownHeaderAliases[header.replace(/[\s‌]+/g, " ").trim()] || header);
  return table.filter(r => r.some(Boolean)).map((values, rowIndex) => ({ ...Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()])), __row: String(rowIndex + 2) }));
}

/** Normalizes Persian/Arabic digits and date separators before validating Sheet block dates. */
function normalizeDateDigits(value: string) {
  return value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[.-]/g, "/");
}

/** Assigns each row to the latest explicit date marker above it, matching the Sheet's daily block structure. */
function assignBlockDates(rows: SheetRow[]): Array<SheetRow & { __effectiveDate: string }> {
  let activeBlockDate = "";
  return rows.map(row => {
    const explicitDate = normalizeDateDigits((row["تاریخ"] || "").trim());
    if (explicitDate) {
      const match = explicitDate.match(/^(1\d{3})\/(\d{1,2})\/(\d{1,2})$/);
      activeBlockDate = match ? `${match[1]}/${match[2].padStart(2, "0")}/${match[3].padStart(2, "0")}` : "";
    }
    return { ...row, __effectiveDate: activeBlockDate };
  });
}

// Shares one fresh Google Sheets response between the daily and selected-range reports.
type ParsedSheetMonth = { csv: string; rows: Array<SheetRow & { __effectiveDate: string }>; fetchedAt: number; stale: boolean };
const parsedSheetCache = new Map<string, ParsedSheetMonth>();
const parsedSheetRequests = new Map<string, Promise<ParsedSheetMonth>>();
const sheetFailures = new Map<string, { at: number; error: Error }>();
let sheetGeneration = 0;

/** Downloads and parses a month once; concurrent consumers reuse the same in-flight request. */
async function fetchParsedSheetMonth(brandId: string, month: string, force = false): Promise<ParsedSheetMonth> {
  force ||= manualRefresh.active;
  const cacheKey = `${sheetGeneration}:${brandId}:${month}`;
  const cached = parsedSheetCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < 25000) return cached;
  const pending = parsedSheetRequests.get(cacheKey);
  if (pending) return pending;
  const failed = sheetFailures.get(cacheKey);
  if (!force && failed && Date.now() - failed.at < 25000) throw failed.error;
  const request = (async () => {
    let csv = "";
    let stale = false;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 25000);
      try {
        const nonce = `${Date.now()}-${month}`;
        const response = await fetchForBrand(getSheetCsvUrl(brandId, month, nonce), brandId, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error || `دریافت اطلاعات ناموفق بود (کد ${response.status}).`);
        }
        if (response.headers.get("x-dashboard-brand") !== brandId) throw new Error("brand_response_mismatch");
        stale = response.headers.get("x-sheet-stale") === "true";
        csv = await response.text();
      } catch (error) {
        const failure = error instanceof Error && error.name !== "AbortError" ? error : new Error("مهلت دریافت اطلاعات از گوگل‌شیت تمام شد.");
        sheetFailures.set(cacheKey, { at: Date.now(), error: failure });
        throw failure;
      } finally {
        window.clearTimeout(timeout);
      }
    if (!csv) throw new Error("پاسخ گوگل‌شیت خالی بود؛ آخرین دادهٔ معتبر حفظ شد.");
    sheetFailures.delete(cacheKey);
    // An identical response skips the expensive CSV parser while refreshing cache age.
    if (cached?.csv === csv) {
      const refreshed = { ...cached, fetchedAt: Date.now(), stale };
      parsedSheetCache.set(cacheKey, refreshed);
      return refreshed;
    }
    const rows = assignBlockDates(parseCsv(csv));
    if (!rows.length || !("تاریخ" in rows[0]) || !("منبع فایل" in rows[0])) throw new Error("invalid sheet");
    const parsed = { csv, rows, fetchedAt: Date.now(), stale };
    parsedSheetCache.set(cacheKey, parsed);
    return parsed;
  })().finally(() => parsedSheetRequests.delete(cacheKey));
  parsedSheetRequests.set(cacheKey, request);
  return request;
}

/** Returns today's Persian date and weekday in the Tehran time zone with English numerals. */
function getPersianToday() {
  const now = new Date();
  const words = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", weekday: "long", year: "numeric", month: "long", day: "numeric" }).formatToParts(now);
  const numeric = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const pick = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  const year = pick(numeric, "year"), month = pick(numeric, "month"), day = pick(numeric, "day");
  return {
    sheetDate: `${year}/${month}/${day}`,
    label: `امروز: ${pick(words, "weekday")} ${pick(words, "day")} ${pick(words, "month")} ماه ${pick(words, "year")}`,
  };
}

/** Builds month metadata required by the custom Persian calendar grid. */
function getPersianMonthCalendar(monthKey: string) {
  const [targetYear, targetMonth] = monthKey.split("/").map(Number);
  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran", year: "numeric", month: "numeric", day: "numeric",
  });
  let firstWeekday = 0;
  let dayCount = 0;
  for (let time = Date.UTC(targetYear + 620, 0, 1, 12); time < Date.UTC(targetYear + 623, 0, 1, 12); time += 86400000) {
    const date = new Date(time);
    const parts = formatter.formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value || 0);
    if (value("year") !== targetYear || value("month") !== targetMonth) continue;
    const day = value("day");
    if (day === 1) firstWeekday = (date.getUTCDay() + 1) % 7;
    dayCount = Math.max(dayCount, day);
  }
  return { firstWeekday, days: Array.from({ length: dayCount }, (_, index) => index + 1) };
}

/** Resolves the Persian weekday for a normalized Persian date without changing its English numerals. */
function getPersianWeekday(dateKey: string) {
  const [year, month, day] = dateKey.split("/").map(Number);
  const { firstWeekday } = getPersianMonthCalendar(`${year}/${String(month).padStart(2, "0")}`);
  return persianWeekdays[(firstWeekday + day - 1) % 7] || "";
}

/** Converts a Persian calendar date to the Gregorian boundary required by Google Ads. */
function persianToGregorian(dateKey: string) {
  const [targetYear, targetMonth, targetDay] = dateKey.split("/").map(Number);
  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric",
  });
  for (let time = Date.UTC(targetYear + 620, 0, 1, 12); time < Date.UTC(targetYear + 623, 0, 1, 12); time += 86400000) {
    const date = new Date(time);
    const parts = formatter.formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value || 0);
    if (value("year") === targetYear && value("month") === targetMonth && value("day") === targetDay) return date.toISOString().slice(0, 10);
  }
  throw new Error("persian_date_conversion_failed");
}

/** Converts a Gregorian Google Ads date back to the dashboard's normalized Persian key. */
function gregorianToPersian(isoDate: string) {
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(`${isoDate}T12:00:00Z`));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")}`;
}

/** Moves a Persian date by an exact number of calendar days through a Gregorian UTC anchor. */
function shiftPersianDate(dateKey: string, offsetDays: number) {
  const anchor = new Date(`${persianToGregorian(dateKey)}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return gregorianToPersian(anchor.toISOString().slice(0, 10));
}

/** Returns the immediately preceding inclusive range with exactly the same calendar-day length. */
function getPreviousEquivalentRange(startDate: string, endDate: string) {
  const start = new Date(`${persianToGregorian(startDate)}T12:00:00Z`).getTime();
  const end = new Date(`${persianToGregorian(endDate)}T12:00:00Z`).getTime();
  const inclusiveDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const previousEnd = shiftPersianDate(startDate, -1);
  return { startDate: shiftPersianDate(previousEnd, -(inclusiveDays - 1)), endDate: previousEnd };
}

/** Describes an absolute and percentage change without inventing a percentage over a zero baseline. */
function formatPeriodComparison(current: number, previous: number, unit: string) {
  const difference = current - previous;
  if (previous === 0) return current === 0
    ? `بازه قبل: 0 ${unit} · بدون تغییر`
    : `بازه قبل: 0 ${unit} · شروع با +${current.toLocaleString("en-US")}`;
  const percent = difference / previous * 100;
  const direction = difference > 0 ? "↑" : difference < 0 ? "↓" : "↔";
  return `بازه قبل: ${previous.toLocaleString("en-US")} ${unit} · ${direction} ${Math.abs(difference).toLocaleString("en-US")} (${formatDashboardNumber(Math.abs(percent))}%)`;
}

// Keep the management labels and calculation rules auditable without hiding them in a tooltip.
const RANGE_INSIGHT_GUIDE = "قانون تحلیل: لید از ردیف دارای «منبع فایل»؛ CPL = هزینه همان کانال ÷ لید همان کانال؛ CAC فقط با قرارداد قابل‌انتساب = هزینه همان کانال ÷ قرارداد همان کانال. نبود قرارداد، تحلیل لید و هزینه را متوقف نمی‌کند. آستانه‌ها: پایدار کمتر از 5%، معمولی 5% تا کمتر از 20%، قوی 20% یا بیشتر، رشد سالم یعنی رشد حداقل 5% لید و قرارداد، واگرایی یعنی رشد حداقل 5% یکی و افت حداقل 5% دیگری، تراکم روزانه 10% یا بیشتر.";

/** Builds one prioritized management insight from leads first, then enriches it with any available contracts and channel costs. */
function buildRangeInsight(current: SelectedDateData, previous: RangeComparisonData | null, financials: RangeInsightFinancials) {
  const leadLeader = [...financials.channels].sort((a, b) => b.leads - a.leads)[0];
  if (!previous) return {
    level: "neutral",
    headline: `${current.total.toLocaleString("en-US")} لید در این بازه ثبت شده؛ تحلیل مالی با دادهٔ موجود فعال است اما مقایسهٔ زمانی هنوز مبنای قبلی ندارد.`,
    detail: `میانگین روزانه ${current.average.toLocaleString("en-US")} لید است${leadLeader?.leads ? ` و ${leadLeader.name} با ${leadLeader.leads.toLocaleString("en-US")} لید، کانال پیشتاز است` : ""}.`,
  };
  const comparisonLabel = `${formatRecordedDate(previous.startDate)} تا ${formatRecordedDate(previous.endDate)}`;
  const leadChange = previous.total > 0 ? (current.total - previous.total) / previous.total * 100 : null;
  const averageChange = previous.average > 0 ? (current.average - previous.average) / previous.average * 100 : null;
  const contractsComparable = current.resolvedContractTotal !== null && previous.contracts !== null;
  const contractChange = contractsComparable && previous.contracts! > 0
    ? (current.resolvedContractTotal! - previous.contracts!) / previous.contracts! * 100
    : null;
  const contractText = contractsComparable
    ? ` · قرارداد ${previous.contracts!.toLocaleString("en-US")} ← ${current.resolvedContractTotal!.toLocaleString("en-US")}`
    : " · قرارداد هنوز پوشش مقایسه‌ای کامل ندارد";
  const coverageText = financials.coverageIncomplete ? " · پوشش هزینه ناقص است" : "";
  const detail = `مقایسه با ${comparisonLabel}: لید ${previous.total.toLocaleString("en-US")} ← ${current.total.toLocaleString("en-US")} · میانگین ${previous.average.toLocaleString("en-US")} ← ${current.average.toLocaleString("en-US")}${contractText}${leadLeader?.leads ? ` · کانال پیشتاز ${leadLeader.name} با ${leadLeader.leads.toLocaleString("en-US")} لید` : ""}${coverageText}.`;
  const result = (level: string, headline: string) => ({ level, headline, detail });
  if (current.total === 0 && previous.total > 0) return result("critical", "این بازه بدون لید است؛ حجم ورودی نسبت به بازهٔ هم‌طول قبل به صفر رسیده و کانال‌های فعال باید بررسی شوند.");
  if (previous.total === 0 && current.total > 0) return result("positive", `این بازه با ${current.total.toLocaleString("en-US")} لید شروع شده؛ بازهٔ هم‌طول قبل هیچ ورودی نداشت.`);
  if (leadChange !== null && contractChange !== null && leadChange >= 5 && contractChange <= -5) return result("warning", "لید بیشتر شده اما قرارداد کمتر است؛ رشد حجم هنوز به رشد کیفیت تبدیل نشده و ترکیب کانال‌ها نیاز به بررسی دارد.");
  if (leadChange !== null && contractChange !== null && leadChange <= -5 && contractChange >= 5) return result("positive", "با لید کمتر، قرارداد بیشتری ثبت شده؛ بهره‌وری پیگیری یا کیفیت ورودی بهبود معنادار دارد.");
  if (leadChange !== null && contractChange !== null && leadChange >= 5 && contractChange >= 5) return result("record", "رشد سالم ثبت شده؛ هم حجم لید و هم قرارداد نسبت به بازهٔ هم‌طول قبل بالاتر است.");
  if (leadChange !== null && contractChange !== null && leadChange <= -5 && contractChange <= -5) return result("critical", "لید و قرارداد هم‌زمان افت کرده‌اند؛ هم حجم ورودی و هم خروجی فروش نیازمند اقدام اصلاحی است.");
  if (leadChange !== null && leadChange >= 20) return result("record", `افزایش قابل‌توجه ورودی ثبت شده؛ تعداد لیدها ${formatDashboardNumber(leadChange)}% بیشتر از بازهٔ هم‌طول قبل است.`);
  if (leadChange !== null && leadChange >= 5) return result("positive", `روند ورودی مثبت است؛ ${formatDashboardNumber(leadChange)}% رشد لید ثبت شده و تحلیل مالی با هزینه‌های فعلی ادامه دارد.`);
  if (leadChange !== null && leadChange <= -20) return result("critical", `افت جدی ورودی ثبت شده؛ لیدها ${formatDashboardNumber(Math.abs(leadChange))}% کمتر از بازهٔ هم‌طول قبل‌اند.`);
  if (leadChange !== null && leadChange <= -5) return result("warning", `افت محدود ورودی دیده می‌شود؛ لیدها ${formatDashboardNumber(Math.abs(leadChange))}% کاهش یافته‌اند و سهم کانال‌ها باید کنترل شود.`);
  if (averageChange !== null && averageChange >= 10) return result("positive", "حجم کل تقریباً پایدار است اما تراکم روزانه بهتر شده؛ لیدها در روزهای فعال بیشتری متمرکز شده‌اند.");
  if (averageChange !== null && averageChange <= -10) return result("warning", "حجم کل تقریباً پایدار است اما میانگین روزانه افت کرده؛ توزیع ورودی میان روزها ضعیف‌تر شده است.");
  return result("neutral", "عملکرد این بازه پایدار است؛ تغییر لید کمتر از آستانهٔ 5% بوده و تحلیل هزینه با دادهٔ موجود معتبر می‌ماند.");
}

/** Moves an arbitrary Persian month key by one or more months without leaving the Persian calendar. */
function shiftPersianMonth(monthKey: string, offset: number) {
  const [year, month] = monthKey.split("/").map(Number);
  const absoluteMonth = year * 12 + month - 1 + offset;
  return `${Math.floor(absoluteMonth / 12)}/${String((absoluteMonth % 12 + 12) % 12 + 1).padStart(2, "0")}`;
}

/** Formats a finite Google Ads money value while preserving the account's original currency. */
function formatAdsMoney(value: number, currency = "TRY") {
  return `${formatAdsNumber(value)} ${currency}`;
}

/** Displays Google Ads metrics as whole numbers while calculations retain full precision. */
function formatAdsNumber(value: number) {
  return formatDashboardNumber(value);
}

/** Makes table sorting visible and accessible to mouse, keyboard and touch users. */
function SortableTableHeader({ label, column, activeColumn, direction, onSort }: {
  label: string;
  column: string;
  activeColumn?: string;
  direction?: "asc" | "desc";
  onSort: (column: string) => void;
}) {
  const active = activeColumn === column;
  return <th aria-sort={active ? direction === "asc" ? "ascending" : "descending" : "none"}>
    <button type="button" className={`tableSortButton ${active ? "active" : ""}`} onClick={() => onSort(column)} title={active ? direction === "asc" ? "مرتب‌سازی نزولی" : "مرتب‌سازی صعودی" : "مرتب‌سازی صعودی"}>
      <span>{label}</span><i aria-hidden="true">{active ? direction === "asc" ? "↑" : "↓" : "↕"}</i>
    </button>
  </th>;
}

/** Selects the compact expanded-panel width class from the visible route-name length. */
function routeDetailWidthClass(route: string) {
  const visibleLength = route.replace(/[\s\u200c]/g, "").length;
  return visibleLength <= 7 ? "shortRoute" : "longRoute";
}

// Budget-entry models keep missing values distinct from an explicitly entered zero.
type BudgetValue = number | null;
type BudgetEntry = {
  date: string;
  weekStart: string;
  weekday: string;
  amounts: Record<string, BudgetValue>;
};
type MonthlyChannelCost = { month: string; channelId: string; mediaToman: BudgetValue; contractorToman: BudgetValue };
type SmsUnitPrice = { month: string; priceToman: number; updatedAt?: string };
type WorkWeek = { weekStart: string; label: string; days: Array<{ date: string; weekday: string }> };
type MonthlyRate = { month: string; tryToToman: number; updatedAt?: string };
type ChannelCostMetric = { costToman: number | null; leads: number; contracts: number; cpl: number | null; cac: number | null };
type ExpertCostMetric = ChannelCostMetric & { coveredChannels: string[] };
type MarketingCostSnapshot = {
  costsByChannel: Record<string, number | null>;
  dailyCosts: Record<string, number | null>;
  adsCostTry: number | null;
  missingRateMonths: string[];
  missingBudgetCells: string[];
  missingContractorFees: string[];
  staleAds: boolean;
  error: boolean;
  sourceIssues?: string[];
  smsEstimatedSent: number | null;
  adsImpressions: number | null;
  awarenessTotal: number | null;
  awarenessIssues: string[];
};
type MarketingCostInputs = { budgets: BudgetEntry[]; monthlyCosts: MonthlyChannelCost[]; smsPrices: SmsUnitPrice[]; rates: Record<string, number>; adsDaily: GoogleAdsDaily[]; staleAds: boolean; budgetsUnavailable?: boolean; adsUnavailable?: boolean; sourceIssues?: string[] };

/** Converts a UTC date anchor to the dashboard's normalized Persian date key. */
function formatPersianDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")}`;
}

/** Builds the Saturday-to-Thursday workweek containing any normalized Persian date. */
function getWorkWeekForPersianDate(dateKey: string): WorkWeek {
  const isoDate = persianToGregorian(dateKey);
  const anchor = new Date(`${isoDate}T12:00:00Z`);
  const daysSinceSaturday = (anchor.getUTCDay() + 1) % 7;
  const start = new Date(anchor.getTime() - daysSinceSaturday * 86400000);
  const weekdayNames = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه"];
  const days = weekdayNames.map((weekday, index) => ({
    weekday,
    date: formatPersianDateKey(new Date(start.getTime() + index * 86400000)),
  }));
  return { weekStart: days[0].date, label: `${formatRecordedDate(days[0].date)} تا ${formatRecordedDate(days[5].date)}`, days };
}

/** Accepts English numeric input and strips visual separators before persistence. */
function parseBudgetInput(value: string): BudgetValue {
  const digits = value.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Adds English thousands separators without converting an empty input into zero. */
function formatBudgetInput(value: BudgetValue) {
  return value === null ? "" : value.toLocaleString("en-US");
}

/** Formats dashboard financial metrics in toman while keeping all numerals English. */
function formatToman(value: number) {
  return formatDashboardToman(value);
}

// Shared Persian definitions keep every CPL/CAC tooltip consistent across the dashboard.
const FINANCIAL_METRIC_DEFINITIONS = "CPL یعنی هزینه جذب هر لید: کل هزینه کانال ÷ تعداد لیدهای همان کانال. CAC یعنی هزینه جذب هر قرارداد: کل هزینه کانال ÷ تعداد قراردادهای قابل انتساب همان کانال.";

/** Converts raw Sheet-source counts into the canonical channel taxonomy used by cost allocation. */
function canonicalChannelCounts(sourceCounts: Record<string, number>) {
  return Object.entries(sourceCounts).reduce<Record<string, number>>((totals, [source, count]) => {
    const channel = getChannelName(source);
    totals[channel] = (totals[channel] || 0) + count;
    return totals;
  }, {});
}

/** Loads one union range for both daily and historical financial reports. */
async function fetchMarketingCostInputs(brandId: string, startDate: string, endDate: string, signal?: AbortSignal): Promise<MarketingCostInputs> {
  const todayDate = getPersianToday().sheetDate;
  endDate = endDate < todayDate ? endDate : todayDate;
  const months = getRangeMonths(startDate, endDate).map(month => month.value);
  const needsAds = runtimeRules.channels.some(channel => channel.enabled && channel.costMode === "google_ads");
  const [budget, rate, ads] = await Promise.all([
    readFinancialSource<{ entries: BudgetEntry[]; monthlyCosts: MonthlyChannelCost[]; smsPrices: SmsUnitPrice[] }>(() => fetchForBrand(`/api/budgets?from=${encodeURIComponent(startDate)}&to=${encodeURIComponent(endDate)}`, brandId, { cache: "no-store", signal }), data => Array.isArray(data.entries) && Array.isArray(data.monthlyCosts) && Array.isArray(data.smsPrices)),
    needsAds ? readFinancialSource<{ rates: MonthlyRate[] }>(() => fetchForBrand(`/api/exchange-rate?months=${encodeURIComponent(months.join(","))}`, brandId, { cache: "no-store", signal }), data => Array.isArray(data.rates)) : Promise.resolve({ data: { rates: [] }, pending: false }),
    needsAds ? readFinancialSource<GoogleAdsReport>(() => fetchForBrand(`/api/google-ads/report?from=${encodeURIComponent(persianToGregorian(startDate))}&to=${encodeURIComponent(persianToGregorian(endDate))}&cachebust=${Date.now()}`, brandId, { cache: "no-store", signal }), data => Boolean(data.totals) && Array.isArray(data.daily)) : Promise.resolve({ data: null, pending: false }),
  ]);
  return {
    budgets: budget.data?.entries || [],
    monthlyCosts: budget.data?.monthlyCosts || [],
    smsPrices: budget.data?.smsPrices || [],
    rates: Object.fromEntries((rate.data?.rates || []).map(rate => [rate.month, rate.tryToToman])),
    adsDaily: ads.data?.daily || [],
    staleAds: Boolean(ads.data?.stale),
    budgetsUnavailable: !budget.data,
    adsUnavailable: needsAds && !ads.data,
    sourceIssues: [
      !budget.data ? "دریافت بودجهٔ دستی ناموفق بود؛ این به معنی خالی بودن هزینه‌ها نیست. بروزرسانی دستی را بزنید." : "",
      needsAds && !rate.data ? "نرخ ارز دریافت نشد؛ فقط هزینه‌های ارزی قابل محاسبه نیستند. هزینه‌های دستی حفظ شده‌اند." : "",
      needsAds && !ads.data ? ads.pending ? "Google Ads این برند هنوز متصل نیست. هزینه‌های دستیِ ثبت‌شده محاسبه می‌شوند؛ هزینه و شاخص‌های Google Ads تا اتصال، نامشخص می‌مانند. اگر از آن استفاده نمی‌کنید، روش هزینهٔ کانال‌های مربوط را در تنظیمات اصلاح کنید." : "گزارش Google Ads دریافت نشد؛ فقط هزینه‌های وابسته به Google Ads نامشخص‌اند. هزینه‌های دستیِ ثبت‌شده حفظ شده‌اند؛ اتصال Google Ads را بررسی کنید." : "",
    ].filter(Boolean),
  };
}

/** Slices shared financial inputs to one exact report range and allocates Google Ads spend. */
function buildMarketingCostSnapshot(inputs: MarketingCostInputs, startDate: string, endDate: string, channelCounts: Record<string, number>): MarketingCostSnapshot {
  const todayDate = getPersianToday().sheetDate;
  endDate = endDate < todayDate ? endDate : todayDate;
  const budgets = inputs.budgets.filter(entry => entry.date >= startDate && entry.date <= endDate);
  const adsDaily = inputs.adsDaily.filter(day => {
    const date = gregorianToPersian(day.date);
    return date >= startDate && date <= endDate;
  });
  try {
    const expectedWorkdays = getRangeMonths(startDate, endDate).flatMap(month => getPersianMonthCalendar(month.value).days.map(day => `${month.value}/${String(day).padStart(2, "0")}`))
      .filter(date => date >= startDate && date <= endDate && getPersianWeekday(date) !== "جمعه");
    const budgetByDate = new Map(budgets.map(entry => [entry.date, entry]));
    const sumDailyBudget = (channelId: string) => expectedWorkdays.length > 0 && expectedWorkdays.every(date => budgetByDate.get(date)?.amounts[channelId] !== null && budgetByDate.get(date)?.amounts[channelId] !== undefined)
      ? budgets.reduce((sum, entry) => sum + (entry.amounts[channelId] || 0), 0) : null;
    const dailyChannels = runtimeRules.channels.filter(channel => channel.enabled && channel.costMode === "daily_budget");
    const smsChannel = dailyChannels.find(channel => channel.id === "sms");
    const smsEstimate = smsChannel ? estimateSmsMessages(
      expectedWorkdays,
      new Map(expectedWorkdays.map(date => [date, budgetByDate.get(date)?.amounts[smsChannel.id]])),
      new Map(inputs.smsPrices.map(item => [item.month, item.priceToman])),
    ) : { total: 0, missingBudgetDates: [], missingPriceMonths: [] };
    const googleAdsConfigured = runtimeRules.channels.some(channel => channel.enabled && channel.costMode === "google_ads");
    const adsImpressions = googleAdsConfigured
      ? inputs.adsUnavailable ? null : adsDaily.reduce((sum, day) => sum + day.impressions, 0)
      : 0;
    const awarenessTotal = combineInitialInteractions(smsEstimate.total, adsImpressions);
    const awarenessIssues = [
      ...smsEstimate.missingPriceMonths.map(value => `قیمت پیامک ${formatMonth(value)} ثبت نشده`),
      smsEstimate.missingBudgetDates.length ? `هزینه پیامک ${smsEstimate.missingBudgetDates.length.toLocaleString("en-US")} روز کاری ثبت نشده` : "",
      googleAdsConfigured && inputs.adsUnavailable ? "Impressions گوگل ادز دریافت نشده" : "",
    ].filter(Boolean);
    const rangeMonths = getRangeMonths(startDate, endDate);
    const monthlyCost = (month: string, channelId: string) => inputs.monthlyCosts.find(item => item.month === month && item.channelId === channelId);
    const missingBudgetCells = inputs.budgetsUnavailable ? [] : [
      ...dailyChannels.flatMap(channel => expectedWorkdays.filter(date => budgetByDate.get(date)?.amounts[channel.id] == null).map(date => `${formatRecordedDayMonth(date)} · ${channel.name}`)),
      ...rangeMonths.flatMap(month => runtimeRules.channels.filter(channel => channel.enabled && channel.costMode === "monthly_budget" && monthlyCost(month.value, channel.id)?.mediaToman == null).map(channel => `${formatMonth(month.value)} · ${channel.name}`)),
    ];
    const missingContractorFees = !inputs.budgetsUnavailable && runtimeRules.formulas.includeContractorFees ? rangeMonths.flatMap(month => {
      return runtimeRules.channels.filter(channel => channel.enabled && channel.contractorEnabled && (channel.costMode === "daily_budget" || channel.costMode === "monthly_budget" || channel.id === "google_ads"))
        .filter(channel => monthlyCost(month.value, channel.id)?.contractorToman == null).map(channel => `${formatMonth(month.value)} · ${channel.name}`);
    }) : [];
    /** Allocates each monthly media/contractor amount by the fraction of non-Friday workdays inside the report range. */
    const allocatedMonthlyAmount = (month: string, channelId: string, field: "mediaToman" | "contractorToman") => {
      const fee = monthlyCost(month, channelId)?.[field];
      if (fee === null || fee === undefined) return null;
      const workdays = getPersianMonthCalendar(month).days
        .map(day => `${month}/${String(day).padStart(2, "0")}`)
        .filter(date => getPersianWeekday(date) !== "جمعه");
      const selectedWorkdays = workdays.filter(date => date >= startDate && date <= endDate).length;
      return workdays.length ? fee * (selectedWorkdays / workdays.length) : 0;
    };
    const googleAdsContractorCost = runtimeRules.formulas.includeContractorFees && runtimeRules.channels.some(channel => channel.enabled && channel.id === "google_ads" && channel.contractorEnabled) ? rangeMonths.reduce<number | null>((sum, month) => {
      const value = allocatedMonthlyAmount(month.value, "google_ads", "contractorToman");
      return sum === null || value === null ? null : sum + value;
    }, 0) : 0;
    const missingRateMonths = [...new Set(adsDaily
      .filter(day => day.cost > 0 && inputs.rates[gregorianToPersian(day.date).slice(0, 7)] === undefined)
      .map(day => gregorianToPersian(day.date).slice(0, 7)))];
    const convertedAdsMediaCost = inputs.adsUnavailable || missingRateMonths.length ? null : adsDaily.reduce((sum, day) => {
      const month = gregorianToPersian(day.date).slice(0, 7);
      return sum + day.cost * (inputs.rates[month] || 0);
    }, 0);
    const convertedAdsCost = convertedAdsMediaCost === null || googleAdsContractorCost === null ? null : convertedAdsMediaCost + googleAdsContractorCost;
    const adsChannels = googleAdsLeadChannels();
    const adsLeadTotal = adsChannels.reduce((sum, channel) => sum + (channelCounts[channel] || 0), 0);
    const costsByChannel: Record<string, number | null> = {};
    runtimeRules.channels.filter(channel => channel.enabled && (channel.costMode === "daily_budget" || channel.costMode === "monthly_budget")).forEach(channel => {
      const mediaCost = channel.costMode === "daily_budget" ? sumDailyBudget(channel.id) : rangeMonths.reduce<number | null>((sum, month) => {
        const value = allocatedMonthlyAmount(month.value, channel.id, "mediaToman");
        return sum === null || value === null ? null : sum + value;
      }, 0);
      const contractorCost = runtimeRules.formulas.includeContractorFees && channel.contractorEnabled ? rangeMonths.reduce<number | null>((sum, month) => {
        const value = allocatedMonthlyAmount(month.value, channel.id, "contractorToman");
        return sum === null || value === null ? null : sum + value;
      }, 0) : 0;
      costsByChannel[channel.name] = mediaCost === null || contractorCost === null ? null : mediaCost + contractorCost;
    });
    adsChannels.forEach(channel => {
      costsByChannel[channel] = convertedAdsCost === null ? null
        : adsLeadTotal > 0 ? convertedAdsCost * ((channelCounts[channel] || 0) / adsLeadTotal)
        : channel === runtimeRules.channels.find(item => item.id === "google_ads")?.name ? convertedAdsCost : 0;
    });
    const workdaysByMonth = new Map<string, string[]>();
    rangeMonths.forEach(month => {
      workdaysByMonth.set(month.value, getPersianMonthCalendar(month.value).days
        .map(day => `${month.value}/${String(day).padStart(2, "0")}`)
        .filter(date => getPersianWeekday(date) !== "جمعه"));
    });
    const adsByDate = new Map(adsDaily.map(day => [gregorianToPersian(day.date), day]));
    const dailyCosts: Record<string, number | null> = {};
    expectedWorkdays.forEach(date => {
      const month = date.slice(0, 7);
      let total = 0;
      let complete = true;
      dailyChannels.forEach(channel => {
        const value = budgetByDate.get(date)?.amounts[channel.id];
        if (value === null || value === undefined) complete = false;
        else total += value;
        if (runtimeRules.formulas.includeContractorFees && channel.contractorEnabled) {
          const fee = monthlyCost(month, channel.id)?.contractorToman;
          const days = workdaysByMonth.get(month) || [];
          if (fee === null || fee === undefined || !days.length) complete = false;
          else total += fee / days.length;
        }
      });
      runtimeRules.channels.filter(channel => channel.enabled && channel.costMode === "monthly_budget").forEach(channel => {
        const media = monthlyCost(month, channel.id)?.mediaToman;
        const days = workdaysByMonth.get(month) || [];
        if (media === null || media === undefined || !days.length) complete = false;
        else total += media / days.length;
        if (runtimeRules.formulas.includeContractorFees && channel.contractorEnabled) {
          const fee = monthlyCost(month, channel.id)?.contractorToman;
          if (fee === null || fee === undefined || !days.length) complete = false;
          else total += fee / days.length;
        }
      });
      const googleAdsChannels = adsChannels;
      if (googleAdsChannels.length) {
        const adsDay = adsByDate.get(date);
        if (inputs.adsUnavailable || !adsDay) complete = false;
        else {
          const rate = inputs.rates[month];
          if (adsDay.cost > 0 && rate === undefined) complete = false;
          else total += adsDay.cost * (rate || 0);
        }
        if (runtimeRules.formulas.includeContractorFees && runtimeRules.channels.some(channel => channel.enabled && channel.id === "google_ads" && channel.contractorEnabled)) {
          const fee = monthlyCost(month, "google_ads")?.contractorToman;
          const days = workdaysByMonth.get(month) || [];
          if (fee === null || fee === undefined || !days.length) complete = false;
          else total += fee / days.length;
        }
      }
      dailyCosts[date] = complete ? total : null;
    });
    return { costsByChannel, dailyCosts, adsCostTry: inputs.adsUnavailable ? null : adsDaily.reduce((sum, day) => sum + day.cost, 0), missingRateMonths, missingBudgetCells, missingContractorFees, staleAds: inputs.staleAds, error: false, sourceIssues: inputs.sourceIssues, smsEstimatedSent: smsEstimate.total, adsImpressions, awarenessTotal, awarenessIssues };
  } catch {
    return { costsByChannel: {}, dailyCosts: {}, adsCostTry: null, missingRateMonths: [], missingBudgetCells: [], missingContractorFees: [], staleAds: false, error: true, smsEstimatedSent: null, adsImpressions: null, awarenessTotal: null, awarenessIssues: ["محاسبه مرحله اول فانل انجام نشد"] };
  }
}

/** Supplies standalone workspaces with the same validated financial calculation pipeline. */
async function fetchMarketingCosts(brandId: string, startDate: string, endDate: string, channelCounts: Record<string, number>, signal?: AbortSignal) {
  try {
    const inputs = await fetchMarketingCostInputs(brandId, startDate, endDate, signal);
    return buildMarketingCostSnapshot(inputs, startDate, endDate, channelCounts);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { costsByChannel: {}, dailyCosts: {}, adsCostTry: null, missingRateMonths: [], missingBudgetCells: [], missingContractorFees: [], staleAds: false, error: true, smsEstimatedSent: null, adsImpressions: null, awarenessTotal: null, awarenessIssues: ["داده‌های مرحله اول فانل دریافت نشد"] } satisfies MarketingCostSnapshot;
  }
}

/** Calculates CPL and CAC only when both the numerator and matching denominator are valid. */
function buildChannelCostMetrics(channelCounts: Record<string, number>, contractCounts: Record<string, number>, snapshot: MarketingCostSnapshot | null) {
  return Object.fromEntries(Object.keys(channelCounts).map(channel => {
    const leads = channelCounts[channel] || 0;
    const contracts = contractCounts[channel] || 0;
    const costToman = NON_COST_CHANNELS.has(channel)
      ? null
      : snapshot && Object.prototype.hasOwnProperty.call(snapshot.costsByChannel, channel) ? snapshot.costsByChannel[channel] : null;
    return [channel, {
      costToman,
      leads,
      contracts,
      cpl: costToman !== null && leads > 0 ? costToman / leads : null,
      cac: costToman !== null && contracts > 0 ? costToman / contracts : null,
    } satisfies ChannelCostMetric];
  }));
}

/** Attributes spend to an expert and uses only cost-covered leads/contracts as matching denominators. */
function buildExpertCostMetric(
  expertChannels: Record<string, number>,
  totalChannels: Record<string, number>,
  expertChannelContracts: Record<string, number>,
  snapshot: MarketingCostSnapshot | null,
): ExpertCostMetric {
  const coveredChannels = Object.entries(snapshot?.costsByChannel || {})
    .filter(([channel, cost]) => !NON_COST_CHANNELS.has(channel) && typeof cost === "number" && Number.isFinite(cost))
    .map(([channel]) => channel);
  let costToman = 0;
  coveredChannels.forEach(channel => {
    const leads = expertChannels[channel] || 0;
    const channelCost = snapshot?.costsByChannel[channel];
    const channelLeads = totalChannels[channel] || 0;
    if (typeof channelCost !== "number" || channelLeads <= 0 || leads <= 0) return;
    costToman += channelCost * (leads / channelLeads);
  });
  const leadTotal = coveredChannels.reduce((sum, channel) => sum + (expertChannels[channel] || 0), 0);
  const contracts = coveredChannels.reduce((sum, channel) => sum + (expertChannelContracts[channel] || 0), 0);
  const hasAnyCost = coveredChannels.some(channel => (expertChannels[channel] || 0) > 0);
  return {
    costToman: hasAnyCost ? costToman : null,
    leads: leadTotal,
    contracts,
    cpl: hasAnyCost && leadTotal > 0 ? costToman / leadTotal : null,
    cac: hasAnyCost && contracts > 0 ? costToman / contracts : null,
    coveredChannels,
  };
}

/** Reconciles each paid channel's complete spend with the sum allocated across every expert, including unassigned leads. */
function auditExpertCostAllocation(scope: string, experts: ExpertMatrix, totalChannels: Record<string, number>, snapshot: MarketingCostSnapshot | null): ExpertCostAllocationAudit[] {
  return Object.entries(snapshot?.costsByChannel || {})
    .filter(([channel, cost]) => !NON_COST_CHANNELS.has(channel) && typeof cost === "number" && Number.isFinite(cost))
    .map(([channel, cost]) => {
      const channelCost = cost as number;
      const channelLeads = totalChannels[channel] || 0;
      const expertLeads = Object.values(experts).reduce((sum, expert) => sum + (expert.channels[channel] || 0), 0);
      const allocatedCost = channelLeads > 0
        ? Object.values(experts).reduce((sum, expert) => sum + channelCost * ((expert.channels[channel] || 0) / channelLeads), 0)
        : 0;
      const roundedDifference = Math.abs(Number(allocatedCost.toFixed(1)) - Number(channelCost.toFixed(1)));
      return { scope, channel, channelCost, allocatedCost, channelLeads, expertLeads, balanced: expertLeads === channelLeads && roundedDifference === 0 };
    });
}

/** Keeps missing financial or contract coverage visible as one compact, expandable manager reminder. */
function CoverageNotice({ title, reasons }: { title: string; reasons: string[] }) {
  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  if (!uniqueReasons.length) return null;
  return <details className="coverageNotice"><summary><i>!</i><span>{title}</span><b>{uniqueReasons.length.toLocaleString("en-US")} مورد</b></summary><div>{uniqueReasons.map(reason => <p key={reason}>{reason}</p>)}</div></details>;
}

/** Shows every confirmed contract destination and its attributable source channels inside the same compact chip. */
function ContractRouteChips({ routes, routeChannels = {}, unknown = 0 }: { routes: Record<string, number>; routeChannels?: Record<string, Record<string, number>>; unknown?: number }) {
  const mergedRoutes = { ...routes };
  if (unknown > 0) mergedRoutes["بدون مسیر قابل انتساب"] = (mergedRoutes["بدون مسیر قابل انتساب"] || 0) + unknown;
  const items = Object.entries(mergedRoutes)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
  if (!items.length) return null;
  const summary = items.map(([route, count]) => {
    const channels = Object.entries(routeChannels[route] || {}).filter(([, value]) => value > 0).map(([channel, value]) => `${channel} ${value.toLocaleString("en-US")}`).join("، ");
    return `${route}: ${count.toLocaleString("en-US")}${channels ? ` (${channels})` : " (کانال نامشخص)"}`;
  }).join("، ");
  return <div className="contractRouteChips" title={`قراردادهای تأییدشده: ${summary}`}><small>مقصد و کانال قرارداد</small><div>{items.map(([route, count]) => {
    const channels = Object.entries(routeChannels[route] || {}).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
    return <span className={`contractRouteChip ${route === "بدون مسیر قابل انتساب" ? "unknown" : ""}`} key={route}><span className="contractRouteIdentity">{route}<b>{count.toLocaleString("en-US")}</b></span><span className="contractSourceList">{channels.length ? channels.map(([channel, value]) => <em className={channelColor(channel)} key={channel}><i/>{channel}{count > 1 && <b>{value.toLocaleString("en-US")}</b>}</em>) : <em className="unknown"><i/>کانال نامشخص</em>}</span></span>;
  })}</div></div>;
}

/** Renders every non-Friday budget day in the selected Persian month plus its fixed TRY rate. */
function BudgetEntryPage({ brandId, month, rules }: { brandId: string; month: string; rules: DashboardRules }) {
  const dailyChannels = useMemo(() => rules.channels.filter(channel => channel.enabled && channel.costMode === "daily_budget"), [rules]);
  const smsChannel = useMemo(() => dailyChannels.find(channel => channel.id === "sms"), [dailyChannels]);
  const monthlyChannels = useMemo(() => rules.channels.filter(channel => channel.enabled && channel.costMode === "monthly_budget"), [rules]);
  const googleAdsPrimary = rules.channels.find(channel => channel.enabled && channel.id === "google_ads" && channel.costMode === "google_ads");
  const costChannels = useMemo(() => rules.channels.filter(channel => channel.enabled && channel.costMode !== "none" && (channel.costMode !== "google_ads" || channel.id === "google_ads")), [rules]);
  const monthDays = useMemo<BudgetEntry[]>(() => getPersianMonthCalendar(month).days.map(day => {
    const date = `${month}/${String(day).padStart(2, "0")}`;
    return { date, weekday: getPersianWeekday(date), weekStart: getWorkWeekForPersianDate(date).weekStart, amounts: Object.fromEntries(dailyChannels.map(channel => [channel.id, null])) };
  }).filter(entry => entry.weekday !== "جمعه"), [dailyChannels, month]);
  const monthStart = `${month}/01`;
  const monthEnd = `${month}/${String(getPersianMonthCalendar(month).days.at(-1) || 1).padStart(2, "0")}`;
  const [entries, setEntries] = useState<BudgetEntry[]>(monthDays);
  const [monthlyCosts, setMonthlyCosts] = useState<Record<string, MonthlyChannelCost>>({});
  const [tryToToman, setTryToToman] = useState<BudgetValue>(null);
  const [smsUnitPriceToman, setSmsUnitPriceToman] = useState<BudgetValue>(null);
  const [googleAdsMediaTry, setGoogleAdsMediaTry] = useState<BudgetValue>(null);
  const [googleAdsMediaMessage, setGoogleAdsMediaMessage] = useState("در حال دریافت هزینه رسانه Google Ads…");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [message, setMessage] = useState("در حال دریافت بودجه‌های ذخیره‌شده…");
  const budgetDirty = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const loadBudget = () => Promise.all([
      fetchForBrand(`/api/budgets?from=${encodeURIComponent(monthStart)}&to=${encodeURIComponent(monthEnd)}`, brandId, { cache: "no-store", signal: controller.signal }),
      fetchForBrand(`/api/exchange-rate?month=${encodeURIComponent(month)}`, brandId, { cache: "no-store", signal: controller.signal }),
    ]).then(async ([response, rateResponse]) => {
      const payload = await response.json() as { entries?: BudgetEntry[]; monthlyCosts?: MonthlyChannelCost[]; smsPrices?: SmsUnitPrice[]; error?: string };
      const ratePayload = await rateResponse.json() as { rates?: MonthlyRate[]; error?: string };
      if (!response.ok || !rateResponse.ok) throw new Error(payload.error || ratePayload.error || "خطا در دریافت بودجه‌ها");
      if (budgetDirty.current) throw new Error("تغییرات ذخیره‌نشدهٔ بودجه حفظ شد؛ ابتدا ذخیره کنید و سپس بروزرسانی را بزنید.");
      const saved = new Map((payload.entries || []).map(entry => [entry.date, entry]));
      setEntries(monthDays.map(day => ({ ...day, amounts: Object.fromEntries(dailyChannels.map(channel => [channel.id, saved.get(day.date)?.amounts?.[channel.id] ?? null])) })));
      setMonthlyCosts(Object.fromEntries(costChannels.map(channel => {
        const savedCost = payload.monthlyCosts?.find(item => item.month === month && item.channelId === channel.id);
        return [channel.id, savedCost || { month, channelId: channel.id, mediaToman: null, contractorToman: null }];
      })));
      setTryToToman(ratePayload.rates?.[0]?.tryToToman ?? null);
      setSmsUnitPriceToman(payload.smsPrices?.find(item => item.month === month)?.priceToman ?? null);
      setStatus("ready");
      setMessage(payload.entries?.length ? "بودجه‌های ذخیره‌شدهٔ ماه دریافت شد." : "برای این ماه هنوز بودجه‌ای ثبت نشده است.");
    }).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error"); setMessage(error instanceof Error ? error.message : "دریافت اطلاعات ناموفق بود؛ دوباره تلاش کنید.");
      if (manualRefresh.active) manualRefresh.warn(error instanceof Error ? error.message : "بودجه دریافت نشد.");
    });
    void loadBudget();
    const unregister = manualRefresh.register("بودجه و نرخ", loadBudget);
    return () => { unregister(); controller.abort(); };
  }, [brandId, costChannels, dailyChannels, month, monthDays, monthEnd, monthStart]);

  useEffect(() => {
    if (!googleAdsPrimary) return;
    const controller = new AbortController();
    const loadBudgetAds = () => fetchForBrand(`/api/google-ads/report?from=${encodeURIComponent(persianToGregorian(monthStart))}&to=${encodeURIComponent(persianToGregorian(monthEnd))}&cachebust=${Date.now()}`, brandId, { cache: "no-store", signal: controller.signal })
      .then(async response => { const payload = await response.json() as GoogleAdsReport & { error?: string }; if (!response.ok || !payload.totals) throw new Error(); setGoogleAdsMediaTry(payload.totals.cost); setGoogleAdsMediaMessage(`هزینه رسانه از Google Ads دریافت شد · ${payload.account?.currencyCode || "TRY"}`); })
      .catch(error => { if (error instanceof DOMException && error.name === "AbortError") return; setGoogleAdsMediaTry(null); setGoogleAdsMediaMessage("Google Ads این برند متصل نیست یا هزینه ماه دریافت نشد."); });
    void loadBudgetAds();
    const unregister = manualRefresh.register("هزینه گوگل ادز", loadBudgetAds);
    return () => { unregister(); controller.abort(); };
  }, [brandId, googleAdsPrimary, monthEnd, monthStart]);

  const updateDaily = (date: string, channelId: string, rawValue: string) => {
    budgetDirty.current = true;
    const value = parseBudgetInput(rawValue);
    setEntries(current => current.map(entry => entry.date === date ? { ...entry, amounts: { ...entry.amounts, [channelId]: value } } : entry));
    if (status === "saved") setStatus("ready");
  };
  const updateMonthly = (channelId: string, field: "mediaToman" | "contractorToman", rawValue: string) => {
    budgetDirty.current = true;
    setMonthlyCosts(current => ({ ...current, [channelId]: { ...(current[channelId] || { month, channelId, mediaToman: null, contractorToman: null }), [field]: parseBudgetInput(rawValue) } }));
    if (status === "saved") setStatus("ready");
  };
  const dailyTotal = (channelId: string) => entries.reduce((sum, entry) => sum + (entry.amounts[channelId] || 0), 0);
  const googleAdsMediaToman = googleAdsMediaTry === null || tryToToman === null ? null : googleAdsMediaTry * tryToToman;
  const channelSummary = costChannels.map(channel => {
    const media = channel.costMode === "daily_budget" ? dailyTotal(channel.id) : channel.costMode === "monthly_budget" ? monthlyCosts[channel.id]?.mediaToman ?? null : channel.id === "google_ads" ? googleAdsMediaToman : 0;
    const contractor = channel.contractorEnabled ? monthlyCosts[channel.id]?.contractorToman ?? null : 0;
    return { channel, media, contractor, total: media === null || contractor === null ? null : media + contractor };
  });
  const knownOverallTotal = channelSummary.reduce((sum, item) => sum + (item.media || 0) + (item.contractor || 0), 0);
  const overallComplete = channelSummary.every(item => item.total !== null) && dailyChannels.every(channel => entries.every(entry => entry.amounts[channel.id] !== null));
  const filledCount = entries.reduce((count, entry) => count + dailyChannels.filter(channel => entry.amounts[channel.id] !== null).length, 0);
  const smsMonthEstimate = smsChannel && smsUnitPriceToman !== null && smsUnitPriceToman > 0 && entries.every(entry => entry.amounts[smsChannel.id] !== null)
    ? entries.reduce((sum, entry) => sum + Math.floor((entry.amounts[smsChannel.id] || 0) / smsUnitPriceToman), 0)
    : null;

  const saveBudgets = async () => {
    setStatus("saving"); setMessage("در حال ذخیرهٔ بودجه‌ها…");
    try {
      const requests: Promise<Response>[] = [fetchForBrand("/api/budgets", brandId, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ month, entries, monthlyCosts: costChannels.map(channel => monthlyCosts[channel.id] || { month, channelId: channel.id, mediaToman: null, contractorToman: null }), ...(smsChannel ? { smsUnitPriceToman } : {}) }) })];
      if (tryToToman !== null) requests.push(fetchForBrand("/api/exchange-rate", brandId, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ month, tryToToman }) }));
      const responses = await Promise.all(requests);
      if (responses.some(response => !response.ok)) throw new Error();
      budgetDirty.current = false;
      setStatus("saved"); setMessage(`بودجهٔ ${costChannels.length.toLocaleString("en-US")} کانال با موفقیت ذخیره شد.`); window.dispatchEvent(new Event("dashboard:budgets-saved"));
    } catch { setStatus("error"); setMessage("ذخیره انجام نشد؛ اطلاعات واردشده حفظ شده و می‌توانید دوباره تلاش کنید."); }
  };

  const gridStyle = { gridTemplateColumns: `145px repeat(${Math.max(1, dailyChannels.length)},minmax(150px,1fr))` };
  return <section className="budgetWorkspace glass" aria-label="ثبت بودجه ماهانه تبلیغات">
    <div className="budgetHeader"><div><span>ثبت هزینه‌های تبلیغاتی · {formatMonth(month)}</span><h2>بودجهٔ کانال‌های هزینه‌دار</h2><p>کانال‌های این صفحه از تنظیمات همین برند ساخته می‌شوند و با افزودن کانال جدید، بدون تغییر کد به بودجه اضافه خواهند شد.</p></div><div className={`budgetSaveState ${status}`}><i/><span>{message}</span></div></div>
    {(smsChannel || googleAdsPrimary) && <div className="budgetControls">
      {smsChannel && <label><span>قیمت نهایی هر پیامک در {formatMonth(month)}</span><div><input inputMode="numeric" pattern="[0-9,]*" value={formatBudgetInput(smsUnitPriceToman)} onChange={event => { budgetDirty.current = true; setSmsUnitPriceToman(parseBudgetInput(event.target.value)); if (status === "saved") setStatus("ready"); }} placeholder="قیمت ثبت نشده" aria-describedby="sms-price-guide"/><em>تومان</em></div><small id="sms-price-guide">مختص همین دفتر و همین ماه · برآورد ماه: {smsMonthEstimate === null ? "پس از تکمیل قیمت و هزینه روزانه" : `${smsMonthEstimate.toLocaleString("en-US")} پیامک`}</small></label>}
      {googleAdsPrimary && <label><span>نرخ ثابت 1 TRY در {formatMonth(month)}</span><div><input inputMode="numeric" pattern="[0-9,]*" value={formatBudgetInput(tryToToman)} onChange={event => { budgetDirty.current = true; setTryToToman(parseBudgetInput(event.target.value)); }} placeholder="نرخ ثبت نشده"/><em>تومان</em></div><small>مختص همین دفتر و همین ماه · مبنای تبدیل هزینه Google Ads به تومان</small></label>}
    </div>}
    {(monthlyChannels.length > 0 || costChannels.some(channel => channel.contractorEnabled)) && <div className="dynamicMonthlyCostGrid" aria-label="هزینه‌های ماهانه کانال‌ها">
      {monthlyChannels.map(channel => <label className={channel.color} key={`media-${channel.id}`}><span>هزینه تبلیغات ماهانه {channel.name}</span><div><input inputMode="numeric" value={formatBudgetInput(monthlyCosts[channel.id]?.mediaToman ?? null)} onChange={event => updateMonthly(channel.id, "mediaToman", event.target.value)} placeholder="ثبت نشده"/><em>تومان</em></div></label>)}
      {costChannels.filter(channel => channel.contractorEnabled).map(channel => <label className={channel.color} key={`contractor-${channel.id}`}><span>دستمزد ماهانه پیمانکار {channel.name}</span><div><input inputMode="numeric" value={formatBudgetInput(monthlyCosts[channel.id]?.contractorToman ?? null)} onChange={event => updateMonthly(channel.id, "contractorToman", event.target.value)} placeholder="ثبت نشده"/><em>تومان</em></div></label>)}
    </div>}
    <div className="budgetSourceHint zeroRule" role="note"><i>i</i><span><b>تفاوت مهم صفر و خانهٔ خالی:</b> عدد <b>0</b> یعنی مدیر تأیید کرده در آن روز یا ماه هیچ هزینه‌ای انجام نشده است؛ خانهٔ خالی یعنی هزینه هنوز ثبت نشده و محاسبات CPL و CAC با پیام «پوشش هزینه ناقص» متوقف می‌شوند. دستمزدهای ماهانه در بازه‌های کوتاه‌تر متناسب با روزهای کاری سرشکن می‌شوند. {googleAdsPrimary ? googleAdsMediaMessage : ""}</span></div>
    {dailyChannels.length > 0 ? <div className="budgetTable dynamicBudgetTable" role="table" aria-label="بودجه روزانه کانال‌های دستی">
      <div className="budgetTableHead" role="row" style={gridStyle}><strong>روز کاری</strong>{dailyChannels.map(channel => <strong className={channel.color} key={channel.id}>{channel.name}</strong>)}</div>
      {entries.map((entry, index) => <div className={`budgetRow ${index === 0 || entries[index - 1].weekStart !== entry.weekStart ? "startsWeek" : ""}`} style={gridStyle} role="row" key={entry.date}>
        {(index === 0 || entries[index - 1].weekStart !== entry.weekStart) && <div className="budgetWeekLabel">{getWorkWeekForPersianDate(entry.date).label}</div>}
        <div className="budgetDay"><strong>{entry.weekday}</strong><span>{formatRecordedDate(entry.date)}</span></div>
        {dailyChannels.map(channel => <label className={`budgetInput ${channel.color}`} key={channel.id}><span>بودجه {channel.name}</span><input inputMode="numeric" pattern="[0-9,]*" value={formatBudgetInput(entry.amounts[channel.id] ?? null)} onChange={event => updateDaily(entry.date, channel.id, event.target.value)} placeholder="ثبت نشده" aria-label={`بودجه ${channel.name} ${entry.weekday}`}/><em>تومان</em></label>)}
      </div>)}
    </div> : <div className="settingsHint"><b>کانال روزانه‌ای تعریف نشده است</b><span>از تنظیمات، روش هزینه کانال را روی «بودجه روزانه دستی» قرار دهید.</span></div>}
    <div className="budgetTotals dynamicTotals">{channelSummary.map(item => <article className={item.channel.color} key={item.channel.id}><span>جمع نهایی {item.channel.name}</span><strong>{item.total === null ? "ثبت نشده" : item.total.toLocaleString("en-US")}</strong><small>{item.media === null ? "هزینه تبلیغات ثبت‌نشده" : `${item.media.toLocaleString("en-US")} تبلیغات`} + {item.contractor === null ? "دستمزد ثبت‌نشده" : `${item.contractor.toLocaleString("en-US")} پیمانکار`}</small></article>)}<article className="total"><span>{overallComplete ? "جمع کل هزینه ماه" : "جمع هزینه‌های ثبت‌شده ماه"}</span><strong>{knownOverallTotal.toLocaleString("en-US")}</strong><small>{overallComplete ? "تبلیغات + تمام دستمزدها · تومان" : "پوشش ناقص؛ مبالغ خالی در جمع نیستند"}</small></article></div>
    <div className="budgetActions"><span>{filledCount.toLocaleString("en-US")} از {(entries.length * dailyChannels.length).toLocaleString("en-US")} خانه روزانه تکمیل شده · صفر، مقدار معتبر است.</span><button type="button" onClick={() => void saveBudgets()} disabled={status === "loading" || status === "saving"}>{status === "saving" ? "در حال ذخیره…" : "ذخیره بودجه‌ها، قیمت پیامک و نرخ"}</button></div>
  </section>;
}

type ContractEditorRow = ContractTableRow;

type ContractLeadCandidate = {
  leadRef: string;
  sheetRow: string;
  expert: string;
  firstContactDate: string;
  sourceChannel: string;
  rawSourceChannel: string;
  route: string;
  label: string;
};

/** Renders legacy monthly totals alongside the new one-row-per-Sheet-lead contract workflow. */
function ExpertContractsPage({ brandId, month, onSaved }: {
  brandId: string;
  month: string;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<ContractEditorRow[]>([]);
  const [records, setRecords] = useState<DetailedContractRecord[]>([]);
  const [candidates, setCandidates] = useState<ContractLeadCandidate[]>([]);
  const [contractCostMetrics, setContractCostMetrics] = useState<Record<string, ChannelCostMetric>>({});
  const [selectedLeadRef, setSelectedLeadRef] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DetailedContractRecord | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [message, setMessage] = useState("در حال دریافت کارشناسان و قراردادها…");

  // Reload all contract sources after a create/delete action without reloading the dashboard page.
  const loadContracts = useCallback(async (signal?: AbortSignal) => {
    setStatus("loading");
    setMessage("در حال دریافت کارشناسان و قراردادها…");
    try {
      const [sheetResponse, contractResponse, recordResponse] = await Promise.all([
        fetchForBrand(getSheetCsvUrl(brandId, month, `${Date.now()}-contracts`), brandId, { cache: "no-store", signal }),
        fetchForBrand(`/api/expert-contracts?month=${encodeURIComponent(month)}`, brandId, { cache: "no-store", signal }),
        fetchForBrand(`/api/expert-contract-records?month=${encodeURIComponent(month)}`, brandId, { cache: "no-store", signal }),
      ]);
      if (!sheetResponse.ok || !contractResponse.ok || !recordResponse.ok) throw new Error("contract_sources_unavailable");
      const validSheetRows = assignBlockDates(parseCsv(await sheetResponse.text()))
        .filter(row => Boolean((row["منبع فایل"] || "").trim()));
      const observedMonths = new Set(validSheetRows.map(row => row.__effectiveDate.slice(0, 7)).filter(Boolean));
      if (observedMonths.size > 0 && !observedMonths.has(month)) throw new Error("selected_month_tab_unavailable");
      const sheetRows = validSheetRows.filter(row => row.__effectiveDate?.startsWith(month));
      const contractPayload = await contractResponse.json() as { entries?: ManualContractEntry[] };
      const recordPayload = await recordResponse.json() as { records?: DetailedContractRecord[] };
      const storedRecords = (recordPayload.records || []).map(record => ({ ...record, sourceChannel: getChannelName(record.sourceChannel) }));
      const registeredLeadRefs = new Set(storedRecords.map(record => record.leadRef));
      const performance = new Map<string, { calls: number; sheetContracts: number }>();
      const nextCandidates: ContractLeadCandidate[] = [];
      const monthChannelCounts: Record<string, number> = {};
      const attributableContracts = new Map<string, string>();
      sheetRows.forEach(row => {
        const rawExpert = (row["کارشناس"] || "").trim();
        const expert = rawExpert ? canonicalExpertName(rawExpert) : "";
        if (expert) {
          const current = performance.get(expert) || { calls: 0, sheetContracts: 0 };
          current.calls += 1;
          if (isContractOutcome(getRowOutcome(row))) current.sheetContracts += 1;
          performance.set(expert, current);
        }
        const rawSourceChannel = (row["منبع فایل"] || "").trim();
        const sourceChannel = getChannelName(rawSourceChannel);
        monthChannelCounts[sourceChannel] = (monthChannelCounts[sourceChannel] || 0) + 1;
        if (isContractOutcome(getRowOutcome(row))) attributableContracts.set(`${month}:${row.__row}`, sourceChannel);
        if (!expert || !row.__effectiveDate) return;
        const sheetRow = row.__row;
        const leadRef = `${month}:${sheetRow}`;
        const route = normalizeRoute(row["مسیر"] || "");
        nextCandidates.push({
          leadRef,
          sheetRow,
          expert,
          firstContactDate: row.__effectiveDate,
          sourceChannel,
          rawSourceChannel,
          route,
          label: `${formatRecordedDayMonth(row.__effectiveDate)} · ${expert} · ${sourceChannel} · ${route} · ردیف ${sheetRow}`,
        });
      });
      storedRecords.forEach(record => attributableContracts.set(record.leadRef, record.sourceChannel));
      const monthContractCounts: Record<string, number> = {};
      attributableContracts.forEach(channel => { monthContractCounts[channel] = (monthContractCounts[channel] || 0) + 1; });
      const calendarDays = getPersianMonthCalendar(month).days;
      const monthStart = `${month}/01`;
      const monthLastDay = `${month}/${String(calendarDays.at(-1) || 1).padStart(2, "0")}`;
      const currentPersianDate = getPersianToday().sheetDate;
      const monthEnd = month === currentPersianDate.slice(0, 7) && currentPersianDate < monthLastDay ? currentPersianDate : monthLastDay;
      const costSnapshot = await fetchMarketingCosts(brandId, monthStart, monthEnd, monthChannelCounts, signal);
      setContractCostMetrics(buildChannelCostMetrics(monthChannelCounts, monthContractCounts, costSnapshot));
      // The detailed list below is the single source of truth for the upper table too.
      // Ignore the API's separately aggregated detailed count so a stale parallel response can never leave the two sections out of sync.
      const legacy = aggregateManualContractEntries((contractPayload.entries || []).map(entry => ({
        ...entry,
        contractCount: Number(entry.legacyContractCount || 0),
        detailedContractCount: 0,
      })));
      const detailedByExpert = storedRecords.reduce<Map<string, number>>((totals, record) => {
        const expert = canonicalExpertName(record.expert);
        totals.set(expert, (totals.get(expert) || 0) + 1);
        return totals;
      }, new Map());
      const experts = [...new Set([...performance.keys(), ...legacy.keys(), ...detailedByExpert.keys()])].sort((a, b) => a.localeCompare(b, "fa"));
      setRows(experts.map(expert => {
        const saved = legacy.get(expert);
        const legacyContractCount = saved?.legacyContractCount || 0;
        const detailedContractCount = detailedByExpert.get(expert) || 0;
        const hasManual = Boolean(saved?.hasLegacyAggregate || detailedContractCount > 0);
        return {
          expert,
          calls: performance.get(expert)?.calls || 0,
          sheetContracts: performance.get(expert)?.sheetContracts || 0,
          hasLegacyAggregate: Boolean(saved?.hasLegacyAggregate),
          legacyContractCount,
          detailedContractCount,
          resolvedContractCount: hasManual ? legacyContractCount + detailedContractCount : (performance.get(expert)?.sheetContracts || 0) > 0 ? performance.get(expert)!.sheetContracts : null,
          updatedAt: saved?.updatedAt,
        };
      }));
      setRecords(storedRecords);
      setCandidates(nextCandidates.filter(candidate => !registeredLeadRefs.has(candidate.leadRef)));
      setSelectedLeadRef(current => nextCandidates.some(candidate => candidate.leadRef === current && !registeredLeadRefs.has(current)) ? current : "");
      setStatus("ready");
      setMessage(`${experts.length.toLocaleString("en-US")} کارشناس · ${storedRecords.length.toLocaleString("en-US")} قرارداد ردیفی در ${formatMonth(month)}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      // Preserve the last valid table when refresh fails.
      setStatus("error");
      setMessage("دریافت کارشناسان یا قراردادهای ذخیره‌شده انجام نشد؛ دوباره تلاش کنید.");
    }
  }, [brandId, month]);

  // Load the month's Sheet leads, immutable legacy totals, and detailed records together.
  /* eslint-disable react-hooks/set-state-in-effect -- this effect intentionally hydrates UI state from three external durable sources */
  useEffect(() => {
    const controller = new AbortController();
    void loadContracts(controller.signal);
    const unregister = manualRefresh.register("قراردادها", () => loadContracts(controller.signal));
    return () => { unregister(); controller.abort(); };
  }, [loadContracts]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedLead = candidates.find(candidate => candidate.leadRef === selectedLeadRef) || null;
  const availableChannels = [...new Set(candidates.map(candidate => candidate.sourceChannel))].sort((a, b) => a.localeCompare(b, "fa"));
  const anomalies = rows.filter(row => row.resolvedContractCount !== null && row.resolvedContractCount > row.calls);
  const pendingContractExperts = rows.filter(row => row.resolvedContractCount === null).length;

  // Persist the selected Sheet lead as exactly one detailed contract record.
  const saveRecord = async () => {
    if (!selectedLead) return;
    setStatus("saving");
    setMessage("در حال ثبت قرارداد انتخاب‌شده…");
    try {
      const response = await fetchForBrand("/api/expert-contract-records", brandId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month, ...selectedLead }),
      });
      const payload = await response.json() as { error?: string; record?: DetailedContractRecord };
      if (!response.ok) throw new Error(payload.error || "contract_record_save_failed");
      if (!payload.record?.id) throw new Error("پاسخ ثبت قرارداد کامل نبود؛ اطلاعات دوباره دریافت می‌شود.");
      setRecords(current => [payload.record!, ...current.filter(record => record.id !== payload.record!.id)]);
      setCandidates(current => current.filter(candidate => candidate.leadRef !== payload.record!.leadRef));
      setSelectedLeadRef("");
      setRows(current => applyDetailedContractDelta(current, canonicalExpertName(payload.record!.expert), 1));
      setStatus("saved");
      setMessage("قرارداد ثبت شد؛ جدول بالا به‌روزرسانی شد و در حال تطبیق نهایی است.");
      onSaved();
      await loadContracts();
      setStatus("saved");
      setMessage("قرارداد با تاریخ اولین تماس و کانال Google Sheets ثبت شد.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error && error.message !== "contract_record_save_failed" ? error.message : "ثبت قرارداد انجام نشد؛ دوباره تلاش کنید.");
    }
  };

  // Delete only a newly created row after an explicit confirmation; legacy totals remain protected.
  const deleteRecord = async (record: DetailedContractRecord) => {
    setStatus("saving");
    setMessage("در حال حذف قرارداد ردیفی…");
    try {
      const response = await fetchForBrand("/api/expert-contract-records", brandId, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: record.id }),
      });
      const payload = await response.json() as { error?: string; deleted?: boolean };
      if (!response.ok || !payload.deleted) throw new Error(payload.error || "contract_record_delete_failed");
      setPendingDelete(null);
      setRecords(current => current.filter(item => item.id !== record.id));
      setRows(current => applyDetailedContractDelta(current, canonicalExpertName(record.expert), -1));
      setStatus("saved");
      setMessage("قرارداد حذف شد؛ جدول بالا به‌روزرسانی شد و در حال تطبیق نهایی است.");
      onSaved();
      await loadContracts();
      setStatus("saved");
      setMessage("ثبت اشتباه حذف شد و آمار قراردادها، نرخ تبدیل و CAC دوباره محاسبه شد.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error && error.message !== "contract_record_delete_failed" ? error.message : "حذف قرارداد انجام نشد؛ دوباره تلاش کنید.");
    }
  };

  return <section className="contractWorkspace glass" aria-label="ثبت ردیفی قرارداد کارشناسان">
    <div className="contractHeader">
      <div><span>قرارداد کارشناسان · {formatMonth(month)}</span><h2>ثبت هر قرارداد با انتخاب لید</h2><p>ماه از انتخاب مشترک هدر گرفته می‌شود؛ تاریخ اولین تماس و کانال مستقیماً از Google Sheets تکمیل می‌شوند.</p></div>
    </div>
    <div className="contractRuleHint" role="note"><i>i</i><span><b>قانون ثبت:</b> هر قرارداد یک ردیف مستقل و متصل به یک لید واقعی است. سابقه‌های عددی قبلی به‌صورت <b>تجمیعی و قفل‌شده</b> حفظ شده‌اند و ثبت‌های جدید به آن اضافه می‌شوند.</span></div>
    <div className={`contractSaveState ${status}`} role="status"><i/><span>{message}</span></div>
    <CoverageNotice title="یادآور تکمیل قراردادها" reasons={[
      pendingContractExperts > 0 ? `تعداد قرارداد ${pendingContractExperts.toLocaleString("en-US")} کارشناس هنوز نه دستی ثبت شده و نه نتیجهٔ قابل‌تأیید Google Sheets دارد.` : "",
      records.length === 0 ? "هنوز قرارداد ردیفی دارای تاریخ و کانال برای این ماه ثبت نشده است." : "",
    ]}/>
    {anomalies.length > 0 && <div className="dataWarning contractAnomaly" role="alert"><strong>⚠ Anomaly قرارداد</strong><span>{anomalies.map(row => `${row.expert}: ${row.resolvedContractCount!.toLocaleString("en-US")} قرارداد در برابر ${row.calls.toLocaleString("en-US")} تماس`).join(" | ")}؛ داده حفظ شده اما نیازمند بررسی است.</span></div>}

    <div className="contractLeadForm" aria-label="انتخاب لید قرارداد">
      <label><span>انتخاب لید از Google Sheets</span><select value={selectedLeadRef} onChange={event => setSelectedLeadRef(event.target.value)} disabled={status === "loading" || status === "saving"}><option value="">یک لید را انتخاب کنید</option>{candidates.map(candidate => <option value={candidate.leadRef} key={candidate.leadRef}>{candidate.label}</option>)}</select></label>
      <label><span>کارشناس</span><input value={selectedLead?.expert || "—"} readOnly/></label>
      <label><span>تاریخ اولین تماس</span><input value={selectedLead ? formatRecordedDate(selectedLead.firstContactDate) : "—"} readOnly/></label>
      <label><span>کانال ورودی</span><select value={selectedLead?.sourceChannel || ""} disabled><option value="">—</option>{availableChannels.map(channel => <option value={channel} key={channel}>{channel}</option>)}</select></label>
      <button type="button" onClick={() => void saveRecord()} disabled={!selectedLead || status === "loading" || status === "saving"}>{status === "saving" ? "در حال ثبت…" : "ثبت قرارداد"}</button>
    </div>
    <p className="contractLeadNote">فهرست لیدها فقط شامل ردیف‌های دارای «منبع فایل»، تاریخ معتبر و کارشناس است. لید ثبت‌شده دوباره در فهرست ظاهر نمی‌شود.</p>

    <div className="contractTable" role="table" aria-label={`قرارداد کارشناسان ${formatMonth(month)}`}>
      <div className="contractTableHead" role="row"><strong>کارشناس</strong><strong>تماس معتبر</strong><strong>کل قرارداد</strong><strong>سابقه تجمیعی</strong><strong>ثبت ردیفی</strong><strong>نرخ تبدیل</strong></div>
      {rows.map(row => {
        const hasManual = row.hasLegacyAggregate || row.detailedContractCount > 0;
        const resolvedContracts = row.resolvedContractCount;
        const efficiency = resolvedContracts !== null && row.calls > 0 ? resolvedContracts / row.calls * 100 : null;
        const anomaly = resolvedContracts !== null && resolvedContracts > row.calls;
        return <div className={`contractRow ${anomaly ? "anomaly" : ""}`} role="row" key={row.expert}>
          <div className="contractExpert"><span>{row.expert.slice(0, 1)}</span><strong>{row.expert}</strong>{row.calls === 0 && <small>در شیت این ماه نیست</small>}</div>
          <b>{row.calls.toLocaleString("en-US")}</b>
          <div className="contractResolved total" title={`عدد نهایی مورد استفاده در نرخ تبدیل و CAC؛ منبع: ${hasManual ? "سابقه تجمیعی + ثبت ردیفی" : "Google Sheets"}`}><strong>{resolvedContracts === null ? "—" : resolvedContracts.toLocaleString("en-US")}</strong><small>{hasManual ? "تجمیعی + ردیفی" : "Google Sheets"}</small></div>
          <div className="contractResolved legacy" title="سابقه عددی قبلی؛ برای جلوگیری از حذف یا دوباره‌شماری قفل شده است."><strong>{row.legacyContractCount.toLocaleString("en-US")}</strong><small>قفل‌شده</small></div>
          <div className="contractResolved"><strong>{row.detailedContractCount.toLocaleString("en-US")}</strong><small>ردیف جدید</small></div>
          <div className={`contractEfficiency ${anomaly ? "anomaly" : ""}`} title={resolvedContracts === null ? "تعداد قرارداد هنوز ثبت نشده است." : `${resolvedContracts.toLocaleString("en-US")} قرارداد از ${row.calls.toLocaleString("en-US")} تماس معتبر؛ منبع: ${hasManual ? "سابقه تجمیعی + ثبت ردیفی" : "Google Sheets"}`}><strong>{efficiency === null ? "—" : `${formatDashboardNumber(efficiency)}%`}</strong><small>{efficiency === null ? "منتظر ثبت" : "نرخ تبدیل"}</small></div>
        </div>;
      })}
    </div>
    <div className="contractRecordList"><div className="contractRecordHead"><div><strong>مدیریت قراردادهای ثبت‌شده</strong><small>اگر قراردادی اشتباهی ثبت شده، همان ردیف را از این فهرست حذف کنید.</small></div><span>{records.length.toLocaleString("en-US")} قرارداد</span></div>{records.length === 0 ? <p>هنوز قرارداد ردیفی برای این ماه ثبت نشده است.</p> : records.map(record => <article className={`channelAccent ${channelColor(record.sourceChannel)}`} key={record.id}><div><strong>{record.expert}</strong><span>{formatRecordedDate(record.firstContactDate)} · {record.sourceChannel}{record.route ? ` · ${normalizeRoute(record.route)}` : ""}</span><small>Google Sheets · ردیف {record.sheetRow} · CAC کانال: {contractCostMetrics[record.sourceChannel]?.cac === null || contractCostMetrics[record.sourceChannel]?.cac === undefined ? "ثبت نشده" : formatToman(contractCostMetrics[record.sourceChannel].cac!)}</small></div><button type="button" onClick={() => setPendingDelete(record)} disabled={status === "saving"} aria-label={`حذف ثبت اشتباه ${record.expert}`}>حذف ثبت اشتباه</button></article>)}</div>
    {pendingDelete && <div className="contractDeleteBackdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && status !== "saving") setPendingDelete(null); }}>
      <div className="contractDeleteDialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-contract-title" aria-describedby="delete-contract-description">
        <div className="contractDeleteIcon" aria-hidden="true">!</div>
        <div><strong id="delete-contract-title">حذف ثبت اشتباه قرارداد</strong><p id="delete-contract-description">این ثبت فقط از داشبورد همین برند حذف می‌شود و ردیف اصلی Google Sheets تغییری نمی‌کند.</p></div>
        <dl><div><dt>کارشناس</dt><dd>{pendingDelete.expert}</dd></div><div><dt>تاریخ اولین تماس</dt><dd>{formatRecordedDate(pendingDelete.firstContactDate)}</dd></div><div><dt>کانال و مسیر</dt><dd>{pendingDelete.sourceChannel}{pendingDelete.route ? ` · ${pendingDelete.route}` : ""}</dd></div><div><dt>ردیف Google Sheets</dt><dd>{pendingDelete.sheetRow}</dd></div></dl>
        <div className="contractDeleteActions"><button type="button" onClick={() => setPendingDelete(null)} disabled={status === "saving"}>انصراف</button><button type="button" className="danger" onClick={() => void deleteRecord(pendingDelete)} disabled={status === "saving"}>{status === "saving" ? "در حال حذف…" : "تأیید و حذف قرارداد"}</button></div>
      </div>
    </div>}
  </section>;
}

/** Renders the independent Google Ads report with Persian range selection and reconciled lead data. */
function GoogleAdsReportPage({ brandId, today, reloadToken, availableSheetMonths, onSetup }: { brandId: string; today: ReturnType<typeof getPersianToday>; reloadToken: number; availableSheetMonths: SheetMonthDefinition[]; onSetup: () => void }) {
  // Default the report to the first day of the current Persian month through today.
  const currentMonth = today.sheetDate.slice(0, 7);
  const [startDate, setStartDate] = useState(`${currentMonth}/01`);
  const [endDate, setEndDate] = useState(today.sheetDate);
  const [calendarMonth, setCalendarMonth] = useState(currentMonth);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const [report, setReport] = useState<GoogleAdsReport | null>(null);
  const [leadCounts, setLeadCounts] = useState<Record<string, number>>({});
  const [contractCounts, setContractCounts] = useState<Record<string, number>>({});
  const [monthlyRates, setMonthlyRates] = useState<Record<string, number>>({});
  const [googleAdsContractorFees, setGoogleAdsContractorFees] = useState<Record<string, BudgetValue>>({});
  const [leadBreakdown, setLeadBreakdown] = useState<Record<string, Record<string, number>>>({});
  const [leadRouteBreakdown, setLeadRouteBreakdown] = useState<Record<string, Record<string, number>>>({});
  const [contractRouteCounts, setContractRouteCounts] = useState<Record<string, number>>({});
  const [leadDateIssueRows, setLeadDateIssueRows] = useState<string[]>([]);
  const [leadCoverageComplete, setLeadCoverageComplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [localReload, setLocalReload] = useState(0);
  const [dailyTableSort, setDailyTableSort] = useState<TableSortState<GoogleAdsDailySortKey>>(null);
  const [campaignTableSort, setCampaignTableSort] = useState<TableSortState<GoogleAdsCampaignSortKey>>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const calendar = useMemo(() => getPersianMonthCalendar(calendarMonth), [calendarMonth]);

  // Close the report calendar when the manager clicks outside it or presses Escape.
  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) setCalendarOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setCalendarOpen(false); };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  // Load exact Google Ads metrics and independently count leads from every month in the selected range.
  useEffect(() => {
    const controller = new AbortController();
    const loadReport = async () => {
      setLoading(true);
      setError("");
      try {
        const from = persianToGregorian(startDate);
        const to = persianToGregorian(endDate);
        // Never treat a stale month registry as zero leads. Missing metadata falls back to the published tab label.
        const requestedMonths = resolveSheetMonthRequests(getRangeMonths(startDate, endDate), availableSheetMonths);
        const [adsResponse, sheetResponses, rateResponse, recordResponses, budgetResponse] = await Promise.all([
          fetchForBrand(`/api/google-ads/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&cachebust=${Date.now()}`, brandId, { cache: "no-store", signal: controller.signal }),
          Promise.all(requestedMonths.map(async month => {
            // Known tabs use their stable GID; newly published tabs remain readable by their Persian label.
            const selector = month.gid ? `gid=${encodeURIComponent(month.gid)}` : `sheet=${encodeURIComponent(month.sheetName || month.label)}`;
            const response = await fetchForBrand(`/api/sheet-data?${selector}&cachebust=${Date.now()}-${encodeURIComponent(month.value)}`, brandId, { cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error(`sheet_${month.value}_failed`);
            if (response.headers.get("x-dashboard-brand") !== brandId) throw new Error("brand_response_mismatch");
            return { month: month.value, label: month.label, rows: assignBlockDates(parseCsv(await response.text())) };
          })),
          fetchForBrand(`/api/exchange-rate?months=${encodeURIComponent(getRangeMonths(startDate, endDate).map(month => month.value).join(","))}`, brandId, { cache: "no-store", signal: controller.signal }),
          Promise.all(requestedMonths.map(async month => {
            const response = await fetchForBrand(`/api/expert-contract-records?month=${encodeURIComponent(month.value)}`, brandId, { cache: "no-store", signal: controller.signal });
            if (!response.ok) return [] as DetailedContractRecord[];
            const payload = await response.json() as { records?: DetailedContractRecord[] };
            return payload.records || [];
          })),
          fetchForBrand(`/api/budgets?from=${encodeURIComponent(startDate)}&to=${encodeURIComponent(endDate)}`, brandId, { cache: "no-store", signal: controller.signal }),
        ]);
        const adsPayload = await adsResponse.json() as GoogleAdsReport & { error?: string };
        const ratePayload = await rateResponse.json() as { rates?: MonthlyRate[] };
        const budgetPayload = await budgetResponse.json() as { monthlyCosts?: MonthlyChannelCost[] };
        if (!adsResponse.ok || !rateResponse.ok || !budgetResponse.ok || !adsPayload.totals || !Array.isArray(adsPayload.daily)) throw new Error(adsPayload.error || "ads_report_failed");
        const nextLeadCounts: Record<string, number> = {};
        const nextLeadBreakdown: Record<string, Record<string, number>> = {};
        const nextLeadRouteBreakdown: Record<string, Record<string, number>> = {};
        const nextLeadDateIssueRows: string[] = [];
        const attributableContracts = new Map<string, { date: string; channel: string; route: string }>();
        sheetResponses.forEach(({ month, label, rows }) => rows.forEach(row => {
          const effectiveDate = row.__effectiveDate || "";
          const source = row["منبع فایل"] || "";
          if (isGoogleAdsLeadSource(source) && !effectiveDate) nextLeadDateIssueRows.push(`${label} · ${row.__row}`);
          if (!effectiveDate || effectiveDate < startDate || effectiveDate > endDate) return;
          if (!isGoogleAdsLeadSource(source)) return;
          const channel = getChannelName(source);
          nextLeadCounts[effectiveDate] = (nextLeadCounts[effectiveDate] || 0) + 1;
          nextLeadBreakdown[effectiveDate] ||= {};
          nextLeadBreakdown[effectiveDate][channel] = (nextLeadBreakdown[effectiveDate][channel] || 0) + 1;
          const route = normalizeRoute(row["مسیر"] || "");
          nextLeadRouteBreakdown[effectiveDate] ||= {};
          nextLeadRouteBreakdown[effectiveDate][route] = (nextLeadRouteBreakdown[effectiveDate][route] || 0) + 1;
          if (isContractOutcome(getRowOutcome(row))) attributableContracts.set(`${month}:${row.__row}`, { date: effectiveDate, channel, route });
        }));
        recordResponses.flat().filter(record => record.firstContactDate >= startDate && record.firstContactDate <= endDate && isGoogleAdsLeadSource(record.sourceChannel))
          .forEach(record => attributableContracts.set(record.leadRef, { date: record.firstContactDate, channel: getChannelName(record.sourceChannel), route: normalizeRoute(record.route || "") }));
        const nextContractCounts: Record<string, number> = {};
        const nextContractRouteCounts: Record<string, number> = {};
        attributableContracts.forEach(contract => {
          nextContractCounts[contract.date] = (nextContractCounts[contract.date] || 0) + 1;
          nextContractRouteCounts[contract.route] = (nextContractRouteCounts[contract.route] || 0) + 1;
        });
        setReport(adsPayload);
        setLeadCounts(nextLeadCounts);
        setContractCounts(nextContractCounts);
        setMonthlyRates(Object.fromEntries((ratePayload.rates || []).map(rate => [rate.month, rate.tryToToman])));
        setGoogleAdsContractorFees(Object.fromEntries((budgetPayload.monthlyCosts || []).filter(item => item.channelId === "google_ads").map(item => [item.month, item.contractorToman])));
        setLeadBreakdown(nextLeadBreakdown);
        setLeadRouteBreakdown(nextLeadRouteBreakdown);
        setContractRouteCounts(nextContractRouteCounts);
        setLeadDateIssueRows(nextLeadDateIssueRows);
        setLeadCoverageComplete(true);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setLeadCoverageComplete(false);
        setError(requestError instanceof Error && requestError.message.startsWith("sheet_")
          ? "دادهٔ لیدِ یکی از ماه‌های بازه از Google Sheets دریافت نشد؛ برای جلوگیری از نمایش صفر اشتباه، گزارش ناقص نمایش داده نمی‌شود."
          : "دریافت گزارش Google Ads انجام نشد؛ اتصال و بازهٔ انتخابی را بررسی کنید.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void loadReport();
    const unregister = manualRefresh.register("گزارش گوگل ادز", loadReport);
    return () => { unregister(); controller.abort(); };
  }, [availableSheetMonths, brandId, currentMonth, endDate, localReload, reloadToken, startDate, today.sheetDate]);

  // Use the first click as the range start and the second click as the inclusive range end.
  const chooseDate = (day: number) => {
    const chosenDate = `${calendarMonth}/${String(day).padStart(2, "0")}`;
    if (!rangeAnchor) {
      setRangeAnchor(chosenDate);
      setStartDate(chosenDate);
      setEndDate(chosenDate);
      return;
    }
    setStartDate(rangeAnchor <= chosenDate ? rangeAnchor : chosenDate);
    setEndDate(rangeAnchor <= chosenDate ? chosenDate : rangeAnchor);
    setRangeAnchor(null);
    setCalendarOpen(false);
  };

  // Join daily Google Ads metrics with Persian-dated lead counts from the marketing Sheet.
  const currency = report?.account?.currencyCode || "TRY";
  const dailyRows = useMemo(() => (report?.daily || []).map(day => {
    const persianDate = gregorianToPersian(day.date);
    const leads = leadCounts[persianDate] || 0;
    return {
      ...day,
      persianDate,
      leads,
      leadRate: day.clicks > 0 ? leads / day.clicks * 100 : 0,
      cpc: day.clicks > 0 ? day.cost / day.clicks : 0,
      cpl: leads > 0 ? day.cost / leads : 0,
      contracts: contractCounts[persianDate] || 0,
      costToman: (() => {
        const month = persianDate.slice(0, 7);
        const rate = monthlyRates[month];
        const contractorFee = googleAdsContractorFees[month];
        if (contractorFee === undefined || contractorFee === null || (day.cost > 0 && rate === undefined)) return null;
        const workdayCount = getPersianMonthCalendar(month).days.filter(monthDay => getPersianWeekday(`${month}/${String(monthDay).padStart(2, "0")}`) !== "جمعه").length;
        const allocatedFee = getPersianWeekday(persianDate) === "جمعه" || !workdayCount ? 0 : contractorFee / workdayCount;
        return day.cost * (rate || 0) + allocatedFee;
      })(),
    };
  }), [contractCounts, googleAdsContractorFees, leadCounts, monthlyRates, report]);
  const totalLeads = dailyRows.reduce((sum, day) => sum + day.leads, 0);
  const leadSourceTotals = useMemo(() => googleAdsLeadChannels().map(channel => ({
    channel,
    value: Object.values(leadBreakdown).reduce((sum, daily) => sum + (daily[channel] || 0), 0),
  })), [leadBreakdown]);
  const leadAttributionHint = leadSourceTotals.map(item => `${item.channel}: ${item.value.toLocaleString("en-US")}`).join(" · ");
  const totalClicks = report?.totals.clicks || 0;
  const totalCost = report?.totals.cost || 0;
  const totalLeadRate = totalClicks > 0 ? totalLeads / totalClicks * 100 : 0;
  const totalCpc = totalClicks > 0 ? totalCost / totalClicks : 0;
  const totalCpl = totalLeads > 0 ? totalCost / totalLeads : 0;
  const totalContracts = dailyRows.reduce((sum, day) => sum + day.contracts, 0);
  const missingAdsRate = dailyRows.some(day => day.cost > 0 && monthlyRates[day.persianDate.slice(0, 7)] === undefined);
  const missingAdsContractorFee = getRangeMonths(startDate, endDate).some(month => googleAdsContractorFees[month.value] === undefined || googleAdsContractorFees[month.value] === null);
  const totalCostToman = missingAdsRate || missingAdsContractorFee ? null : dailyRows.reduce((sum, day) => sum + (day.costToman || 0), 0);
  const totalCplToman = totalCostToman !== null && totalLeads > 0 ? totalCostToman / totalLeads : null;
  const totalCacToman = totalCostToman !== null && totalContracts > 0 ? totalCostToman / totalContracts : null;
  // Preserve the table structure while prioritizing live campaigns and the most recently delivering paused campaigns.
  const sortedCampaigns = useMemo(() => sortGoogleAdsCampaigns(report?.campaigns || []), [report]);
  const routePerformance = useMemo(() => buildRoutePerformance(report?.campaigns || [], leadRouteBreakdown, ROUTE_MERGE_RULES), [leadRouteBreakdown, report]);
  const campaignRouteLeads = useMemo(() => attributeRouteMetricToCampaigns(
    routePerformance.routes,
    Object.fromEntries(routePerformance.routes.map(route => [route.route, route.leads])),
  ), [routePerformance]);
  const campaignRouteContracts = useMemo(() => attributeRouteMetricToCampaigns(routePerformance.routes, contractRouteCounts), [contractRouteCounts, routePerformance]);
  const campaignCostTomanById = useMemo(() => {
    const result: Record<string, number | null> = {};
    const campaigns = report?.campaigns || [];
    const dailyCampaignRows = report?.campaignDaily || [];
    if (dailyCampaignRows.length > 0) {
      const totals = new Map<string, number>();
      const incomplete = new Set<string>();
      dailyCampaignRows.forEach(day => {
        const rate = monthlyRates[gregorianToPersian(day.date).slice(0, 7)];
        if (rate === undefined && day.cost > 0) incomplete.add(day.campaignId);
        totals.set(day.campaignId, (totals.get(day.campaignId) || 0) + day.cost * (rate || 0));
      });
      campaigns.forEach(campaign => { result[campaign.campaignId] = incomplete.has(campaign.campaignId) ? null : (totals.get(campaign.campaignId) ?? 0); });
      return result;
    }
    const costByMonth: Record<string, number> = {};
    const tomanByMonth: Record<string, number> = {};
    dailyRows.forEach(day => {
      const month = day.persianDate.slice(0, 7);
      const rate = monthlyRates[month];
      if (rate !== undefined) { costByMonth[month] = (costByMonth[month] || 0) + day.cost; tomanByMonth[month] = (tomanByMonth[month] || 0) + day.cost * rate; }
    });
    const accountCost = Object.values(costByMonth).reduce((sum, cost) => sum + cost, 0);
    const weightedRate = accountCost > 0 ? Object.keys(costByMonth).reduce((sum, month) => sum + tomanByMonth[month], 0) / accountCost : null;
    campaigns.forEach(campaign => { result[campaign.campaignId] = weightedRate === null && campaign.cost > 0 ? null : campaign.cost * (weightedRate || 0); });
    return result;
  }, [dailyRows, monthlyRates, report]);
  const campaignTableData = useMemo(() => (report?.campaigns || []).map(campaign => ({
    ...campaign,
    leads: campaignRouteLeads[campaign.campaignId] ?? null,
    contracts: campaignRouteContracts[campaign.campaignId] ?? null,
    costToman: campaignCostTomanById[campaign.campaignId] ?? null,
  })), [campaignCostTomanById, campaignRouteContracts, campaignRouteLeads, report]);
  const campaignCostTomanTotal = useMemo(() => campaignTableData.some(campaign => campaign.costToman === null)
    ? null : campaignTableData.reduce((sum, campaign) => sum + (campaign.costToman || 0), 0), [campaignTableData]);
  const campaignAttributedContractTotal = useMemo(() => campaignTableData.reduce((sum, campaign) => sum + (campaign.contracts || 0), 0), [campaignTableData]);
  const sortedCampaignTableData = useMemo(() => {
    const order = new Map(sortedCampaigns.map((campaign, index) => [campaign.campaignId, index]));
    return [...campaignTableData].sort((left, right) => (order.get(left.campaignId) ?? 0) - (order.get(right.campaignId) ?? 0));
  }, [campaignTableData, sortedCampaigns]);
  const visibleRoutePerformance = routePerformance.routes.filter(route => route.leads > 0 || route.cost > 0);
  const mappedRouteLeads = visibleRoutePerformance.filter(route => route.campaignIds.length > 0).reduce((sum, route) => sum + route.leads, 0);
  const mappedRouteSpend = visibleRoutePerformance.reduce((sum, route) => sum + route.cost, 0);
  const unmatchedCampaignSpend = [...routePerformance.unmatchedCampaigns, ...routePerformance.ambiguousCampaigns.map(item => item.campaign)].reduce((sum, campaign) => sum + campaign.cost, 0);
  const maxRouteLeads = Math.max(1, ...visibleRoutePerformance.map(route => route.leads));
  const maxRouteSpend = Math.max(1, ...visibleRoutePerformance.map(route => route.cost));
  const maxDailyLeads = Math.max(1, ...dailyRows.map(day => day.leads));
  const maxDailyCost = Math.max(1, ...dailyRows.map(day => day.cost));
  const combinedTrendWidth = Math.max(640, dailyRows.length * 36 + 64);
  const combinedTrendStep = dailyRows.length > 1 ? (combinedTrendWidth - 84) / (dailyRows.length - 1) : 0;
  const combinedCostPoints = dailyRows.map((day, index) => `${42 + index * combinedTrendStep},${166 - day.cost / maxDailyCost * 112}`).join(" ");
  const combinedLeadPoints = dailyRows.map((day, index) => `${42 + index * combinedTrendStep},${166 - day.leads / maxDailyLeads * 112}`).join(" ");
  const campaignTotals = (report?.campaigns || []).reduce((sum, campaign) => ({
    cost: sum.cost + campaign.cost,
    impressions: sum.impressions + campaign.impressions,
    clicks: sum.clicks + campaign.clicks,
  }), { cost: 0, impressions: 0, clicks: 0 });
  const campaignIntegrity = !report || (
    Math.abs(campaignTotals.cost - report.totals.cost) < 0.000001 &&
    campaignTotals.impressions === report.totals.impressions &&
    campaignTotals.clicks === report.totals.clicks
  );
  const dailyTableRows = sortTableRows(dailyRows, dailyTableSort, (day, key) => {
    if (key === "channel") return "Google Ads";
    if (key === "cplToman") return day.costToman !== null && day.leads > 0 ? day.costToman / day.leads : null;
    if (key === "cacToman") return day.costToman !== null && day.contracts > 0 ? day.costToman / day.contracts : null;
    return day[key];
  });
  const campaignTableRows = sortTableRows(sortedCampaignTableData, campaignTableSort, (campaign, key) => {
    if (key === "ctr") return campaign.impressions > 0 ? campaign.clicks / campaign.impressions * 100 : 0;
    if (key === "cpc") return campaign.clicks > 0 ? campaign.cost / campaign.clicks : 0;
    return key === "name" ? campaign.name : key === "status" ? campaign.status : campaign[key];
  });
  const sortDailyTable = (column: string) => setDailyTableSort(current => nextTableSort(current, column as GoogleAdsDailySortKey));
  const sortCampaignTable = (column: string) => setCampaignTableSort(current => nextTableSort(current, column as GoogleAdsCampaignSortKey));
  const adsCoverageReasons = [
    report?.stale ? "گزارش زنده در دسترس نیست و آخرین گزارش سالم ذخیره‌شده نمایش داده می‌شود." : "",
    !leadCoverageComplete ? "پوشش لید Google Sheets برای بخشی از بازه کامل نیست." : "",
    missingAdsRate ? "نرخ ثابت TRY به تومان برای بخشی از بازه ثبت نشده است." : "",
    missingAdsContractorFee ? "دستمزد پیمانکار Google Ads برای بخشی از بازه ثبت نشده است؛ عدد 0 تأیید معتبر نبود پیمانکار است." : "",
    leadDateIssueRows.length > 0 ? `${leadDateIssueRows.length.toLocaleString("en-US")} لید تاریخ قابل‌انتساب ندارد.` : "",
    !campaignIntegrity ? "جمع کمپین‌ها با جمع کل حساب مغایرت دارد." : "",
  ];

  return <section className={`adsWorkspace glass ${calendarOpen ? "calendarOpen" : ""}`} aria-label="گزارش اختصاصی Google Ads">
    <div className="adsHeader">
      <div><span>گزارش عملکرد تبلیغات</span><h2>گزارش Google Ads</h2><p>هزینه، کلیک، ایمپرشن و لیدهای ثبت‌شده در Google Sheets برای بازهٔ شمسی انتخابی</p></div>
      <div className="adsHeaderActions">
        <div className="datePicker" ref={calendarRef}>
          <button className="datePickerButton active" type="button" onClick={() => { setCalendarMonth(endDate.slice(0, 7)); setRangeAnchor(null); setCalendarOpen(open => !open); }} aria-haspopup="dialog" aria-expanded={calendarOpen}>▦ {formatRecordedDate(startDate)} تا {formatRecordedDate(endDate)}</button>
          {calendarOpen && <div className="persianCalendar glass" role="dialog" aria-label="انتخاب بازه تاریخ شمسی گزارش Google Ads">
            <div className="calendarHeader"><button type="button" onClick={() => setCalendarMonth(month => shiftPersianMonth(month, -1))} aria-label="ماه قبل">‹</button><strong>{formatMonth(calendarMonth)}</strong><button type="button" onClick={() => setCalendarMonth(month => shiftPersianMonth(month, 1))} disabled={calendarMonth >= currentMonth} aria-label="ماه بعد">›</button></div>
            <div className="calendarWeekdays" aria-hidden="true">{["ش", "ی", "د", "س", "چ", "پ", "ج"].map(day => <span key={day}>{day}</span>)}</div>
            <div className="calendarDays">{Array.from({ length: calendar.firstWeekday }, (_, index) => <i key={`empty-${index}`}/>)}{calendar.days.map(day => {
              const dateKey = `${calendarMonth}/${String(day).padStart(2, "0")}`;
              const isFuture = dateKey > today.sheetDate;
              const isEdge = startDate === dateKey || endDate === dateKey;
              const isInRange = dateKey >= startDate && dateKey <= endDate;
              return <button type="button" key={day} disabled={isFuture} className={`${isEdge ? "selected" : ""} ${isInRange ? "inRange" : ""} ${today.sheetDate === dateKey ? "today" : ""}`} onClick={() => chooseDate(day)}>{day.toLocaleString("en-US", { useGrouping: false })}</button>;
            })}</div>
            <div className="calendarFooter"><button type="button" onClick={() => { chartRangeBeforeClickRef.current = null; setStartDate(`${currentMonth}/01`); setEndDate(today.sheetDate); setCalendarMonth(currentMonth); setRangeAnchor(null); setCalendarOpen(false); }}>از ابتدای ماه تا امروز</button><small>{rangeAnchor ? "روز پایان را انتخاب کنید" : "ابتدا شروع، سپس پایان"}</small></div>
          </div>}
        </div>
        <button className="adsRefresh" type="button" onClick={() => setLocalReload(value => value + 1)} disabled={loading}><span aria-hidden="true">↻</span>{loading ? "در حال دریافت…" : "بروزرسانی گزارش"}</button>
      </div>
    </div>

    {(Boolean(error) || report?.connected === false || Boolean(report?.stale)) && <div className="adsConnectionEntry"><strong>اتصال حساب Google Ads</strong><button type="button" className="secondarySetupAction" onClick={onSetup}>راهنمای مرحله‌به‌مرحله و تنظیم اتصال</button></div>}
    {loading && <div className="selectedDateEmpty loading"><i>↻</i><span>در حال دریافت داده‌های Google Ads و Google Sheets…</span></div>}
    {error && <div className="dataWarning" role="alert"><strong>⚠ دریافت گزارش ناموفق بود</strong><span>{error}</span></div>}
    {report && !loading && <>
      <GoogleAdsAlertCenter alerts={report.alerts || []} scan={report.alertScan} stale={report.stale}/>
      {report.stale && <div className="dataWarning" role="status"><strong>⚠ نمایش آخرین گزارش سالم</strong><span>اتصال لحظه‌ای در دسترس نیست و آخرین دادهٔ ذخیره‌شده نمایش داده می‌شود.</span></div>}
      {!leadCoverageComplete && <div className="dataWarning" role="alert"><strong>⚠ پوشش لید کامل نیست</strong><span>برای بخشی از بازهٔ انتخابی شیت ماهانه در داشبورد تعریف نشده است؛ معیارهای Google Ads کامل‌اند اما لید، نرخ تبدیل و CPL فقط از ماه‌های متصل محاسبه شده‌اند.</span></div>}
      {leadDateIssueRows.length > 0 && <div className="dataWarning" role="alert"><strong>⚠ تاریخ لید مشخص نیست</strong><span>ردیف‌های {leadDateIssueRows.join("، ")} منبع ورودی دارند اما پیش از اولین تاریخ معتبر بلوک قرار گرفته‌اند و به هیچ روزی نسبت داده نشده‌اند.</span></div>}
      {!campaignIntegrity && <div className="dataWarning" role="alert"><strong>⚠ مغایرت در گزارش Google Ads</strong><span>جمع کمپین‌ها با جمع کل حساب برابر نیست؛ دادهٔ گزارش باید دوباره دریافت و کنترل شود.</span></div>}
      {missingAdsRate && <div className="dataWarning" role="alert"><strong>⚠ نرخ ثابت ماهانه ثبت نشده</strong><span>برای بخشی از بازه نرخ TRY به تومان موجود نیست؛ مبلغ اصلی TRY معتبر است اما CPL و CAC تومانی نمایش داده نمی‌شوند.</span></div>}
      <div className="adsKpis">
        <article><span>تعداد کلیک</span><strong>{totalClicks.toLocaleString("en-US")}</strong><small>Clicks</small></article>
        <article title={`${leadAttributionHint} · تاریخ هر لید از اولین تاریخ ثبت‌شده در بلوک روز تعیین می‌شود.`}><span>تعداد لید</span><strong>{totalLeads.toLocaleString("en-US")}</strong><small>تجمیع گوگل ادز + واتساپ + فرم سایت</small></article>
        <article><span>هزینه کل</span><strong>{formatAdsMoney(totalCost, currency)}</strong><small>ارز اصلی حساب</small></article>
        <article><span>نرخ تبدیل کلیک به لید</span><strong>{formatDashboardNumber(totalLeadRate)}%</strong><small>Lead ÷ Click</small></article>
        <article><span>میانگین CPC</span><strong>{formatAdsMoney(totalCpc, currency)}</strong><small>Cost ÷ Click</small></article>
        <article><span>میانگین CPL</span><strong>{totalLeads > 0 ? formatAdsMoney(totalCpl, currency) : "—"}</strong><small>Cost ÷ Lead</small></article>
        <article><span>CPL تومانی</span><strong>{totalCplToman === null ? "ثبت نشده" : formatToman(totalCplToman)}</strong><small>هزینه تبدیل‌شده ÷ لید</small></article>
        <article><span>CAC قرارداد</span><strong>{totalCacToman === null ? "ثبت نشده" : formatToman(totalCacToman)}</strong><small>{totalContracts.toLocaleString("en-US")} قرارداد قابل انتساب</small></article>
      </div>
      <CoverageNotice title="وضعیت تکمیل هزینه و قرارداد Google Ads" reasons={adsCoverageReasons}/>

      <div className="adsCharts">
        <article className="adsCombinedTrend"><div className="adsSectionTitle"><strong>روند روزانه هزینه و لید</strong><small title={leadAttributionHint}>بازهٔ انتخابی مدیر · هزینه {currency}</small></div>
          <div className="adsCombinedViewport" tabIndex={0} aria-label="نمودار نقطه‌ای روند روزانه هزینه و لید">
            <svg viewBox={`0 0 ${combinedTrendWidth} 216`} style={{ width: `${combinedTrendWidth}px`, minWidth: "100%" }} role="img" aria-label="مقایسه روزانه هزینه Google Ads و تعداد لیدهای ثبت‌شده">
              {[0, 1, 2, 3].map(line => <line className="adsCombinedGrid" x1="32" x2={combinedTrendWidth - 30} y1={54 + line * 37} y2={54 + line * 37} key={line}/>)}
              <polyline className="adsCombinedLine cost" points={combinedCostPoints}/>
              <polyline className="adsCombinedLine lead" points={combinedLeadPoints}/>
              {dailyRows.map((day, index) => { const x = 42 + index * combinedTrendStep; const costY = 166 - day.cost / maxDailyCost * 112; const leadY = 166 - day.leads / maxDailyLeads * 112; return <g key={day.date}>
                <circle className="adsCombinedPoint cost" cx={x} cy={costY} r="4"><title>{formatRecordedDayMonth(day.persianDate)} · هزینه {formatAdsMoney(day.cost, currency)}</title></circle>
                <text className="adsCombinedValue cost" x={x} y={Math.max(14, costY - 9)}>{formatAdsNumber(day.cost)}</text>
                <circle className="adsCombinedPoint lead" cx={x} cy={leadY} r="4"><title>{formatRecordedDayMonth(day.persianDate)} · {day.leads.toLocaleString("en-US")} لید</title></circle>
                <text className="adsCombinedValue lead" x={x} y={Math.min(187, leadY + 14)}>{day.leads.toLocaleString("en-US")}</text>
                <text className="adsCombinedDay" x={x} y="207">{Number(day.persianDate.slice(-2)).toLocaleString("en-US")}</text>
              </g>; })}
            </svg>
          </div>
          <div className="adsCombinedLegend"><span className="cost">هزینه روزانه ({currency})</span><span className="lead">لید روزانه</span></div>
        </article>
      </div>

      <section className="routePerformanceSection" aria-label="تحلیل دقیق عملکرد مسیرهای Google Ads">
        <div className="routePerformanceHeader"><div><strong>عملکرد مسیرهای Google Ads</strong><small>هزینهٔ تمام کمپین‌های هم‌مسیر با لید همان مسیر در بازهٔ انتخابی تجمیع شده است.</small></div><span>بدون تقسیم یا تخمین لید بین کمپین‌ها</span></div>
        <div className="routePerformanceSummary">
          <article><span>مسیرهای قابل تحلیل</span><strong>{visibleRoutePerformance.filter(route => route.campaignIds.length > 0).length.toLocaleString("en-US")}</strong></article>
          <article><span>لید مسیرهای متصل</span><strong>{mappedRouteLeads.toLocaleString("en-US")}</strong></article>
          <article><span>هزینهٔ متصل به مسیر</span><strong>{formatAdsMoney(mappedRouteSpend, currency)}</strong></article>
          <article className={unmatchedCampaignSpend > 0 ? "warning" : ""}><span>هزینهٔ نیازمند نگاشت</span><strong>{formatAdsMoney(unmatchedCampaignSpend, currency)}</strong></article>
        </div>
        {visibleRoutePerformance.length ? <div className="routePerformanceGrid">{visibleRoutePerformance.map(route => <article className={route.campaignIds.length ? "mapped" : "unmapped"} key={route.route}>
          <header><strong>{route.route}</strong><span>{route.leads.toLocaleString("en-US")} لید</span></header>
          <div className="routePerformanceBars"><i className="lead" style={{ width: `${Math.max(route.leads > 0 ? 6 : 0, route.leads / maxRouteLeads * 100)}%` }}/><i className="cost" style={{ width: `${Math.max(route.cost > 0 ? 6 : 0, route.cost / maxRouteSpend * 100)}%` }}/></div>
          <dl><div><dt>هزینه</dt><dd>{route.campaignIds.length ? formatAdsMoney(route.cost, currency) : "کمپین پیدا نشد"}</dd></div><div><dt>CPL مسیر</dt><dd>{route.cpl === null ? "قابل محاسبه نیست" : formatAdsMoney(route.cpl, currency)}</dd></div></dl>
          <footer title={route.campaignNames.join(" · ")}>{route.campaignIds.length.toLocaleString("en-US")} کمپین{route.campaignNames.length ? ` · ${route.campaignNames.join("، ")}` : " · نیازمند تعریف نام معادل"}</footer>
        </article>)}</div> : <div className="routePerformanceEmpty">در بازهٔ انتخابی مسیر یا کمپین قابل تحلیل وجود ندارد.</div>}
        <div className="routePerformanceTableScroll"><table className="adsDataTable routePerformanceTable"><thead><tr><th>مسیر</th><th>کمپین‌های متصل</th><th>لید</th><th>Clicks</th><th>Cost ({currency})</th><th>CPL مسیر</th><th>نرخ لید به کلیک</th></tr></thead><tbody>{visibleRoutePerformance.map(route => <tr key={route.route}><td><b>{route.route}</b></td><td>{route.campaignNames.length ? route.campaignNames.join("، ") : "نیازمند نگاشت"}</td><td>{route.leads.toLocaleString("en-US")}</td><td>{route.clicks.toLocaleString("en-US")}</td><td>{route.campaignIds.length ? formatAdsNumber(route.cost) : "—"}</td><td>{route.cpl === null ? "—" : formatAdsNumber(route.cpl)}</td><td>{route.clicks > 0 ? `${formatDashboardNumber(route.leadRate)}%` : "—"}</td></tr>)}</tbody></table></div>
        {(routePerformance.unmatchedCampaigns.length > 0 || routePerformance.ambiguousCampaigns.length > 0 || routePerformance.unmatchedRoutes.length > 0 || routePerformance.missingRouteLeads > 0) && <div className="routeMappingNotice"><strong>موارد نیازمند تکمیل نگاشت</strong><div>
          {routePerformance.missingRouteLeads > 0 && <span><b>مسیر ثبت نشده</b>{routePerformance.missingRouteLeads.toLocaleString("en-US")} لید بدون مسیر قابل انتساب است</span>}
          {routePerformance.unmatchedCampaigns.map(campaign => <span key={campaign.campaignId}><b dir="ltr">{campaign.name}</b> نام مسیر معادل ندارد</span>)}
          {routePerformance.ambiguousCampaigns.map(item => <span key={item.campaign.campaignId}><b dir="ltr">{item.campaign.name}</b> هم‌زمان با {item.routes.join(" و ")} تطبیق دارد</span>)}
          {routePerformance.unmatchedRoutes.map(route => <span key={route.route}><b>{route.route}</b>{route.leads.toLocaleString("en-US")} لید دارد اما کمپین منطبق ندارد</span>)}
        </div><small>برای اصلاح، در تنظیمات ← ادغام مسیرها، نام انگلیسی کمپین را به نام‌های معادل همان مسیر اضافه کنید.</small></div>}
      </section>

      <div className="adsTableSection">
        <div className="adsSectionTitle"><strong>گزارش روزانه</strong><small>{dailyRows.length.toLocaleString("en-US")} روز در بازهٔ انتخابی</small></div>
        <div className="adsTableScroll"><table className="adsDataTable"><thead><tr>
          <SortableTableHeader label="تاریخ" column="date" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="کانال مارکتینگ" column="channel" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="تعداد کلیک" column="clicks" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="تعداد لید" column="leads" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="قرارداد قابل انتساب" column="contracts" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label={`هزینه (${currency})`} column="cost" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="نرخ تبدیل لید" column="leadRate" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label={`CPC (${currency})`} column="cpc" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label={`CPL (${currency})`} column="cpl" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="CPL تومان" column="cplToman" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
          <SortableTableHeader label="CAC تومان" column="cacToman" activeColumn={dailyTableSort?.key} direction={dailyTableSort?.direction} onSort={sortDailyTable}/>
        </tr></thead><tbody>{dailyTableRows.map(day => <tr key={day.date}><td><b>{formatRecordedDayMonth(day.persianDate)}</b><small>{getPersianWeekday(day.persianDate)}</small></td><td><span className="adsChannelPill">Google Ads</span></td><td>{day.clicks.toLocaleString("en-US")}</td><td>{day.leads.toLocaleString("en-US")}</td><td>{day.contracts.toLocaleString("en-US")}</td><td>{formatAdsNumber(day.cost)}</td><td>{formatDashboardNumber(day.leadRate)}%</td><td>{formatAdsNumber(day.cpc)}</td><td>{day.leads > 0 ? formatAdsNumber(day.cpl) : "—"}</td><td>{day.costToman !== null && day.leads > 0 ? formatAdsNumber(day.costToman / day.leads) : "—"}</td><td>{day.costToman !== null && day.contracts > 0 ? formatAdsNumber(day.costToman / day.contracts) : "—"}</td></tr>)}</tbody><tfoot><tr><td colSpan={2}>مجموع / میانگین</td><td>{totalClicks.toLocaleString("en-US")}</td><td>{totalLeads.toLocaleString("en-US")}</td><td>{totalContracts.toLocaleString("en-US")}</td><td>{formatAdsNumber(totalCost)}</td><td>{formatDashboardNumber(totalLeadRate)}%</td><td>{formatAdsNumber(totalCpc)}</td><td>{totalLeads > 0 ? formatAdsNumber(totalCpl) : "—"}</td><td>{totalCplToman === null ? "—" : formatAdsNumber(totalCplToman)}</td><td>{totalCacToman === null ? "—" : formatAdsNumber(totalCacToman)}</td></tr></tfoot></table></div>
      </div>

      <div className="adsTableSection">
        <div className="adsSectionTitle"><strong>عملکرد کمپین‌ها</strong><small>کمپین‌های فعال و متوقف‌شده؛ Removed نمایش داده نمی‌شود</small></div>
        <div className="adsTableScroll"><table className="adsDataTable campaignTable"><thead><tr>
          <SortableTableHeader label="نام Campaign" column="name" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="وضعیت" column="status" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="Impressions" column="impressions" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="Clicks" column="clicks" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label={`Cost (${currency})`} column="cost" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="تعداد لید" column="leads" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="قرارداد منتسب" column="contracts" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="هزینه (تومان)" column="costToman" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label="CTR" column="ctr" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
          <SortableTableHeader label={`CPC (${currency})`} column="cpc" activeColumn={campaignTableSort?.key} direction={campaignTableSort?.direction} onSort={sortCampaignTable}/>
        </tr></thead><tbody>{campaignTableRows.map(campaign => <tr key={campaign.campaignId}><td><b dir="ltr">{campaign.name}</b></td><td><span className={`campaignStatus ${campaign.status.toLowerCase()}`}>{campaign.status === "ENABLED" ? "فعال" : campaign.status === "PAUSED" ? "متوقف" : campaign.status}</span></td><td>{campaign.impressions.toLocaleString("en-US")}</td><td>{campaign.clicks.toLocaleString("en-US")}</td><td>{formatAdsNumber(campaign.cost)}</td><td title={campaign.leads === null ? "این کمپین با کمپین دیگری در یک مسیر مشترک است؛ انتساب قطعی لید نیازمند Campaign ID/UTM است." : undefined}>{campaign.leads === null ? "مشترک" : campaign.leads.toLocaleString("en-US")}</td><td title={campaign.contracts === null ? "قرارداد این مسیر بین چند کمپین مشترک است یا نگاشت قطعی ندارد؛ بدون Campaign ID/UTM بین کمپین‌ها تقسیم نمی‌شود." : undefined}>{campaign.contracts === null ? "مشترک" : campaign.contracts.toLocaleString("en-US")}</td><td>{campaign.costToman === null ? "ثبت نشده" : formatAdsNumber(campaign.costToman)}</td><td>{formatDashboardNumber(campaign.impressions > 0 ? campaign.clicks / campaign.impressions * 100 : 0)}%</td><td>{formatAdsNumber(campaign.clicks > 0 ? campaign.cost / campaign.clicks : 0)}</td></tr>)}</tbody><tfoot><tr><td colSpan={2}>مجموع / میانگین</td><td>{campaignTotals.impressions.toLocaleString("en-US")}</td><td>{campaignTotals.clicks.toLocaleString("en-US")}</td><td>{formatAdsNumber(campaignTotals.cost)}</td><td>{totalLeads.toLocaleString("en-US")}</td><td title="فقط قراردادهایی که بدون تقسیم یا تخمین به یک کمپین مشخص منتسب شده‌اند">{campaignAttributedContractTotal.toLocaleString("en-US")}</td><td>{campaignCostTomanTotal === null ? "ثبت نشده" : formatAdsNumber(campaignCostTomanTotal)}</td><td>{formatDashboardNumber(campaignTotals.impressions > 0 ? campaignTotals.clicks / campaignTotals.impressions * 100 : 0)}%</td><td>{formatAdsNumber(campaignTotals.clicks > 0 ? campaignTotals.cost / campaignTotals.clicks : 0)}</td></tr></tfoot></table></div>
      </div>
    </>}
  </section>;
}

type ConnectionStatusMenuProps = {
  telegramVisible: boolean;
  activeBrandId: string;
  sheetRows: number;
  hasUsableData: boolean;
  sheetBlockedMessage?: string;
  googleAdsStatusClass: string;
  googleAdsConnection: GoogleAdsConnection;
  googleAdsStatus: string;
  googleAdsCheckedAt: string;
  googleAdsFailureText: Record<string, string>;
  searchConsoleStatusClass: string;
  searchConsoleConnection: SearchConsoleConnection;
  searchConsoleCheckedAt: string;
  searchConsoleFailureText: Record<string, string>;
  isRefreshing: boolean;
};

/** A compact full-width status rail shared by every dashboard tab. */
function ConnectionStatusRail(props: ConnectionStatusMenuProps) {
  const sheetConnection = useSyncExternalStore(subscribeSheetConnection, () => sheetConnectionSnapshot, () => sheetConnectionSnapshot);
  const sheetSnapshotMatches = sheetConnection.brandId === props.activeBrandId;
  const sheetReady = !props.sheetBlockedMessage && sheetSnapshotMatches && sheetConnection.status === "connected";
  const sheetChecking = !props.sheetBlockedMessage && sheetSnapshotMatches && (sheetConnection.status === "checking" || sheetConnection.status === "unstable");
  const [telegramVisible, setTelegramVisible] = useState(props.telegramVisible);
  const [telegram, setTelegram] = useState<{ activationRequested: boolean; hasToken: boolean; chatId: string; enabled: boolean; lastReportStatus?: string; lastReportAt?: string; lastReportError?: string }>({ activationRequested: false, hasToken: false, chatId: "", enabled: false, lastReportStatus: "never" });
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/telegram-bot", { cache: "no-store", signal: controller.signal }).then(response => response.json()).then(payload => {
      if (!controller.signal.aborted && !payload.error) { setTelegram(payload); setTelegramVisible(Boolean(payload.enabled)); }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [props.isRefreshing]);
  const reportReady = telegram.enabled && Boolean(telegram.chatId) && telegram.lastReportStatus === "success";
  const reportFailed = telegram.lastReportStatus === "error";
  const telegramDetail = reportFailed ? `آخرین ارسال آمار ناموفق بود${telegram.lastReportError ? ` · ${telegram.lastReportError}` : ""}`
    : reportReady ? `آخرین ارسال آمار موفق · ${telegram.lastReportAt || "زمان نامشخص"}`
    : telegram.hasToken && telegram.chatId ? "اتصال آماده است؛ هنوز ارسال واقعی آمار ثبت نشده است"
    : telegram.hasToken ? "چت مقصد هنوز شناسایی نشده است" : "توکن و چت مقصد هنوز ثبت نشده‌اند";
  const items = [
    { key: "sheets", label: "وضعیت اتصال به Google Sheets", className: sheetReady ? "ok" : sheetChecking ? "checking" : "error", value: props.sheetBlockedMessage ? "منبع برند تأیید نشده" : sheetReady ? `اتصال برقرار است · ${props.sheetRows.toLocaleString("en-US")} رکورد` : sheetChecking ? (sheetConnection.status === "unstable" ? "اتصال ناپایدار · تلاش مجدد" : "در حال بررسی اتصال…") : "دریافت داده ناموفق است", detail: props.sheetBlockedMessage || (!sheetSnapshotMatches ? "وضعیت دفتر در حال همگام‌سازی است" : sheetReady ? `آخرین دریافت معتبر · ${sheetConnection.lastCheck}` : sheetConnection.status === "unstable" ? `آخرین داده معتبر حفظ شده · ${sheetConnection.lastCheck}` : "جزئیات خطا در پیام بروزرسانی نمایش داده می‌شود") },
    { key: "ads", label: "وضعیت اتصال به Google Ads", className: props.googleAdsStatusClass, value: props.googleAdsStatus === "connected" ? "متصل" : props.googleAdsStatus === "checking" ? "در حال بررسی اتصال…" : props.googleAdsStatus === "pending" ? "در انتظار راه‌اندازی" : "اتصال برقرار نیست", detail: props.googleAdsConnection.status === "connected" ? `آخرین بررسی ${props.googleAdsCheckedAt}` : props.googleAdsFailureText[props.googleAdsConnection.reason || ""] || "اطلاعات دسترسی هنوز ثبت نشده است" },
    { key: "search", label: "وضعیت اتصال به Search Console", className: props.searchConsoleStatusClass, value: props.searchConsoleConnection.status === "connected" ? "متصل" : props.searchConsoleConnection.status === "checking" ? "در حال بررسی اتصال…" : props.searchConsoleConnection.status === "pending" ? "اتصال اختیاری تنظیم نشده" : "اتصال برقرار نیست", detail: props.searchConsoleConnection.status === "connected" ? `دسترسی خواندنی تأیید شد · ${props.searchConsoleCheckedAt}` : props.searchConsoleFailureText[props.searchConsoleConnection.reason || ""] || "اتصال اختیاری تنظیم نشده" },
    ...(telegramVisible ? [{ key: "telegram", label: "وضعیت اتصال به Telegram", className: reportFailed ? "error" : reportReady ? "ok" : "pending", value: reportFailed ? "اتصال برقرار نیست" : reportReady ? "متصل" : telegram.enabled && telegram.chatId ? "اتصال آماده، گزارش در انتظار ارسال" : "اتصال تکمیل نشده", detail: telegramDetail }] : []),
  ];
  return <div className={`statusRail glass ${telegramVisible ? "withTelegram" : "withoutTelegram"}`} role="status" aria-live="polite" aria-busy={props.isRefreshing} aria-label="وضعیت اتصال سرویس‌ها">{items.map(item => <div className={`statusRailItem ${item.className}`} key={item.key}><i/><span><b>{item.label}</b><strong>{item.value}</strong><small>{item.detail}</small></span></div>)}</div>;
}

/** Isolates the one-second Tehran clock tick so the full analytics dashboard never rerenders every second. */
function TehranClock({ label }: { label: string }) {
  const [clock, setClock] = useState("00:00:00");
  useEffect(() => {
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const update = () => setClock(formatter.format(new Date()));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="dateTimeBox"><strong>{clock}</strong><span>{label}</span></div>;
}

type SheetTestStage = { key: string; label: string; status: "success" | "warning" | "error"; detail: string; solution?: string };
type SheetInspection = { headers: string[]; suggestions: DashboardRules["sheetColumns"]; sampleRows: Array<Record<string, string>>; tabLabel: string; monthCount: number; discoveredChannels: Array<{ name: string; count: number }> };
type GoogleAdsSecureSettings = { hasDeveloperToken: boolean; hasServiceAccount: boolean; serviceAccountEmail?: string; serviceAccountProjectId?: string };
type SearchConsoleSecureSettings = { propertyUrl: string; hasServiceAccount: boolean; serviceAccountEmail?: string; serviceAccountProjectId?: string };
type BackupPreview = { exportedAt: string; rulesVersion: number; budgets: number; contractorFees: number; rates: number; contracts: number; contractRecords: number };
const SHEET_COLUMN_LABELS: Record<keyof DashboardRules["sheetColumns"], string> = { date: "تاریخ", weekday: "روز هفته", source: "منبع فایل", route: "مسیر", expert: "کارشناس", outcome: "نتیجه", notes: "توضیحات" };
const HEALTH_STATUS_LABELS: Record<string, string> = { connected: "متصل", pending: "در انتظار", error: "خطا", active: "فعال", draft: "پیش‌نویس", disabled: "غیرفعال" };

/** Provides a persistent, status-driven setup wizard for every present and future dashboard brand. */
function BrandSettingsPage({ brands, activeBrandId, onReload, onSelect, onRulesPublished }: {
  brands: DashboardBrand[];
  activeBrandId: string;
  onReload: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onRulesPublished?: (rules: DashboardRules) => void;
}) {
  const active = brands.find(brand => brand.id === activeBrandId) || brands[0] || DEFAULT_BRAND;
  const [editing, setEditing] = useState<DashboardBrand>(active);
  const [isNew, setIsNew] = useState(false);
  const [sheetUrl, setSheetUrl] = useState(active.sheetIndexUrl || active.sheetCsvUrl);
  const [status, setStatus] = useState<"ready" | "saving" | "testing" | "uploading" | "error">("ready");
  const [message, setMessage] = useState("تنظیمات ذخیره‌شده آماده بررسی است.");
  const [sheetStages, setSheetStages] = useState<SheetTestStage[]>([]);
  const [sheetInspection, setSheetInspection] = useState<SheetInspection | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [adsSecureSettings, setAdsSecureSettings] = useState<GoogleAdsSecureSettings>({ hasDeveloperToken: false, hasServiceAccount: false });
  const [adsDeveloperToken, setAdsDeveloperToken] = useState("");
  const [adsServiceAccountJson, setAdsServiceAccountJson] = useState("");
  const [adsDiagnostic, setAdsDiagnostic] = useState<{ field?: string; detail?: string }>({});
  const [searchConsoleSettings, setSearchConsoleSettings] = useState<SearchConsoleSecureSettings>({ propertyUrl: "", hasServiceAccount: false });
  const [searchConsoleProperty, setSearchConsoleProperty] = useState("");
  const [searchConsoleServiceAccountJson, setSearchConsoleServiceAccountJson] = useState("");
  const [searchConsoleDiagnostic, setSearchConsoleDiagnostic] = useState<{ field?: string; detail?: string }>({});
  const [rules, setRules] = useState<DashboardRules>(DEFAULT_DASHBOARD_RULES);
  const savedRulesSignature = useRef("");
  const [ruleVersions, setRuleVersions] = useState<Array<{ version: number; action: string; createdAt: string }>>([]);
  const [systemEvents, setSystemEvents] = useState<Array<{ id: number; severity: string; component: string; eventCode: string; message: string; createdAt: string; solution?: string }>>([]);
  const [ruleHealth, setRuleHealth] = useState({ sheet: "pending", googleAds: "pending", brand: "draft", rulesValid: true, rulesVersion: 0, recentErrorCount: 0 });
  const [rulesStatus, setRulesStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [rulesMessage, setRulesMessage] = useState("در حال دریافت قواعد برند…");
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(null);
  const discoveredUnknownChannels = (sheetInspection?.discoveredChannels || []).filter(discovered => !rules.channels.some(channel => channel.aliases.some(alias => normalizeSource(alias) === normalizeSource(discovered.name))));

  const addDiscoveredChannel = (name: string) => {
    setRules(current => ({ ...current, channels: [...current.channels, { id: `channel-${Date.now()}`, name, aliases: [name], costMode: "daily_budget", contractorEnabled: true, color: "warning", icon: "•", enabled: true }] }));
    setRulesMessage(`کانال «${name}» به‌صورت هزینه‌دار با بودجه روزانه و دستمزد اختیاری اضافه شد؛ پیش از انتشار تنظیمات را بررسی کنید.`);
  };

  // Load only safe Google Ads metadata; saved secrets remain encrypted and are represented by status labels.
  useEffect(() => {
    if (!editing.id) return;
    const controller = new AbortController();
    void fetch(`/api/google-ads/settings?id=${encodeURIComponent(editing.id)}`, { cache: "no-store", signal: controller.signal })
      .then(response => response.json())
      .then(payload => { if (!controller.signal.aborted && !payload.error) setAdsSecureSettings(payload as GoogleAdsSecureSettings); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [editing.id]);

  // Search Console credentials and property selection are isolated from Google Ads and every other office.
  useEffect(() => {
    if (!editing.id) return;
    const controller = new AbortController();
    void fetch(`/api/search-console/settings?id=${encodeURIComponent(editing.id)}`, { cache: "no-store", signal: controller.signal })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted || payload.error) return;
        const settings = payload as SearchConsoleSecureSettings;
        setSearchConsoleSettings(settings);
        setSearchConsoleProperty(settings.propertyUrl || "");
      }).catch(() => undefined);
    return () => controller.abort();
  }, [editing.id]);

  const loadRules = useCallback(async (brandId: string, preserveDraft = false) => {
    if (!brandId) { setRules(DEFAULT_DASHBOARD_RULES); setRuleVersions([]); setSystemEvents([]); return; }
    setRulesStatus("loading");
    try {
      const response = await fetchForBrand(`/api/dashboard-rules?cachebust=${Date.now()}`, brandId, { cache: "no-store" });
      const payload = await response.json() as { rules?: DashboardRules; versions?: Array<{ version: number; action: string; createdAt: string }>; events?: Array<{ id: number; severity: string; component: string; eventCode: string; message: string; createdAt: string; solution?: string }>; health?: typeof ruleHealth; error?: string };
      if (!response.ok || !payload.rules) throw new Error(payload.error || "قواعد دریافت نشد.");
      const previousSignature = savedRulesSignature.current;
      setRules(current => !preserveDraft || JSON.stringify(current) === previousSignature ? payload.rules! : current);
      savedRulesSignature.current = JSON.stringify(payload.rules);
      setRuleVersions(payload.versions || []); setSystemEvents(payload.events || []); if (payload.health) setRuleHealth(payload.health);
      setRulesStatus("ready"); setRulesMessage("قواعد منتشرشده آماده ویرایش است.");
    } catch (error) { setRulesStatus("error"); setRulesMessage(error instanceof Error ? error.message : "قواعد دریافت نشد."); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRules(editing.id); }, 0);
    return () => window.clearTimeout(timer);
  }, [editing.id, loadRules]);

  const settingsRefreshGate = useRef(new RefreshGate());
  const refreshSettings = useCallback(() => settingsRefreshGate.current.run(async () => {
    const id = editing.id;
    if (!id) return;
    try {
      if (editing.configStatus === "active") {
        const response = await fetchForBrand("/api/sheet-months", id, { cache: "no-store", headers: { "x-dashboard-refresh": "1" } });
        const payload = await response.json() as { months?: SheetMonthDefinition[]; error?: string; stale?: boolean };
        if (!response.ok || !payload.months?.length) throw new Error(payload.error || "فهرست ماه‌ها دریافت نشد.");
        const month = payload.months.find(item => item.value === getPersianToday().sheetDate.slice(0, 7)) || payload.months[0];
        const csv = await fetchForBrand(`/api/sheet-data?gid=${encodeURIComponent(month.gid)}`, id, { cache: "no-store", headers: { "x-dashboard-refresh": "1" } });
        if (!csv.ok) throw new Error("دادهٔ گوگل‌شیت دریافت نشد؛ وضعیت ثبت‌شده را بررسی کنید.");
      }
    } finally {
      // Sync health only; never reset the manager's name, URL, secrets or rule drafts.
      const response = await fetchForBrand("/api/brands", id, { cache: "no-store" });
      const payload = await response.json() as { brands?: DashboardBrand[] };
      const latest = payload.brands?.find(brand => brand.id === id);
      if (latest) {
        setEditing(current => current.id !== id ? current : { ...current, sheetStatus: latest.sheetStatus, sheetMessage: latest.sheetMessage, googleAdsStatus: latest.googleAdsStatus, googleAdsMessage: latest.googleAdsMessage });
        setRuleHealth(current => ({ ...current, sheet: latest.sheetStatus, googleAds: latest.googleAdsStatus }));
      }
      const adsResponse = await fetchForBrand(`/api/google-ads/settings?id=${encodeURIComponent(id)}`, id, { cache: "no-store" });
      const adsSettings = await adsResponse.json() as GoogleAdsSecureSettings & { error?: string };
      if (adsResponse.ok && !adsSettings.error) setAdsSecureSettings(adsSettings);
      const searchConsoleResponse = await fetchForBrand(`/api/search-console/settings?id=${encodeURIComponent(id)}`, id, { cache: "no-store" });
      const searchConsolePayload = await searchConsoleResponse.json() as SearchConsoleSecureSettings & { error?: string };
      if (searchConsoleResponse.ok && !searchConsolePayload.error) {
        setSearchConsoleSettings(searchConsolePayload);
        setSearchConsoleProperty(searchConsolePayload.propertyUrl || "");
      }
      await loadRules(id, true);
      await onReload();
    }
  }, manualRefresh.active), [editing.id, editing.configStatus, loadRules, onReload]);
  useEffect(() => {
    void refreshSettings().catch(error => setMessage(error instanceof Error ? error.message : "بررسی اتصال کامل نشد."));
    return manualRefresh.register("تنظیمات و وضعیت اتصال", refreshSettings);
  }, [refreshSettings]);

  // Selecting a saved brand replaces the draft form without changing the dashboard's active data source.
  const chooseEditingBrand = (id: string) => {
    const brand = brands.find(item => item.id === id);
    if (!brand) return;
    setEditing(brand);
    setSheetUrl(brand.sheetIndexUrl || brand.sheetCsvUrl);
    setIsNew(false);
    setSheetStages([]);
    setSheetInspection(null);
    setDeleteOpen(false);
    setDeleteConfirmation("");
    setAdsDeveloperToken("");
    setSearchConsoleSettings({ propertyUrl: "", hasServiceAccount: false });
    setSearchConsoleProperty("");
    setSearchConsoleServiceAccountJson("");
    setSearchConsoleDiagnostic({});
    setBackupFile(null);
    setBackupPreview(null);
    setStatus("ready");
    setMessage("تنظیمات ذخیره‌شده آماده بررسی است.");
  };

  // A new brand starts as a draft and cannot affect live dashboard data before validation and activation.
  const beginNewBrand = () => {
    setEditing({ ...DEFAULT_BRAND, id: "", name: "", shortName: "", logoUrl: "", sheetCsvUrl: "", sheetIndexUrl: "", sheetStatus: "pending", sheetMessage: "اتصال آزمایش نشده است.", googleAdsCustomerId: "", googleAdsStatus: "pending", googleAdsMessage: "Service Account راه‌اندازی نشده است.", configStatus: "draft", isDefault: false });
    setSheetUrl("");
    setIsNew(true);
    setSheetStages([]);
    setSheetInspection(null);
    setDeleteOpen(false);
    setDeleteConfirmation("");
    setAdsSecureSettings({ hasDeveloperToken: false, hasServiceAccount: false });
    setAdsDeveloperToken("");
    setSearchConsoleSettings({ propertyUrl: "", hasServiceAccount: false });
    setSearchConsoleProperty("");
    setSearchConsoleServiceAccountJson("");
    setSearchConsoleDiagnostic({});
    setBackupFile(null);
    setBackupPreview(null);
    setStatus("ready");
    setMessage("اطلاعات پایه برند جدید را وارد کنید.");
  };

  // Reads real headers and sample rows before activation, then proposes a reversible mapping for this brand only.
  const inspectSheet = async () => {
    setStatus("testing");
    const startingMessage = "در حال ذخیره لینک، شناسایی ماه‌ها و خواندن نمونه ستون‌ها…";
    setMessage(startingMessage);
    setRulesMessage(startingMessage);
    setSheetStages([{ key: "starting", label: "شروع بررسی", status: "warning", detail: "درخواست شما ثبت شد؛ در حال ارتباط با Google Sheets هستیم." }]);
    try {
      const savedBrand = await persistBrandDraft();
      const response = await fetch("/api/brands/test-sheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: savedBrand.id, rules, mode: "inspect" }) });
      const payload = await response.json() as { inspection?: SheetInspection; stages?: SheetTestStage[]; error?: string; solution?: string };
      setSheetStages(payload.stages || []);
      if (!response.ok || !payload.inspection) throw new Error(payload.solution || payload.error || "ستون‌های شیت شناسایی نشد.");
      setSheetInspection(payload.inspection);
      setRules(current => ({ ...current, sheetColumns: payload.inspection!.suggestions }));
      setStatus("ready");
      const successMessage = `ستون‌های تب «${payload.inspection.tabLabel}» شناسایی شد؛ نگاشت پیشنهادی را بررسی و سپس همه ماه‌ها را آزمایش کنید.`;
      setMessage(successMessage);
      setRulesMessage(successMessage);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "شناسایی هوشمند ستون‌ها انجام نشد.";
      setSheetStages(current => current.some(stage => stage.status === "error") ? current : [...current, { key: "client-error", label: "شناسایی انجام نشد", status: "error", detail: failureMessage, solution: "نام و لینک برند را بررسی کنید و دوباره همین دکمه را بزنید." }]);
      setStatus("error");
      setMessage(failureMessage);
      setRulesMessage(failureMessage);
    }
  };

  // Persists exactly what is visible in the form so testing can never use an older Sheet URL.
  const persistBrandDraft = async () => {
    const response = await fetch("/api/brands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: editing.id || undefined, name: editing.name, shortName: editing.shortName, sheetUrl, googleAdsCustomerId: editing.googleAdsCustomerId, googleAdsLoginCustomerId: editing.googleAdsLoginCustomerId }) });
    const payload = await response.json() as { brand?: DashboardBrand; error?: string };
    if (!response.ok || !payload.brand) throw new Error(payload.error || "ذخیره انجام نشد.");
    setEditing(payload.brand);
    setSheetUrl(payload.brand.sheetIndexUrl || payload.brand.sheetCsvUrl);
    setIsNew(false);
    await onReload();
    return payload.brand;
  };

  // Saves only a draft; the live source changes exclusively through the explicit activation action.
  const saveBrand = async () => {
    setStatus("saving");
    setMessage("در حال ذخیره تنظیمات برند…");
    try {
      await persistBrandDraft();
      setStatus("ready");
      setMessage("پیش‌نویس با موفقیت ذخیره شد؛ برای کنترل منبع، «ذخیره و آزمایش اتصال» را بزنید.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "ذخیره تنظیمات انجام نشد.");
    }
  };

  // Runs every server-side Sheet validation stage and displays its exact success or repair action.
  const testSheet = async () => {
    if (!rules.sheetColumns.date || !rules.sheetColumns.source) {
      const detail = "برای آزمایش شیت باید ستون‌های «تاریخ» و «کانال ورودی» انتخاب شوند.";
      setSheetStages([{ key: "mapping-required", label: "نگاشت ناقص است", status: "error", detail, solution: "در مرحله ۲ این دو ستون الزامی را انتخاب کنید؛ سایر ستون‌ها اختیاری‌اند." }]);
      setStatus("error"); setMessage(detail); setRulesMessage(detail);
      return;
    }
    setStatus("testing");
    const startingMessage = "درخواست آزمایش ثبت شد؛ در حال ذخیره لینک و بررسی واقعی تمام ماه‌های Google Sheets…";
    setMessage(startingMessage);
    setRulesMessage(startingMessage);
    setSheetStages([{ key: "starting", label: "آزمایش در حال اجراست", status: "warning", detail: "لطفاً تا نمایش نتیجه نهایی این صفحه را نبندید." }]);
    try {
      const savedBrand = await persistBrandDraft();
      const response = await fetch("/api/brands/test-sheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: savedBrand.id, rules, mode: "test" }) });
      const payload = await response.json() as { connected?: boolean; stages?: SheetTestStage[]; warnings?: string[]; discoveredChannels?: SheetInspection["discoveredChannels"]; error?: string; solution?: string };
      setSheetStages(payload.stages || []);
      if (!response.ok || !payload.connected) {
        setEditing(current => ({ ...current, sheetStatus: "error", sheetMessage: payload.error || "آزمایش اتصال کامل نشد." }));
        throw new Error(payload.solution || payload.error || "اتصال کامل نشد.");
      }
      await onReload();
      if (payload.discoveredChannels) setSheetInspection(current => current ? { ...current, discoveredChannels: payload.discoveredChannels! } : current);
      setEditing(current => ({ ...current, sheetStatus: "connected", sheetMessage: payload.warnings?.length ? `اتصال موفق · ${payload.warnings.length.toLocaleString("en-US")} هشدار بازیابی‌شده` : "آزمایش اتصال موفق بود." }));
      setStatus("ready");
      const successMessage = payload.warnings?.length ? `Google Sheets متصل شد؛ ${payload.warnings.length.toLocaleString("en-US")} هشدار ساختاری بازیابی شده و در جزئیات نمایش داده می‌شود.` : "Google Sheets با موفقیت متصل شد و آماده فعال‌سازی است.";
      setMessage(successMessage);
      setRulesMessage(successMessage);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "آزمایش اتصال ناموفق بود.";
      setSheetStages(current => current.some(stage => stage.status === "error") ? current : [...current, { key: "client-error", label: "آزمایش انجام نشد", status: "error", detail: failureMessage, solution: "پیام خطا را بررسی کنید و پس از اصلاح، آزمایش را تکرار کنید." }]);
      setStatus("error");
      setMessage(failureMessage);
      setRulesMessage(failureMessage);
    }
  };

  // Stores the selected logo in durable object storage and immediately refreshes its preview.
  const uploadLogo = async (file: File | null) => {
    if (!file || !editing.id) { setStatus("error"); setMessage("ابتدا برند را ذخیره و سپس لوگو را انتخاب کنید."); return; }
    setStatus("uploading");
    setMessage("در حال ذخیره لوگو…");
    const form = new FormData();
    form.append("id", editing.id);
    form.append("logo", file);
    try {
      const response = await fetch("/api/brands/logo", { method: "POST", body: form });
      const payload = await response.json() as { logoUrl?: string; error?: string };
      if (!response.ok || !payload.logoUrl) throw new Error(payload.error || "ذخیره لوگو انجام نشد.");
      setEditing(current => ({ ...current, logoUrl: payload.logoUrl! }));
      await onReload();
      setStatus("ready");
      setMessage("لوگو با موفقیت ذخیره شد.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "ذخیره لوگو انجام نشد."); }
  };

  // Activation is atomic: a failed draft can never replace the currently healthy brand source.
  const activateBrand = async () => {
    setStatus("saving");
    setMessage("در حال فعال‌سازی برند…");
    try {
      const response = await fetch("/api/brands", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: editing.id }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "فعال‌سازی انجام نشد.");
      await onReload();
      setEditing(current => ({ ...current, configStatus: "active" }));
      setStatus("ready");
      setMessage("برند فعال شد و اکنون از انتخاب‌گر برند قابل استفاده است.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "فعال‌سازی انجام نشد."); }
  };

  // Save this office's IDs and encrypted Service Account, then verify the live Google Ads API path.
  const connectGoogleAds = async () => {
    if (!editing.id) return;
    const accountError = validateAdsAccountIds(editing.googleAdsCustomerId, editing.googleAdsLoginCustomerId);
    if (accountError) { setStatus("error"); setMessage(accountError); return; }
    setStatus("saving");
    setAdsDiagnostic({});
    setMessage("در حال ذخیره امن Service Account و آزمایش اتصال Google Ads…");
    try {
      const savedBrand = await persistBrandDraft();
      const settingsResponse = await fetch("/api/google-ads/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: savedBrand.id, developerToken: adsDeveloperToken, serviceAccountJson: adsServiceAccountJson }),
      });
      const settingsPayload = await settingsResponse.json() as { error?: string; settings?: GoogleAdsSecureSettings };
      if (!settingsResponse.ok) throw new Error(settingsPayload.error || "تنظیمات امن ذخیره نشد.");
      if (settingsPayload.settings) setAdsSecureSettings(settingsPayload.settings);
      const healthResponse = await fetchForBrand(`/api/google-ads/status?check=${Date.now()}`, savedBrand.id, { cache: "no-store" });
      const health = await healthResponse.json() as { status?: string; field?: string; detail?: string; reason?: string };
      if (health.status !== "connected") {
        setAdsDiagnostic({ field: health.field || "connection", detail: health.detail || "اتصال Google Ads تأیید نشد." });
        setStatus("error"); setMessage(health.detail || "اتصال Google Ads تأیید نشد.");
        await onReload();
        return;
      }
      await onReload();
      setEditing(current => ({ ...current, googleAdsStatus: "connected", googleAdsMessage: "اتصال Service Account موفق است." }));
      setStatus("ready"); setMessage("Service Account این دفتر با موفقیت تأیید شد و حساب Google Ads در دسترس است.");
      setAdsServiceAccountJson(""); setAdsDeveloperToken("");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "اتصال Google Ads انجام نشد.");
    }
  };

  // Save and verify the optional Search Console Service Account for this office only.
  const connectSearchConsole = async () => {
    if (!editing.id) return;
    setStatus("saving");
    setSearchConsoleDiagnostic({});
    setMessage("در حال ذخیره و آزمایش اتصال Search Console…");
    let failureField = "connection";
    try {
      const settingsResponse = await fetch("/api/search-console/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: editing.id, propertyUrl: searchConsoleProperty, serviceAccountJson: searchConsoleServiceAccountJson }),
      });
      const settingsPayload = await settingsResponse.json() as { error?: string; settings?: SearchConsoleSecureSettings };
      if (!settingsResponse.ok || !settingsPayload.settings) {
        const detail = settingsPayload.error || "تنظیمات Search Console ذخیره نشد.";
        const field = detail.includes("Property") ? "property" : detail.includes("JSON") || detail.includes("سرویس") ? "serviceAccount" : "connection";
        failureField = field;
        setSearchConsoleDiagnostic({ field, detail });
        throw new Error(detail);
      }
      setSearchConsoleSettings(settingsPayload.settings);
      setSearchConsoleProperty(settingsPayload.settings.propertyUrl || searchConsoleProperty);
      const healthResponse = await fetchForBrand(`/api/search-console/status?check=${Date.now()}`, editing.id, { cache: "no-store" });
      const health = await healthResponse.json() as SearchConsoleConnection;
      if (!healthResponse.ok || health.status !== "connected") {
        setSearchConsoleDiagnostic({ field: health.field || "connection", detail: health.detail || "اتصال Search Console تأیید نشد." });
        setStatus("error"); setMessage(`بخش Search Console خطا دارد: ${health.detail || "اتصال Search Console تأیید نشد."}`);
        return;
      }
      setSearchConsoleServiceAccountJson("");
      setStatus("ready");
      setMessage("Search Console همین دفتر با موفقیت متصل شد و تب گزارش آماده استفاده است.");
    } catch (error) {
      setStatus("error");
      const detail = error instanceof Error ? error.message : "اتصال Search Console انجام نشد.";
      setSearchConsoleDiagnostic(current => current.detail ? current : { field: failureField, detail });
      setMessage(`بخش Search Console خطا دارد: ${detail}`);
    }
  };

  // Deletes only after an exact typed-name confirmation, then reloads to purge every in-memory and browser-cached view.
  const deleteBrand = async () => {
    if (!editing.id || editing.isDefault) return;
    setStatus("saving");
    setMessage("در حال حذف کامل برند و داده‌های ذخیره‌شده آن…");
    try {
      const response = await fetch("/api/brands", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: editing.id, confirmation: deleteConfirmation }) });
      const payload = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !payload.deleted) throw new Error(payload.error || "حذف برند انجام نشد.");
      Object.keys(window.localStorage).filter(key => key.startsWith(`${DASHBOARD_CACHE_PREFIX}${editing.id}:`)).forEach(key => window.localStorage.removeItem(key));
      window.location.reload();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "حذف برند انجام نشد.");
    }
  };

  const saveRules = async () => {
    if (!editing.id) { setRulesStatus("error"); setRulesMessage("ابتدا برند را ذخیره کنید."); return; }
    setRulesStatus("saving"); setRulesMessage("در حال اعتبارسنجی و انتشار نسخه جدید قواعد…");
    try {
      const response = await fetchForBrand("/api/dashboard-rules", editing.id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules }) });
      const payload = await response.json() as { rules?: DashboardRules; version?: number; error?: string };
      if (!response.ok || !payload.rules) throw new Error(payload.error || "انتشار قواعد انجام نشد.");
      setRules(payload.rules); if (editing.id === activeBrandId) onRulesPublished?.(payload.rules); await loadRules(editing.id); setRulesStatus("ready");
      setRulesMessage(`نسخه ${payload.version} منتشر شد و همان لحظه در گزارش و تب بودجه اعمال شد.`);
    } catch (error) { setRulesStatus("error"); setRulesMessage(error instanceof Error ? error.message : "انتشار قواعد انجام نشد."); }
  };
  const downloadJson = async (action: "backup" | "diagnostics") => {
    if (!editing.id) { setRulesStatus("error"); setRulesMessage("ابتدا برند را ذخیره کنید."); return; }
    setRulesStatus("saving");
    setRulesMessage(action === "backup" ? "در حال تهیه نسخه پشتیبان…" : "در حال تهیه بسته عیب‌یابی…");
    try {
      const response = await fetchForBrand(`/api/dashboard-rules?action=${action}&cachebust=${Date.now()}`, editing.id, { cache: "no-store" });
      if (!response.ok) throw new Error("فایل آماده نشد.");
      const text = await response.text();
      const parsed = JSON.parse(text) as { format?: string };
      const expectedFormat = action === "backup" ? "marketing-dashboard-backup" : "marketing-dashboard-diagnostics";
      if (parsed.format !== expectedFormat) throw new Error("فایل تولیدشده معتبر نیست و دانلود متوقف شد.");
      const blob = new Blob([text], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${action === "backup" ? "dashboard-backup" : "dashboard-diagnostics"}-${editing.id}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setRulesStatus("ready");
      setRulesMessage(action === "backup" ? "نسخه پشتیبان دانلود شد." : "بسته عیب‌یابی دانلود شد؛ این فایل حاوی رمز یا اطلاعات مسافر نیست.");
      await loadRules(editing.id);
    } catch (error) { setRulesStatus("error"); setRulesMessage(error instanceof Error ? error.message : "فایل آماده نشد."); }
  };
  const inspectBackup = async (file: File | null) => {
    setBackupFile(null); setBackupPreview(null);
    if (!file || !editing.id) return;
    try {
      const backup = JSON.parse(await file.text()) as { format?: string; schemaVersion?: number; exportedAt?: string; brand?: { id?: string }; rules?: { version?: number }; summary?: Partial<BackupPreview>; data?: Record<string, unknown> };
      if (backup.format !== "marketing-dashboard-backup" || ![1, 2, 3].includes(Number(backup.schemaVersion))) throw new Error("فرمت یا نسخه فایل پشتیبان معتبر نیست.");
      if (backup.brand?.id !== editing.id) throw new Error("این فایل متعلق به برند انتخاب‌شده نیست.");
      const rows = (key: string) => Array.isArray(backup.data?.[key]) ? (backup.data?.[key] as unknown[]).length : 0;
      setBackupFile(file);
      setBackupPreview({ exportedAt: backup.exportedAt || "نامشخص", rulesVersion: Number(backup.rules?.version || 0), budgets: rows("budgets") + rows("channelDailyCosts"), contractorFees: rows("contractorFees") + rows("channelMonthlyCosts"), rates: rows("rates"), contracts: rows("contracts"), contractRecords: rows("contractRecords") });
      setRulesStatus("ready"); setRulesMessage("فایل پشتیبان معتبر است؛ خلاصه را بررسی و در صورت اطمینان بازیابی کنید.");
    } catch (error) { setRulesStatus("error"); setRulesMessage(error instanceof Error ? error.message : "فایل پشتیبان معتبر نیست."); }
  };
  const restoreBackup = async () => {
    if (!backupFile || !editing.id || !window.confirm("تمام داده‌های قابل‌بازیابی این برند با محتوای این فایل جایگزین شود؟ در صورت بروز خطا هیچ تغییری اعمال نخواهد شد.")) return;
    setRulesStatus("saving"); setRulesMessage("در حال بررسی و بازیابی نسخه پشتیبان…");
    try {
      const backup = JSON.parse(await backupFile.text());
      const response = await fetchForBrand("/api/dashboard-rules", editing.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "restore", backup }) });
      const payload = await response.json() as { restored?: boolean; error?: string };
      if (!response.ok || !payload.restored) throw new Error(payload.error || "بازیابی انجام نشد.");
      await loadRules(editing.id); setBackupFile(null); setBackupPreview(null); setRulesMessage("نسخه پشتیبان به‌طور کامل بازیابی شد؛ صفحه را بازخوانی کنید."); setRulesStatus("ready");
    } catch (error) { setRulesStatus("error"); setRulesMessage(error instanceof Error ? error.message : "فایل پشتیبان معتبر نیست."); }
  };
  const rollbackRules = async (version: number) => {
    if (!editing.id || !window.confirm(`قواعد به نسخه ${version} بازگردد؟ این عملیات یک نسخه جدید و قابل‌ردیابی می‌سازد.`)) return;
    setRulesStatus("saving"); setRulesMessage(`در حال بازگشت قواعد به محتوای نسخه ${version}…`);
    try {
      const response = await fetchForBrand("/api/dashboard-rules", editing.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rollback", version }) });
      const payload = await response.json() as { restored?: boolean; error?: string };
      if (!response.ok || !payload.restored) throw new Error(payload.error || "بازگشت انجام نشد.");
      await loadRules(editing.id); setRulesMessage(`محتوای نسخه ${version} در یک نسخه جدید بازیابی شد.`); setRulesStatus("ready");
    } catch (error) { setRulesStatus("error"); setRulesMessage(error instanceof Error ? error.message : "بازگشت انجام نشد."); }
  };

  const overallStatus = editing.sheetStatus === "connected" && editing.configStatus === "active" ? "success" : status === "error" || editing.sheetStatus === "error" ? "error" : "warning";
  return <section className="settingsWorkspace glass" aria-label="تنظیمات">
    <div className="settingsHeader"><div><span>مرکز راه‌اندازی منابع</span><h2>تنظیمات</h2><p>هر برند پیش از ورود به داشبورد ذخیره، آزمایش و سپس فعال می‌شود.</p></div><div className={`setupOverall ${overallStatus}`}><i/><span>{overallStatus === "success" ? "برند فعال و آماده استفاده" : overallStatus === "error" ? "نیازمند اصلاح" : "راه‌اندازی کامل نشده"}</span></div></div>
    <div className="settingsBrandBar"><label><span>برند در حال ویرایش</span><select value={isNew ? "__new" : editing.id} onChange={event => event.target.value === "__new" ? beginNewBrand() : chooseEditingBrand(event.target.value)}>{brands.map(brand => <option value={brand.id} key={brand.id}>{brand.name}{brand.configStatus === "draft" ? " · پیش‌نویس" : ""}</option>)}<option value="__new">+ افزودن برند جدید</option></select></label><div className="settingsBrandActions">{editing.configStatus === "active" && editing.id !== activeBrandId && <button type="button" onClick={() => void onSelect(editing.id)}>نمایش این برند در داشبورد</button>}{editing.id && !editing.isDefault && <button type="button" className="deleteBrandButton" onClick={() => { setDeleteOpen(true); setDeleteConfirmation(""); }}>حذف این برند از داشبورد</button>}</div></div>
    {deleteOpen && <div className="deleteBrandConfirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-brand-title"><div><strong id="delete-brand-title">حذف دائمی «{editing.name}»</strong><span>تمام تنظیمات، بودجه‌ها، نرخ ارز، قراردادها، کش گزارش Google Ads و لوگوی این برند از داشبورد پاک می‌شود. دادهٔ اصلی Google Sheets یا حساب Google Ads حذف نخواهد شد.</span></div><label><span>برای تأیید، نام برند را دقیق وارد کنید:</span><input value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} placeholder={editing.name}/></label><div><button type="button" onClick={() => { setDeleteOpen(false); setDeleteConfirmation(""); }}>انصراف</button><button type="button" className="confirmDelete" onClick={() => void deleteBrand()} disabled={status === "saving" || (deleteConfirmation.trim() !== editing.name && deleteConfirmation.trim() !== editing.shortName)}>{status === "saving" ? "در حال حذف…" : "حذف کامل و غیرقابل بازگشت"}</button></div></div>}
    <div className="setupStepper" aria-label="مراحل تنظیمات"><span className={editing.name && editing.shortName ? "success" : "warning"}><i>1</i>برند</span><span className={editing.sheetStatus}><i>2</i>Google Sheets</span><span className={editing.googleAdsStatus}><i>3</i>Google Ads · اختیاری</span><span className={editing.configStatus === "active" ? "success" : "warning"}><i>4</i>فعال‌سازی</span></div>
    <nav className="settingsQuickNav" aria-label="دسترسی سریع تنظیمات"><a href="#settings-foundation">اطلاعات و اتصال‌ها</a><a href="#telegram-bot-connection">اعلان Telegram</a><a href="#settings-rules">قواعد داده</a><a href="#settings-health">سلامت و پشتیبان</a></nav>
    <div className={`settingsMessage ${status}`}><i/><span>{message}</span></div>
    <div className="settingsGrid">
      <section id="settings-foundation" className="settingsGroup" aria-labelledby="settings-foundation-title"><header><div><span>بخش ۱</span><h3 id="settings-foundation-title">اطلاعات برند و اتصال منابع</h3><p>ابتدا هویت برند و سپس منابع دادهٔ همین دفتر را بررسی کنید.</p></div><em>۴ بخش</em></header><div className="settingsGroupGrid">
      <article className="settingsCard"><div className="settingsCardTitle"><i>1</i><div><strong>اطلاعات برند</strong><small>نام و هویت بصری</small></div></div><label><span>نام کامل برند</span><input value={editing.name} onChange={event => setEditing(current => ({ ...current, name: event.target.value }))} placeholder="مثلاً دفتر دنیاگردی"/></label><label><span>نام کوتاه</span><input value={editing.shortName} onChange={event => setEditing(current => ({ ...current, shortName: event.target.value }))} placeholder="مثلاً دنیاگردی"/></label><label className="logoUpload"><span>لوگو · PNG یا WebP شفاف، حداکثر 1.5MB</span><div>{editing.logoUrl ? <Image src={editing.logoUrl} alt={`لوگوی ${editing.name || "برند"}`} width={58} height={58} unoptimized/> : <i>Logo</i>}<input type="file" accept="image/png,image/webp,image/jpeg" onChange={event => void uploadLogo(event.target.files?.[0] || null)} disabled={!editing.id || status === "uploading"}/></div></label><button type="button" className="primarySetupAction" onClick={() => void saveBrand()} disabled={status === "saving"}>{status === "saving" ? "در حال ذخیره…" : "ذخیره پیش‌نویس"}</button></article>
      <article className={`settingsCard ${editing.sheetStatus}`}><div className="settingsCardTitle"><i>2</i><div><strong>اتصال Google Sheets</strong><small>{editing.sheetMessage}</small></div></div><label><span>لینک Publish to web</span><input dir="ltr" value={sheetUrl} onChange={event => setSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/e/.../pubhtml"/></label><div className="settingsHint"><b>راهنما</b><span>در Google Sheets از File ← Share ← Publish to web گزینه Entire document را منتشر کنید. سیستم هدرهای واقعی فایل را می‌خواند و در مرحله ۸ نگاشت پیشنهادی می‌سازد.</span></div>{sheetStages.length > 0 && <div className="testStages">{sheetStages.map(stage => <div className={stage.status} key={stage.key}><i/><span><b>{stage.label}</b><small>{stage.detail}</small>{stage.solution && <em>راه‌حل: {stage.solution}</em>}</span></div>)}</div>}<button type="button" className="secondarySetupAction" onClick={() => void inspectSheet()} disabled={status === "testing" || status === "saving"}>{status === "testing" ? "در حال شناسایی…" : "ذخیره لینک و شناسایی ستون‌ها"}</button></article>
      <GoogleAdsConnectionCard brand={editing} settings={adsSecureSettings} developerToken={adsDeveloperToken} serviceAccountJson={adsServiceAccountJson} busy={status === "saving"} errorField={adsDiagnostic.field} errorDetail={adsDiagnostic.detail} onBrandChange={patch => setEditing(current => ({ ...current, ...patch }))} onToken={setAdsDeveloperToken} onServiceAccountJson={setAdsServiceAccountJson} onConnect={() => void connectGoogleAds()}/>
      <SearchConsoleConnectionCard brandName={editing.name} settings={searchConsoleSettings} propertyUrl={searchConsoleProperty} serviceAccountJson={searchConsoleServiceAccountJson} busy={status === "saving"} errorField={searchConsoleDiagnostic.field} errorDetail={searchConsoleDiagnostic.detail} onPropertyUrl={setSearchConsoleProperty} onServiceAccountJson={setSearchConsoleServiceAccountJson} onConnect={() => void connectSearchConsole()}/>
      </div></section>
      <section className="settingsGroup settingsGroupOperations" aria-labelledby="settings-operations-title"><header><div><span>بخش ۲</span><h3 id="settings-operations-title">اعلان و فعال‌سازی</h3><p>اتصال Telegram و وضعیت فعال‌بودن برند را از این بخش مدیریت کنید.</p></div><em>۲ بخش</em></header><div className="settingsGroupGrid">
      <TelegramBotSettingsCard />
      <article className={`settingsCard activation ${editing.configStatus === "active" ? "connected" : "pending"}`}><div className="settingsCardTitle"><i>4</i><div><strong>بررسی و فعال‌سازی</strong><small>فقط اتصال موفق Google Sheets برای فعال‌سازی الزامی است</small></div></div><ul className="activationChecklist"><li className={editing.name && editing.shortName ? "done" : "todo"}>نام برند تکمیل شده</li><li className={editing.sheetStatus === "connected" ? "done" : "todo"}>Google Sheets آزمایش شده</li><li className={editing.googleAdsStatus === "connected" ? "done" : "optional"}>{editing.googleAdsStatus === "connected" ? "Service Account Google Ads متصل است" : "Google Ads اختیاری است و بعداً قابل اتصال خواهد بود"}</li><li className={searchConsoleSettings.hasServiceAccount && searchConsoleSettings.propertyUrl ? "done" : "optional"}>{searchConsoleSettings.hasServiceAccount && searchConsoleSettings.propertyUrl ? "تنظیمات Search Console برای این دفتر ثبت شده است" : "Search Console اختیاری است و بعداً قابل اتصال خواهد بود"}</li><li className={editing.logoUrl ? "done" : "optional"}>لوگو اختیاری است و هر زمان قابل تغییر است</li></ul><button type="button" className="primarySetupAction" onClick={() => void activateBrand()} disabled={!editing.id || editing.sheetStatus !== "connected" || editing.configStatus === "active"}>{editing.configStatus === "active" ? "برند فعال است" : "فعال‌سازی برند"}</button></article>
      </div></section>
    </div>
    <section id="settings-rules" className="noCodeRules" aria-label="قواعد بدون کدنویسی">
      <header><div><span>موتور تنظیمات بدون کدنویسی</span><h3>قواعد گزارش و کنترل داده</h3><p>هر انتشار نسخه‌دار است و فقط روی همین برند اثر می‌گذارد.</p></div><button type="button" className="primarySetupAction" onClick={() => void saveRules()} disabled={!editing.id || rulesStatus === "saving"}>{rulesStatus === "saving" ? "در حال انتشار…" : "انتشار قواعد"}</button></header>
      <div className={`settingsMessage ${rulesStatus === "error" ? "error" : rulesStatus === "saving" || rulesStatus === "loading" ? "testing" : "ready"}`}><i/><span>{rulesMessage}</span></div>
      <article className="rulesPanel wide"><div className="settingsCardTitle"><i>5</i><div><strong>کانال‌ها و نام‌های جایگزین</strong><small>نام نمایشی، ورودی‌های معادل و وضعیت هزینه</small></div></div>
        {sheetInspection && <div className={`discoveredChannelBox ${discoveredUnknownChannels.length ? "warning" : "complete"}`}><div><strong>کانال‌های خوانده‌شده از تمام ماه‌های Google Sheets</strong><small>{sheetInspection.discoveredChannels.length.toLocaleString("en-US")} نام پیدا شد · {discoveredUnknownChannels.length.toLocaleString("en-US")} مورد نیازمند تصمیم مدیر</small></div>{discoveredUnknownChannels.length ? <div className="discoveredChannelList">{discoveredUnknownChannels.map(channel => <button type="button" onClick={() => addDiscoveredChannel(channel.name)} key={channel.name}><span>{channel.name}</span><b>{channel.count.toLocaleString("en-US")} لید</b><em>افزودن هزینه‌دار</em></button>)}</div> : <p>تمام نام‌های موجود در شیت به یک کانال تأییدشده متصل‌اند.</p>}</div>}
        {!sheetInspection && <div className="settingsHint"><b>برای کشف خودکار کانال‌ها</b><span>ابتدا در مرحله ۸ «شروع شناسایی هوشمند» را اجرا کنید؛ نام کانال‌ها از همه ماه‌های قابل‌دسترسی خوانده می‌شود.</span></div>}
        <div className="ruleTable"><div className="ruleHead dynamic"><span>عنوان کانال</span><span>نام‌های جایگزین</span><span>روش هزینه</span><span>پیمانکار</span><span/></div>{rules.channels.map((channel, index) => <div className="ruleRow dynamic" key={channel.id}><input value={channel.name} onChange={event => setRules(current => ({ ...current, channels: current.channels.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))}/><AliasInput values={channel.aliases} onChange={aliases => setRules(current => ({ ...current, channels: current.channels.map((item, itemIndex) => itemIndex === index ? { ...item, aliases } : item) }))}/><select value={channel.costMode} onChange={event => { const costMode = event.target.value as "none" | "daily_budget" | "monthly_budget" | "google_ads"; setRules(current => ({ ...current, channels: current.channels.map((item, itemIndex) => itemIndex === index ? { ...item, costMode, contractorEnabled: costMode === "none" ? false : item.contractorEnabled } : item) })); }}><option value="none">بدون هزینه تبلیغاتی</option><option value="daily_budget">بودجه روزانه دستی</option><option value="monthly_budget">بودجه ماهانه دستی</option><option value="google_ads">هزینه API Google Ads این دفتر</option></select><label className="channelContractorToggle"><input type="checkbox" checked={channel.contractorEnabled} disabled={channel.costMode === "none" || (channel.costMode === "google_ads" && channel.id !== "google_ads")} onChange={event => setRules(current => ({ ...current, channels: current.channels.map((item, itemIndex) => itemIndex === index ? { ...item, contractorEnabled: event.target.checked } : item) }))}/><span>{channel.contractorEnabled ? "دارد" : "ندارد"}</span></label><button type="button" aria-label={`حذف ${channel.name}`} onClick={() => setRules(current => ({ ...current, channels: current.channels.filter((_, itemIndex) => itemIndex !== index) }))}>×</button></div>)}</div>
        <div className="costModeGuide"><span><b>بدون هزینه:</b> لید شمرده می‌شود اما وارد CPL و CAC نمی‌شود.</span><span><b>بودجه روزانه:</b> برای هر روز کاری و هر کانال در تب بودجه ثبت می‌شود.</span><span><b>بودجه ماهانه:</b> یک مبلغ ماهانه ثبت و در بازه‌های کوتاه‌تر سرشکن می‌شود.</span><span><b>Google Ads:</b> هزینه API متناسب با سهم لید کانال‌های متصل توزیع می‌شود.</span></div>
        <button type="button" className="addRuleButton" onClick={() => setRules(current => ({ ...current, channels: [...current.channels, { id: `channel-${Date.now()}`, name: "کانال جدید", aliases: ["کانال جدید"], costMode: "daily_budget", contractorEnabled: true, color: "warning", icon: "•", enabled: true }] }))}>+ افزودن دستی کانال</button>
      </article>
      <div className="rulesGrid">
        <article className="rulesPanel"><div className="settingsCardTitle"><i>6</i><div><strong>ادغام مسیرها و نام کمپین</strong><small>نام فارسی شیت و نام انگلیسی کمپین را زیر یک عنوان قرار دهید</small></div></div>{rules.routes.map((rule, index) => <div className="mergeRule" key={index}><input value={rule.target} placeholder="عنوان نهایی مسیر" onChange={event => setRules(current => ({ ...current, routes: current.routes.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item) }))}/><AliasInput values={rule.aliases} placeholder="املاها و نام‌های انگلیسی کمپین" onChange={aliases => setRules(current => ({ ...current, routes: current.routes.map((item, itemIndex) => itemIndex === index ? { ...item, aliases } : item) }))}/><button type="button" onClick={() => setRules(current => ({ ...current, routes: current.routes.filter((_, itemIndex) => itemIndex !== index) }))}>حذف</button></div>)}<button type="button" className="addRuleButton" onClick={() => setRules(current => ({ ...current, routes: [...current.routes, { target: "", aliases: [] }] }))}>+ افزودن مسیر و نام کمپین</button></article>
        <article className="rulesPanel"><div className="settingsCardTitle"><i>7</i><div><strong>املای نام کارشناسان</strong><small>فقط ادغام‌های تأییدشده</small></div></div>{rules.experts.map((rule, index) => <div className="mergeRule" key={index}><input value={rule.target} placeholder="نام نهایی کارشناس" onChange={event => setRules(current => ({ ...current, experts: current.experts.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item) }))}/><AliasInput values={rule.aliases} placeholder="املاهای معادل" onChange={aliases => setRules(current => ({ ...current, experts: current.experts.map((item, itemIndex) => itemIndex === index ? { ...item, aliases } : item) }))}/><button type="button" onClick={() => setRules(current => ({ ...current, experts: current.experts.filter((_, itemIndex) => itemIndex !== index) }))}>حذف</button></div>)}<button type="button" className="addRuleButton" onClick={() => setRules(current => ({ ...current, experts: [...current.experts, { target: "", aliases: [] }] }))}>+ افزودن کارشناس</button></article>
        <article className="rulesPanel wide sheetWizard"><div className="settingsCardTitle"><i>8</i><div><strong>راهنمای هوشمند اتصال Google Sheets</strong><small>تمام مراحل اتصال، نگاشت، پیش‌نمایش، آزمایش و انتشار در همین بخش</small></div></div>
          <div className="wizardSteps">
            <section className={sheetInspection ? "complete" : "current"}><header><i>1</i><div><b>ذخیره منبع و شناسایی ساختار</b><small>لینک Publish to web ذخیره می‌شود؛ تب‌های ماهانه و هدرهای واقعی فایل خوانده می‌شوند.</small></div></header><button type="button" className="secondarySetupAction" onClick={() => void inspectSheet()} disabled={status === "testing" || status === "saving"}>{status === "testing" ? "در حال شناسایی…" : sheetInspection ? "شناسایی مجدد ستون‌ها" : "شروع شناسایی هوشمند"}</button>{sheetInspection && <em>{sheetInspection.monthCount.toLocaleString("en-US")} ماه پیدا شد · نمونه از «{sheetInspection.tabLabel}»</em>}</section>
            <section className={sheetInspection ? "current" : "locked"}><header><i>2</i><div><b>تطبیق ستون‌های داشبورد</b><small>تاریخ و کانال ورودی الزامی‌اند؛ سایر ستون‌ها در صورت نبودن می‌توانند غیرفعال شوند.</small></div></header><div className="columnRules">{(Object.entries(rules.sheetColumns) as Array<[keyof DashboardRules["sheetColumns"], string]>).map(([key, value]) => { const required = key === "date" || key === "source"; const options = [...new Set([value, ...(sheetInspection?.headers || [])].filter(Boolean))]; return <label key={key}><span>{SHEET_COLUMN_LABELS[key]} {required ? <b>الزامی</b> : <em>اختیاری</em>}</span><select value={value} disabled={!sheetInspection} onChange={event => setRules(current => ({ ...current, sheetColumns: { ...current.sheetColumns, [key]: event.target.value } }))}>{!required && <option value="">این ستون در فایل وجود ندارد</option>}{required && !value && <option value="">یک ستون انتخاب کنید</option>}{options.map(header => <option value={header} key={header}>{header}</option>)}</select></label>; })}</div></section>
            <section className={sheetInspection?.sampleRows.length ? "complete" : "locked"}><header><i>3</i><div><b>پیش‌نمایش نگاشت</b><small>نمونه محدود بدون ذخیره اطلاعات مسافر نمایش داده می‌شود تا تطبیق ستون‌ها کنترل شود.</small></div></header>{sheetInspection?.sampleRows.length ? <div className="mappingPreview">{sheetInspection.sampleRows.map((row, index) => <div key={index}><b>ردیف نمونه {index + 1}</b><span>تاریخ: {rules.sheetColumns.date ? row[rules.sheetColumns.date] || "—" : "انتخاب نشده"}</span><span>کانال: {rules.sheetColumns.source ? row[rules.sheetColumns.source] || "—" : "انتخاب نشده"}</span><span>کارشناس: {rules.sheetColumns.expert ? row[rules.sheetColumns.expert] || "—" : "غیرفعال"}</span><span>نتیجه: {rules.sheetColumns.outcome ? row[rules.sheetColumns.outcome] || "—" : "غیرفعال"}</span></div>)}</div> : <p>پس از مرحله اول، نمونه نگاشت اینجا نمایش داده می‌شود.</p>}</section>
            <section className={editing.sheetStatus === "connected" ? "complete" : sheetInspection ? "current" : "locked"}><header><i>4</i><div><b>آزمایش کامل همه ماه‌ها</b><small>وجود ستون‌های الزامی و قابل‌دریافت بودن CSV در تمام تب‌های ماهانه بررسی می‌شود.</small></div></header><button type="button" className="secondarySetupAction" onClick={() => void testSheet()} disabled={status === "testing" || status === "saving"}>{status === "testing" ? "در حال آزمایش…" : "آزمایش کامل همه ماه‌ها"}</button><div className={`sheetInlineFeedback ${status === "error" ? "error" : editing.sheetStatus === "connected" ? "success" : status === "testing" ? "testing" : "idle"}`} role="status" aria-live="polite"><i/><span>{sheetStages.length ? message : "هنوز آزمایشی اجرا نشده است؛ پس از کلیک، شروع عملیات فوراً همین‌جا اعلام می‌شود."}</span></div>{sheetStages.length > 0 && <div className="testStages">{sheetStages.map(stage => <div className={stage.status} key={`${stage.key}-${stage.label}`}><i/><span><b>{stage.label}</b><small>{stage.detail}</small>{stage.solution && <em>راه‌حل: {stage.solution}</em>}</span></div>)}</div>}</section>
            <section className={editing.sheetStatus === "connected" ? "current" : "locked"}><header><i>5</i><div><b>انتشار قواعد و فعال‌سازی</b><small>نگاشت ستون‌ها نسخه‌دار منتشر می‌شود؛ سپس برند آماده استفاده در داشبورد است.</small></div></header><div className="wizardActions"><button type="button" className="secondarySetupAction" onClick={() => void saveRules()} disabled={editing.sheetStatus !== "connected" || rulesStatus === "saving"}>انتشار نگاشت و قواعد</button><button type="button" className="primarySetupAction" onClick={() => void activateBrand()} disabled={rulesStatus === "saving" || editing.configStatus === "active"}>{editing.configStatus === "active" ? "برند فعال است" : "فعال‌سازی برند"}</button></div></section>
          </div>
        </article>
        <article className="rulesPanel formulaPanel"><div className="settingsCardTitle"><i>9</i><div><strong>قرارداد و قواعد پایه مالی</strong><small>فرمول‌های فعلی ثابت‌اند؛ فقط کنترل‌های واقعاً عملیاتی قابل تغییرند</small></div></div><label><span>نتایجی که قرارداد محسوب می‌شوند</span><AliasInput values={rules.contractOutcomes} onChange={contractOutcomes => setRules(current => ({ ...current, contractOutcomes }))}/></label><label><span>نسخه قوانین</span><input dir="ltr" value={rules.rulesVersion} onChange={event => setRules(current => ({ ...current, rulesVersion: event.target.value }))}/></label><div className="fixedFormulaGrid"><article><span>CPL</span><strong>هزینه همان کانال ÷ لیدهای همان کانال</strong><small>فقط کانال‌های دارای منبع هزینه محاسبه می‌شوند.</small></article><article><span>CAC</span><strong>هزینه همان کانال ÷ قراردادهای قابل‌انتساب همان کانال</strong><small>قرارداد باید از نتیجه تعیین‌شده و کانال همان لید تشخیص داده شود.</small></article><article><span>سهم هر کارشناس</span><strong>هزینه کانال × سهم لید پاسخ‌داده‌شده کارشناس</strong><small>کنترل تطبیق، جمع سهم کارشناسان را با هزینه کانال مقایسه می‌کند.</small></article></div><label className="ruleCheckbox"><input type="checkbox" checked readOnly/><span>هزینه تبلیغات و دستمزد پیمانکار همیشه در CPL و CAC محاسبه می‌شود</span></label></article>
      </div>
      <div id="settings-health" className="rulesGrid operations">
        <article className="rulesPanel healthCenter"><div className="settingsCardTitle"><i>10</i><div><strong>مرکز سلامت و عیب‌یابی</strong><small>وضعیت اتصال‌ها و سابقه خطاهای همین برند</small></div></div><div className="operationsGuide"><strong>چه زمانی استفاده کنید؟</strong><p>وقتی داده نمایش داده نمی‌شود، اتصال شیت یا Google Ads خطا دارد، یا نتیجه یک عملیات مشخص نیست، ابتدا وضعیت‌ها و آخرین رویدادها را بررسی کنید.</p><strong>بسته عیب‌یابی چه دارد؟</strong><p>وضعیت برند، نسخه قواعد، کد خطاها و زمان رویدادها؛ بدون رمز، توکن، اطلاعات مسافر یا ردیف‌های Google Sheets.</p></div><div className="healthStatusGrid"><span className={ruleHealth.sheet}>{`Google Sheets: ${HEALTH_STATUS_LABELS[ruleHealth.sheet] || ruleHealth.sheet}`}</span><span className={ruleHealth.googleAds}>{`Google Ads: ${HEALTH_STATUS_LABELS[ruleHealth.googleAds] || ruleHealth.googleAds}`}</span><span className={ruleHealth.brand}>{`برند: ${HEALTH_STATUS_LABELS[ruleHealth.brand] || ruleHealth.brand}`}</span><span className={ruleHealth.recentErrorCount ? "error" : "connected"}>{`${ruleHealth.recentErrorCount.toLocaleString("en-US")} خطای اخیر`}</span></div>{systemEvents.length ? <div className="eventList">{systemEvents.slice(0, 12).map(item => <div className={item.severity} key={item.id}><b>{item.eventCode}</b><span>{item.message}</span><small>{item.component} · {item.createdAt}</small><em>{item.solution ? `راه‌حل: ${item.solution}` : item.severity === "error" ? "راه‌حل: بسته عیب‌یابی را دانلود و برای بررسی ارسال کنید." : "وضعیت ثبت و قابل پیگیری است."}</em></div>)}</div> : <div className="settingsHint success"><b>خطای ثبت‌شده‌ای وجود ندارد</b><span>پس از انتشار قواعد، آزمایش اتصال یا بازیابی، رویدادها اینجا نمایش داده می‌شوند.</span></div>}<button type="button" className="secondarySetupAction" onClick={() => void downloadJson("diagnostics")} disabled={!editing.id || rulesStatus === "saving"}>{rulesStatus === "saving" ? "در حال آماده‌سازی…" : "دانلود بسته عیب‌یابی امن"}</button></article>
        <article className="rulesPanel"><div className="settingsCardTitle"><i>11</i><div><strong>پشتیبان‌گیری، بازیابی و بازگشت نسخه</strong><small>حفاظت از تنظیمات و داده‌های ثبت‌شده همین برند</small></div></div><div className="operationsGuide"><strong>نسخه پشتیبان</strong><p>قواعد، بودجه، دستمزد پیمانکار، نرخ ارز و قراردادهای ثبت‌شده داشبورد را ذخیره می‌کند. فایل Google Sheets و حساب Google Ads داخل آن نیست.</p><strong>بازیابی کامل</strong><p>فقط فایل همین برند پذیرفته می‌شود. ابتدا فایل کنترل و خلاصه آن نمایش داده می‌شود؛ سپس با تأیید شما همه بخش‌ها یکجا بازیابی می‌شوند و در صورت هر خطا هیچ داده‌ای تغییر نمی‌کند.</p><strong>بازگشت نسخه قواعد</strong><p>فقط تنظیمات و قواعد را به نسخه قبلی برمی‌گرداند و بودجه یا قراردادها را تغییر نمی‌دهد. بازگشت نیز به‌عنوان نسخه جدید ثبت می‌شود.</p></div><button type="button" className="secondarySetupAction" onClick={() => void downloadJson("backup")} disabled={!editing.id || rulesStatus === "saving"}>{rulesStatus === "saving" ? "در حال آماده‌سازی…" : "دانلود نسخه پشتیبان کامل برند"}</button><label className="restoreButton"><span>۱. انتخاب و بررسی فایل پشتیبان</span><input type="file" accept="application/json" onChange={event => void inspectBackup(event.target.files?.[0] || null)}/></label>{backupPreview && <div className="backupPreview" role="status"><strong>فایل معتبر و آماده بازیابی است</strong><span>تاریخ تهیه: <b dir="ltr">{backupPreview.exportedAt}</b></span><span>نسخه قواعد: <b>{backupPreview.rulesVersion.toLocaleString("en-US")}</b></span><span>بودجه: <b>{backupPreview.budgets.toLocaleString("en-US")}</b> ردیف</span><span>دستمزد و نرخ ارز: <b>{(backupPreview.contractorFees + backupPreview.rates).toLocaleString("en-US")}</b> ردیف</span><span>قراردادها: <b>{(backupPreview.contracts + backupPreview.contractRecords).toLocaleString("en-US")}</b> ردیف</span><button type="button" className="primarySetupAction" onClick={() => void restoreBackup()} disabled={rulesStatus === "saving"}>۲. تأیید و بازیابی کامل</button></div>}<div className="versionList"><strong>تاریخچه نسخه قواعد</strong>{ruleVersions.length ? ruleVersions.map(item => <div key={item.version}><span>نسخه {item.version} · {item.action === "publish" ? "انتشار" : item.action === "restore" ? "بازیابی بکاپ" : item.action === "rollback" ? "بازگشت نسخه" : item.action}</span><small>{item.createdAt}</small><button type="button" onClick={() => void rollbackRules(item.version)} disabled={rulesStatus === "saving"}>بازگشت قواعد</button></div>) : <small>هنوز نسخه‌ای منتشر نشده است.</small>}</div></article>
      </div>
    </section>
  </section>;
}

type PhoneExtractionRecord = {
  id: string;
  normalizedPhone: string;
  phoneKind: NormalizedPhone["kind"];
  rawPhone: string;
  date: string;
  passenger: string;
  gender: string;
  rawSource: string;
  channel: string;
  route: string;
  expert: string;
  outcome: string;
  contractStatus: "قرارداد شده" | "قرارداد نشده";
  job: string;
  notes: string;
  sheetRow: string;
};

const PHONE_CSV_HEADERS = ["شماره استاندارد", "شماره ثبت‌شده", "تاریخ", "نام مسافر", "جنسیت", "منبع فایل", "کانال", "مسیر", "کارشناس", "نتیجه", "وضعیت قرارداد", "شغل مسافر", "توضیحات", "ردیف شیت"];
const PHONE_TABLE_HEADERS = PHONE_CSV_HEADERS.filter(header => header !== "شغل مسافر");

/** Reads the first populated spelling of one logical Sheet field. */
function firstSheetValue(row: SheetRow, headers: string[]) {
  const normalizeHeader = (value: string) => value.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\s‌_-]+/g, "").trim();
  const normalizedEntries = Object.entries(row).map(([header, value]) => [normalizeHeader(header), value?.trim() || ""] as const);
  return headers.filter(Boolean).map(header => row[header]?.trim() || normalizedEntries.find(([candidate]) => candidate === normalizeHeader(header))?.[1] || "").find(Boolean) || "";
}

function PhoneMultiSelect({ label, allLabel, options, selected, onChange }: {
  label: string;
  allLabel: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
  return <details className="phoneMultiSelect">
    <summary><span>{label}</span><b>{selected.length ? `${selected.length.toLocaleString("en-US")} مورد` : allLabel}</b><i aria-hidden="true">⌄</i></summary>
    <div className="phoneMultiMenu">
      <div className="phoneMultiActions"><button type="button" onClick={() => onChange(options)}>انتخاب همه</button><button type="button" onClick={() => onChange([])}>پاک‌کردن</button></div>
      <div className="phoneMultiOptions">{options.length ? options.map(option => <label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={() => toggle(option)}/><span>{option}</span></label>) : <p>بعد از استخراج، گزینه‌ها نمایش داده می‌شوند.</p>}</div>
    </div>
  </details>;
}

/** Builds the owner-only, non-persistent phone extraction workspace from the selected brand's Sheet. */
function PhoneExtractionPage({ brandId, defaultStartDate, defaultEndDate, todayDate, availableSheetMonths }: {
  brandId: string;
  defaultStartDate: string;
  defaultEndDate: string;
  todayDate: string;
  availableSheetMonths: SheetMonthDefinition[];
}) {
  const initialRange = resolveExtractionDateRange(defaultStartDate, defaultEndDate, todayDate, availableSheetMonths.map(month => month.value));
  const [startDate, setStartDate] = useState(initialRange.startDate);
  const [endDate, setEndDate] = useState(initialRange.endDate);
  const [sourceRows, setSourceRows] = useState<Array<SheetRow & { __effectiveDate: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [channelFilter, setChannelFilter] = useState<string[]>([]);
  const [routeFilter, setRouteFilter] = useState<string[]>([]);
  const [expertFilter, setExpertFilter] = useState<string[]>([]);
  const [outcomeFilter, setOutcomeFilter] = useState<string[]>([]);
  const [contractFilter, setContractFilter] = useState<"all" | "contracted" | "not-contracted">("all");
  const [phoneKindFilter, setPhoneKindFilter] = useState<"all" | "iran" | "international">("all");
  const [rowMode, setRowMode] = useState<"all" | "unique">("all");
  const [exportHeaders, setExportHeaders] = useState(() => PHONE_CSV_HEADERS.filter(header => header !== "شغل مسافر"));

  const dateIsValid = (value: string) => /^1\d{3}\/\d{2}\/\d{2}$/.test(value);
  const readPhone = (row: SheetRow) => findPhoneCellValue(row);

  const extractionData = useMemo(() => {
    const inRange = sourceRows.filter(row => row.__effectiveDate >= startDate && row.__effectiveDate <= endDate);
    const valid: PhoneExtractionRecord[] = [];
    let missing = 0;
    let invalid = 0;
    inRange.forEach(row => {
      const rawPhone = readPhone(row);
      if (!rawPhone) { missing++; return; }
      const phones = extractPhoneNumbers(rawPhone);
      if (!phones.length) { invalid++; return; }
      const rawSource = firstSheetValue(row, ["منبع فایل", runtimeRules.sheetColumns.source]);
      const rawRoute = firstSheetValue(row, ["مسیر", runtimeRules.sheetColumns.route]);
      const rawExpert = firstSheetValue(row, ["کارشناس", runtimeRules.sheetColumns.expert]);
      const outcome = firstSheetValue(row, ["نتیجه", "نتیجه تماس", "نتیجه تماس آخر", runtimeRules.sheetColumns.outcome]);
      phones.forEach((phone, phoneIndex) => valid.push({
        id: `${row.__effectiveDate}-${row.__row}-${phone.normalized}-${phoneIndex}`,
        normalizedPhone: phone.normalized,
        phoneKind: phone.kind,
        rawPhone: phone.raw,
        date: row.__effectiveDate,
        passenger: firstSheetValue(row, ["نام مسافر", "نام و نام خانوادگی", "نام"]),
        gender: firstSheetValue(row, ["جنسیت"]),
        rawSource,
        channel: rawSource ? getChannelName(rawSource) : "ثبت نشده",
        route: rawRoute ? normalizeRoute(rawRoute) : "ثبت نشده",
        expert: rawExpert ? canonicalExpertName(rawExpert) : "ثبت نشده",
        outcome: outcome || "ثبت نشده",
        contractStatus: isContractOutcome(outcome) ? "قرارداد شده" : "قرارداد نشده",
        job: firstSheetValue(row, ["شغل مسافر", "شغل"]),
        notes: firstSheetValue(row, ["توضیحات", runtimeRules.sheetColumns.notes]),
        sheetRow: row.__row || "",
      }));
    });
    return { inRangeCount: inRange.length, valid, missing, invalid };
  }, [endDate, sourceRows, startDate]);

  const options = useMemo(() => {
    const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "fa"));
    return {
      channels: unique(extractionData.valid.map(row => row.channel)),
      routes: unique(extractionData.valid.map(row => row.route)),
      experts: unique(extractionData.valid.map(row => row.expert)),
      outcomes: unique(extractionData.valid.map(row => row.outcome)),
    };
  }, [extractionData.valid]);

  const filteredRows = useMemo(() => {
    const matched = extractionData.valid.filter(row => matchesPhoneFilters(row, {
      channels: channelFilter, routes: routeFilter, experts: expertFilter, outcomes: outcomeFilter,
      contract: contractFilter, phoneKind: phoneKindFilter,
    }));
    if (rowMode === "all") return matched;
    const seen = new Set<string>();
    return matched.filter(row => seen.has(row.normalizedPhone) ? false : (seen.add(row.normalizedPhone), true));
  }, [channelFilter, contractFilter, expertFilter, extractionData.valid, outcomeFilter, phoneKindFilter, routeFilter, rowMode]);

  const uniquePhoneCount = useMemo(() => new Set(filteredRows.map(row => row.normalizedPhone)).size, [filteredRows]);

  const loadRows = async (preserveFilters = false) => {
    setNotice("");
    setError("");
    if (!dateIsValid(startDate) || !dateIsValid(endDate) || startDate > endDate) {
      setError("بازه تاریخ معتبر نیست. تاریخ را به شکل 1405/06/08 وارد کنید.");
      return;
    }
    if (endDate > todayDate) {
      setError(`تاریخ پایان نمی‌تواند بعد از امروز (${todayDate}) باشد.`);
      return;
    }
    const published = new Set(availableSheetMonths.map(month => month.value));
    const requestedMonths = getRangeMonths(startDate, endDate).map(month => month.value);
    // If discovery is temporarily unavailable, direct month fetching still lets this operational tool work.
    const months = published.size ? requestedMonths.filter(month => published.has(month)) : requestedMonths;
    if (!months.length) { setError("برای این بازه هیچ ماه منتشرشده‌ای در Google Sheets پیدا نشد."); return; }
    setLoading(true);
    try {
      const results = await Promise.all(months.map(month => fetchParsedSheetMonth(brandId, month, true)));
      setSourceRows(results.flatMap(result => result.rows));
      if (!preserveFilters) { setChannelFilter([]); setRouteFilter([]); setExpertFilter([]); setOutcomeFilter([]); }
      setNotice(`اطلاعات ${months.length.toLocaleString("en-US")} ماه دریافت شد و ${results.reduce((sum, result) => sum + result.rows.length, 0).toLocaleString("en-US")} ردیف برای فیلتر آماده است.`);
    } catch {
      setError("دریافت اطلاعات Google Sheets انجام نشد؛ اتصال را بررسی و دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => manualRefresh.register("استخراج شماره", () => loadRows(true)));

  // Populate filter options as soon as the manager opens the tab; the button remains for manual refresh.
  useEffect(() => {
    const timer = window.setTimeout(() => void loadRows(), 0);
    return () => window.clearTimeout(timer);
    // Initial extraction intentionally uses the first rendered date range for this brand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  const exportRows = filteredRows.map(row => ({
    "شماره استاندارد": row.normalizedPhone, "شماره ثبت‌شده": row.rawPhone, "تاریخ": row.date,
    "نام مسافر": row.passenger, "جنسیت": row.gender, "منبع فایل": row.rawSource, "کانال": row.channel,
    "مسیر": row.route, "کارشناس": row.expert, "نتیجه": row.outcome, "وضعیت قرارداد": row.contractStatus,
    "شغل مسافر": row.job, "توضیحات": row.notes, "ردیف شیت": row.sheetRow,
  }));

  const copyUniquePhones = async () => {
    const phones = [...new Set(filteredRows.map(row => row.normalizedPhone))];
    if (!phones.length) return;
    try { await navigator.clipboard.writeText(phones.join("\n")); setNotice(`${phones.length.toLocaleString("en-US")} شماره یکتا کپی شد.`); }
    catch { setError("مرورگر اجازه کپی مستقیم نداد؛ از فایل CSV استفاده کنید."); }
  };

  const downloadCsv = () => {
    if (!exportRows.length || !exportHeaders.length) return;
    const blob = new Blob([buildCsv(exportHeaders, exportRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `phone-extraction-${brandId}-${startDate.replaceAll("/", "-")}-${endDate.replaceAll("/", "-")}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("فایل CSV کامل آماده و دانلود شد.");
  };

  return <section className="phoneWorkspace glass" aria-labelledby="phone-extraction-title">
    <header className="phoneHeader"><div><span>ابزار ساده و قابل بررسی</span><h2 id="phone-extraction-title">استخراج شماره</h2><p>شماره‌های موبایل ایران و شماره‌های خارجی دارای پیش‌شماره کشور، همراه با اطلاعات کامل ردیف شیت.</p></div><div className="phonePrivacy">داده‌ها فقط در مرورگر پردازش می‌شوند و ذخیره نمی‌شوند.</div></header>
    <div className="phoneFilters">
      <label><span>از تاریخ</span><input dir="ltr" inputMode="numeric" value={startDate} onChange={event => setStartDate(event.target.value)} placeholder="1405/06/01"/></label>
      <label><span>تا تاریخ</span><input dir="ltr" inputMode="numeric" value={endDate} onChange={event => setEndDate(event.target.value)} placeholder="1405/06/31"/></label>
      <label><span>وضعیت قرارداد</span><select value={contractFilter} onChange={event => setContractFilter(event.target.value as typeof contractFilter)}><option value="all">همه</option><option value="contracted">فقط قرارداد شده</option><option value="not-contracted">فقط قرارداد نشده</option></select></label>
      <label><span>نوع شماره</span><select value={phoneKindFilter} onChange={event => setPhoneKindFilter(event.target.value as typeof phoneKindFilter)}><option value="all">ایران و خارجی</option><option value="iran">فقط ایران</option><option value="international">فقط خارجی</option></select></label>
      <PhoneMultiSelect label="کانال" allLabel="همه کانال‌ها" options={options.channels} selected={channelFilter} onChange={setChannelFilter}/>
      <PhoneMultiSelect label="مسیر" allLabel="همه مسیرها" options={options.routes} selected={routeFilter} onChange={setRouteFilter}/>
      <PhoneMultiSelect label="کارشناس" allLabel="همه کارشناسان" options={options.experts} selected={expertFilter} onChange={setExpertFilter}/>
      <PhoneMultiSelect label="نتیجه تماس" allLabel="همه نتایج" options={options.outcomes} selected={outcomeFilter} onChange={setOutcomeFilter}/>
      <label><span>ردیف‌های تکراری</span><select value={rowMode} onChange={event => setRowMode(event.target.value as typeof rowMode)}><option value="all">نمایش همه ردیف‌ها</option><option value="unique">فقط شماره یکتا</option></select></label>
      <button className="phoneExtractAction" type="button" onClick={() => void loadRows()} disabled={loading}>{loading ? "در حال دریافت…" : "استخراج شماره‌ها"}</button>
    </div>
    {(error || notice) && <div className={`phoneNotice ${error ? "error" : "success"}`} role="status">{error || notice}</div>}
    <div className="phoneStats">
      <article><span>ردیف خروجی</span><strong>{filteredRows.length.toLocaleString("en-US")}</strong></article>
      <article><span>شماره یکتا</span><strong>{uniquePhoneCount.toLocaleString("en-US")}</strong></article>
      <article><span>تکراری در خروجی</span><strong>{Math.max(0, filteredRows.length - uniquePhoneCount).toLocaleString("en-US")}</strong></article>
      <article><span>نامعتبر / بدون شماره</span><strong>{(extractionData.invalid + extractionData.missing).toLocaleString("en-US")}</strong></article>
    </div>
    <div className="phoneExportOptions"><PhoneMultiSelect label="ستون‌های خروجی CSV" allLabel="ستونی انتخاب نشده" options={PHONE_CSV_HEADERS} selected={exportHeaders} onChange={setExportHeaders}/><small>مدیر داشبورد می‌تواند قبل از هر دانلود، ستون‌های موردنیاز فایل را انتخاب یا حذف کند.</small></div>
    <div className="phoneActions"><span>{sourceRows.length ? `از ${extractionData.inRangeCount.toLocaleString("en-US")} ردیف در بازه انتخابی` : "ابتدا بازه را تعیین و استخراج را اجرا کنید."}</span><div><button type="button" onClick={() => void copyUniquePhones()} disabled={!filteredRows.length}>کپی شماره‌های یکتا</button><button className="primary" type="button" onClick={downloadCsv} disabled={!filteredRows.length || !exportHeaders.length}>دانلود CSV انتخابی</button></div></div>
    <div className="phoneTableWrap" tabIndex={0} aria-label="جدول نتایج استخراج شماره">
      <table className="phoneTable"><thead><tr>{PHONE_TABLE_HEADERS.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>
        {filteredRows.map(row => <tr key={row.id}><td dir="ltr">{row.normalizedPhone}</td><td dir="ltr">{row.rawPhone}</td><td dir="ltr">{row.date}</td><td>{row.passenger || "—"}</td><td>{row.gender || "—"}</td><td>{row.rawSource || "—"}</td><td>{row.channel}</td><td>{row.route}</td><td>{row.expert}</td><td>{row.outcome}</td><td><span className={row.contractStatus === "قرارداد شده" ? "contracted" : "notContracted"}>{row.contractStatus}</span></td><td className="notes" title={row.notes || ""}>{row.notes || "—"}</td><td dir="ltr">{row.sheetRow}</td></tr>)}
        {!filteredRows.length && <tr><td className="phoneEmpty" colSpan={PHONE_TABLE_HEADERS.length}>هنوز خروجی‌ای برای نمایش وجود ندارد.</td></tr>}
      </tbody></table>
    </div>
  </section>;
}

export default function Home({ initialTelegramVisible }: { initialTelegramVisible: boolean }) {
  // Global presentation and Google Sheet connection state.
  const [darkMode, setDarkMode] = useState(true);
  const [brands, setBrands] = useState<DashboardBrand[]>([DEFAULT_BRAND]);
  const [activeBrand, setActiveBrand] = useState<DashboardBrand>(DEFAULT_BRAND);
  const [brandRegistryReady, setBrandRegistryReady] = useState(false);
  const [brandRegistryError, setBrandRegistryError] = useState("");
  const [rulesLoadError, setRulesLoadError] = useState("");
  const [rulesReady, setRulesReady] = useState(false);
  const [activeDashboardRules, setActiveDashboardRules] = useState<DashboardRules>(DEFAULT_DASHBOARD_RULES);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasUsableData, setHasUsableData] = useState(false);
  const [integrityIssue, setIntegrityIssue] = useState("");
  const [sheetDataError, setSheetDataError] = useState("");
  const activeSourceRef = useRef("");
  const sourceIdentity = `${activeBrand.id}:${activeBrand.sheetCsvUrl}`;
  useEffect(() => { activeSourceRef.current = sourceIdentity; }, [sourceIdentity]);
  const [googleAdsConnection, setGoogleAdsConnection] = useState<GoogleAdsConnection>({ status: "checking" });
  const [searchConsoleConnection, setSearchConsoleConnection] = useState<SearchConsoleConnection>({ status: "checking" });
  // Tehran's current Persian date is stateful so an open dashboard rolls over at midnight without a page reload.
  const [today, setToday] = useState(() => getPersianToday());
  // Store the last internally consistent daily dashboard snapshot.
  const [dashboardData, setDashboardData] = useState<DashboardData>(() => createEmptyDashboardData(today.label));
  // A changed brand identity or source invalidates every previous metric until Sheet validation succeeds again.
  const brandSourceReady = canReadBrandSource(activeBrand) && rulesReady;
  const brandIsolationMessage = brandRegistryError || rulesLoadError || (!brandSourceReady
    ? !rulesReady ? `قواعد برند «${activeBrand.name}» در حال دریافت است؛ تا تکمیل بارگذاری هیچ داده‌ای نمایش داده نمی‌شود.` : `اطلاعات برند «${activeBrand.name}» هنوز با منبع Google Sheets خودش تأیید نشده است. برای جلوگیری از نمایش داده‌های برند قبلی، گزارش‌ها تا تأیید منبع نمایش داده نمی‌شوند؛ از تنظیمات، اتصال را آزمایش و برند را دوباره فعال کنید.`
    : "");
  const { sheetRows, todayTotal, average, change, sourceCounts, previousSourceCounts, routeCounts, expertMatrix, dataConflicts, dateIssueRows, monthlyExpertPerformance, channelContractCounts, health, activeDateLabel, activeDateKey, monthRecordTotal, monthRecordDate } = dashboardData;
  // Report navigation, date-range selection, and month-wide budget state.
  const currentMonth = today.sheetDate.slice(0, 7);
  const [activeView, setActiveView] = useState<"dashboard" | "google-ads" | "search-console" | "contracts" | "phone-extraction" | "budgets" | "settings">("dashboard");
  const activeViewRef = useRef(activeView);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  const [googleAdsReportReload] = useState(0);
  const [manualContracts, setManualContracts] = useState<Record<string, number>>({});
  const [manualContractsError, setManualContractsError] = useState(false);
  const [monthlyContractReload, setMonthlyContractReload] = useState(0);
  // Desktop keeps a compact navigation rail available; mobile opens it only on explicit demand.
  const [sideMenuOpen, setSideMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [selectedStartDate, setSelectedStartDate] = useState(`${currentMonth}/01`);
  const [selectedEndDate, setSelectedEndDate] = useState(today.sheetDate);
  // The top report follows an explicit calendar choice; null preserves the normal today/latest fallback.
  const [mainDateOverride, setMainDateOverride] = useState<string | null>(null);
  const dashboardCacheKey = `${DASHBOARD_CACHE_PREFIX}v4:${sourceIdentity}:${selectedMonth}:${mainDateOverride || "auto"}:${JSON.stringify(activeDashboardRules)}`;
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  // A chart click temporarily narrows the report; retain the pre-click range so the chart reset is deterministic.
  const chartRangeBeforeClickRef = useRef<{ startDate: string; endDate: string; month: string; mainDateOverride: string | null } | null>(null);
  const [selectedDateData, setSelectedDateData] = useState<SelectedDateData | null>(null);
  const [rangeComparison, setRangeComparison] = useState<RangeComparisonData | null>(null);
  const [selectedDateLoading, setSelectedDateLoading] = useState(false);
  const selectedDateScrollTopRef = useRef<number | null>(null);
  const [selectedDateError, setSelectedDateError] = useState("");
  const [selectedDateReload, setSelectedDateReload] = useState(0);
  const [selectedChannelFilter, setSelectedChannelFilter] = useState<string | null>(null);
  const [todayCosts, setTodayCosts] = useState<MarketingCostSnapshot | null>(null);
  const [rangeCosts, setRangeCosts] = useState<MarketingCostSnapshot | null>(null);
  const [previousRangeCosts, setPreviousRangeCosts] = useState<MarketingCostSnapshot | null>(null);
  const [costReload, setCostReload] = useState(0);
  const [budgetReminder, setBudgetReminder] = useState<{ missingItems: string[]; missingDaily: MissingDailyCost[]; start: string; end: string } | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(currentMonth);
  const [availableSheetMonths, setAvailableSheetMonths] = useState<SheetMonthDefinition[]>([]);
  const [sheetMonthsBrandId, setSheetMonthsBrandId] = useState("");
  const [sheetRegistryError, setSheetRegistryError] = useState("");
  const sheetMonthsReady = sheetMonthsBrandId === activeBrand.id && availableSheetMonths.length > 0;
  const monthOptions = useMemo<MonthOption[]>(() => {
    const futureBudgetMonths = activeView === "budgets" ? Array.from({ length: 12 }, (_, index) => {
      const value = shiftPersianMonth(currentMonth, index + 1);
      return { value, label: formatMonth(value) };
    }) : [];
    const options = [{ value: currentMonth, label: formatMonth(currentMonth) }, ...futureBudgetMonths, ...availableSheetMonths.map(({ value, label }) => ({ value, label }))];
    return [...new Map(options.map(option => [option.value, option])).values()].sort((a, b) => b.value.localeCompare(a.value));
  }, [activeView, availableSheetMonths, currentMonth]);
  // Memoize calendar geometry because it only changes when the visible month changes.
  const calendar = useMemo(() => getPersianMonthCalendar(calendarMonth), [calendarMonth]);
  // Refs coordinate network concurrency, accepted Sheet snapshots, and stale-request rejection.
  const calendarRef = useRef<HTMLDivElement>(null);
  const dailyRefreshGate = useRef(new RefreshGate());
  const hasConnected = useRef(false);
  const acceptedSnapshots = useRef<Record<string, AcceptedSnapshot>>({});
  const pendingSnapshots = useRef<Record<string, PendingSnapshot>>({});
  const consecutiveFailures = useRef(0);
  const lastSuccessAtRef = useRef(0);
  const selectedDateRequestId = useRef(0);
  const previousCurrentMonth = useRef(currentMonth);

  /** Loads the durable brand registry before any manager changes or switches a source. */
  const loadBrands = useCallback(async () => {
    try {
      const storedBrandId = window.localStorage.getItem(ACTIVE_BRAND_STORAGE_KEY) || "";
      const response = storedBrandId
        ? await fetchForBrand(`/api/brands?cachebust=${Date.now()}`, storedBrandId, { cache: "no-store" })
        : await fetch(`/api/brands?cachebust=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json() as { brands?: DashboardBrand[]; activeBrand?: DashboardBrand };
      if (!response.ok || !payload.brands?.length || !payload.activeBrand) throw new Error("brand_registry_unavailable");
      setBrands(payload.brands);
      setActiveBrand(payload.activeBrand);
      try { window.localStorage.setItem(ACTIVE_BRAND_STORAGE_KEY, payload.activeBrand.id); } catch { /* Optional device preference. */ }
      setBrandRegistryError("");
      setBrandRegistryReady(true);
    } catch {
      setBrandRegistryError("فهرست دفترها دریافت نشد. برای جلوگیری از نمایش اطلاعات دفتر اشتباه، گزارش هنوز بارگذاری نشده است؛ تلاش خودکار ادامه دارد.");
    }
  }, []);

  /** Switches the server-side brand context and reloads once so no in-flight request can cross brand boundaries. */
  const selectBrand = useCallback(async (id: string) => {
    const response = await fetch("/api/brands/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) throw new Error(payload.error || "انتخاب برند انجام نشد.");
    window.localStorage.setItem(ACTIVE_BRAND_STORAGE_KEY, id);
    window.location.reload();
  }, []);

  // Brand settings load once and remain persistent across reloads and future deployments.
  useEffect(() => {
    if (brandRegistryReady) return;
    const initial = window.setTimeout(() => void loadBrands(), 0);
    const retry = window.setInterval(() => void loadBrands(), 30000);
    return () => { window.clearTimeout(initial); window.clearInterval(retry); };
  }, [loadBrands, brandRegistryReady]);

  // Load and publish the selected brand's declarative rules before any Sheet parser or report runs.
  useEffect(() => {
    if (!brandRegistryReady || !activeBrand.id) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const loadRules = () => fetchForBrand(`/api/dashboard-rules?cachebust=${Date.now()}`, activeBrand.id, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { rules?: DashboardRules };
        if (!response.ok || !payload.rules) throw new Error("rules_unavailable");
        if (!controller.signal.aborted) { applyRuntimeRules(payload.rules); setActiveDashboardRules(payload.rules); setRulesReady(true); setRulesLoadError(""); }
      })
      .catch(() => { if (!controller.signal.aborted) { setRulesLoadError("قواعد همین دفتر دریافت نشد؛ گزارش با قواعد دفتر دیگر یا پیش‌فرض محاسبه نمی‌شود. تلاش خودکار ادامه دارد."); retry = setTimeout(loadRules, 30000); } });
    void loadRules();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [activeBrand.id, brandRegistryReady]);

  /** Discovers all published Persian month tabs and updates the shared Sheet registry atomically. */
  const loadSheetMonths = useCallback(async (manual = false) => {
    if (!brandRegistryReady || !brandSourceReady) return;
    try {
      const response = await fetchForBrand(`/api/sheet-months?cachebust=${Date.now()}`, activeBrand.id, { cache: "no-store" });
      const payload = await response.json() as { months?: SheetMonthDefinition[]; error?: string; reason?: string; warning?: string };
      if (!response.ok || response.headers.get("x-dashboard-brand") !== activeBrand.id || !payload.months?.length) {
        throw new Error(payload.error || payload.reason || "فهرست ماه‌ها خالی است.");
      }
      registerSheetMonths(activeBrand.id, payload.months);
      setAvailableSheetMonths(current => JSON.stringify(current) === JSON.stringify(payload.months) ? current : payload.months!);
      setSheetMonthsBrandId(activeBrand.id);
      setSheetRegistryError(payload.warning || "");
    } catch (error) {
      setSheetRegistryError(error instanceof Error ? error.message : "فهرست ماه‌های این برند دریافت نشد.");
      if (manual) throw error;
    }
  }, [activeBrand.id, brandRegistryReady, brandSourceReady]);

  // A brand change invalidates all Sheet-derived state before any request for the new source can start.
  /* eslint-disable react-hooks/set-state-in-effect -- security boundary reset intentionally precedes brand hydration */
  useEffect(() => {
    registerSheetMonths(activeBrand.id, []);
    updateSheetConnection({ brandId: activeBrand.id, status: "checking", lastCheck: "—", lastSuccessAt: 0 });
    setAvailableSheetMonths([]);
    setSheetMonthsBrandId("");
    setSheetRegistryError("");
    parsedSheetCache.clear();
    parsedSheetRequests.clear();
    sheetFailures.clear();
    sheetGeneration += 1;
    setSheetDataError("");
    setHasUsableData(false);
    setRulesReady(false);
    setActiveDashboardRules(DEFAULT_DASHBOARD_RULES);
    setDashboardData(createEmptyDashboardData(today.label));
    selectedDateRequestId.current += 1;
    hasConnected.current = false;
    consecutiveFailures.current = 0;
    lastSuccessAtRef.current = 0;
    acceptedSnapshots.current = {};
    pendingSnapshots.current = {};
    setSelectedDateData(null);
    setRangeComparison(null);
    setMainDateOverride(null);
    setSelectedMonth(currentMonth);
    setSelectedStartDate(`${currentMonth}/01`);
    setSelectedEndDate(today.sheetDate);
    setRangeAnchor(null);
    setCalendarMonth(currentMonth);
    setTodayCosts(null);
    setRangeCosts(null);
    setManualContracts({});
  }, [activeBrand.id, currentMonth, sourceIdentity, today.label, today.sheetDate]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Re-evaluate Tehran's date so the default month advances even when the page remains open overnight.
  useEffect(() => {
    const refreshTehranDate = () => {
      const next = getPersianToday();
      setToday(previous => previous.sheetDate === next.sheetDate && previous.label === next.label ? previous : next);
    };
    const timer = window.setInterval(refreshTehranDate, 30000);
    return () => window.clearInterval(timer);
  }, []);

  // Discover new tabs on load, focus, and every five minutes without requiring a new dashboard release.
  useEffect(() => {
    const initialDiscovery = window.setTimeout(() => void loadSheetMonths(), 0);
    const refreshOnFocus = () => void loadSheetMonths();
    window.addEventListener("focus", refreshOnFocus);
    const timer = window.setInterval(() => void loadSheetMonths(), 300000);
    return () => { window.clearTimeout(initialDiscovery); window.removeEventListener("focus", refreshOnFocus); window.clearInterval(timer); };
  }, [loadSheetMonths]);

  // Roll every shared month/date control into the new Persian month as soon as Tehran enters day one.
  useEffect(() => {
    if (previousCurrentMonth.current === currentMonth) return;
    previousCurrentMonth.current = currentMonth;
    setSelectedMonth(currentMonth);
    setSelectedStartDate(`${currentMonth}/01`);
    setSelectedEndDate(today.sheetDate);
    setMainDateOverride(null);
    setCalendarMonth(currentMonth);
    setRangeAnchor(null);
  }, [currentMonth, today.sheetDate]);

  // Unpublished future months remain budget-only; a published next-month tab can be inspected manually before rollover.
  /* eslint-disable react-hooks/set-state-in-effect -- invalid report months must return to the current published period */
  useEffect(() => {
    const selectedMonthIsPublished = availableSheetMonths.some(month => month.value === selectedMonth);
    if (activeView !== "budgets" && selectedMonth > currentMonth && !selectedMonthIsPublished) setSelectedMonth(currentMonth);
  }, [activeView, availableSheetMonths, currentMonth, selectedMonth]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /** Checks the server-side Google Ads credentials and real account accessibility. */
  const loadGoogleAdsStatus = useCallback(async () => {
    setGoogleAdsConnection(current => current.status === "connected" ? current : { status: "checking" });
    try {
      const response = await fetchForBrand(`/api/google-ads/status?cachebust=${Date.now()}`, activeBrand.id, { cache: "no-store" });
      const payload = await response.json() as GoogleAdsConnection;
      if (payload.status === "pending") setGoogleAdsConnection(payload);
      else if (!response.ok || payload.status !== "connected") setGoogleAdsConnection({ ...payload, status: "disconnected" });
      else setGoogleAdsConnection(payload);
    } catch {
      setGoogleAdsConnection({ status: "disconnected", checkedAt: new Date().toISOString() });
    }
  }, [activeBrand.id]);

  /** Checks Search Console independently; an unconfigured optional source stays pending. */
  const loadSearchConsoleStatus = useCallback(async () => {
    setSearchConsoleConnection(current => current.status === "connected" ? current : { status: "checking" });
    try {
      const response = await fetchForBrand(`/api/search-console/status?cachebust=${Date.now()}`, activeBrand.id, { cache: "no-store" });
      const payload = await response.json() as SearchConsoleConnection;
      if (payload.status === "pending") setSearchConsoleConnection(payload);
      else if (!response.ok || payload.status !== "connected") setSearchConsoleConnection({ ...payload, status: "disconnected" });
      else setSearchConsoleConnection(payload);
    } catch { setSearchConsoleConnection({ status: "disconnected", checkedAt: new Date().toISOString() }); }
  }, [activeBrand.id]);

  // Close the Persian calendar on outside click or Escape for keyboard accessibility.
  useEffect(() => {
    const closeCalendar = (event: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) setCalendarOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setCalendarOpen(false); };
    document.addEventListener("mousedown", closeCalendar);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("mousedown", closeCalendar);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, []);

  // Recheck Google Ads independently so its status never inherits the Google Sheet connection state.
  useEffect(() => {
    const initialStatusCheck = window.setTimeout(() => void loadGoogleAdsStatus(), 0);
    const adsStatusTimer = window.setInterval(() => void loadGoogleAdsStatus(), 60000);
    return () => { window.clearTimeout(initialStatusCheck); window.clearInterval(adsStatusTimer); };
  }, [loadGoogleAdsStatus]);

  useEffect(() => {
    const initialStatusCheck = window.setTimeout(() => void loadSearchConsoleStatus(), 0);
    const statusTimer = window.setInterval(() => void loadSearchConsoleStatus(), 60000);
    const unregister = manualRefresh.register("وضعیت Search Console", loadSearchConsoleStatus);
    return () => { window.clearTimeout(initialStatusCheck); window.clearInterval(statusTimer); unregister(); };
  }, [loadSearchConsoleStatus]);

  /** Fetches, validates, reconciles, and accepts one atomic Google Sheet snapshot. */
  const loadSheet = useCallback((forceRefresh = false) => dailyRefreshGate.current.run(async () => {
      if (!brandRegistryReady || !brandSourceReady || !sheetMonthsReady) return;
      // Future months are valid only for budget planning and must never mark Google Sheets disconnected.
      if (activeView === "budgets" && selectedMonth > currentMonth) return;
      // Every refresh belongs to the active brand; never reuse the previous office's green status.
      updateSheetConnection({ brandId: activeBrand.id, status: "checking" });
      try {
        // Reuse the same monthly response as the range report and parse only changed CSV text.
        const { rows, stale } = await fetchParsedSheetMonth(activeBrand.id, selectedMonth, forceRefresh);
        if (activeSourceRef.current !== sourceIdentity) return;
        // "منبع فایل" makes a row real; its reporting date comes only from the latest explicit daily block marker.
        const validRows = rows.filter(row => Boolean((row["منبع فایل"] || "").trim()));
        const nextDateIssueRows = validRows.filter(row => !row.__effectiveDate).map(row => row.__row);
        const monthRows = validRows.filter(row => row.__effectiveDate.startsWith(selectedMonth));
        const observedMonths = new Set(validRows.map(row => row.__effectiveDate.slice(0, 7)).filter(Boolean));
        if (observedMonths.size > 0 && !observedMonths.has(selectedMonth)) throw new Error("selected month tab unavailable");
        // Build month-wide expert performance and health diagnostics independently from the active-day cards.
        const monthlyPerformance: MonthlyExpertPerformance = {};
        const monthlyChannelCounts: Record<string, number> = {};
        const monthlyRouteCounts: Record<string, number> = {};
        const monthlyExpertCounts: Record<string, number> = {};
        const monthlyConflictMap = new Map<string, DataConflict>();
        const missingRouteRows: string[] = [];
        const missingExpertRows: string[] = [];
        monthRows.forEach(row => {
          const source = row["منبع فایل"] || "";
          const rawExpert = runtimeRules.sheetColumns.expert ? (row["کارشناس"] || "").trim() : "";
          const expert = runtimeRules.sheetColumns.expert ? (rawExpert ? canonicalExpertName(rawExpert) : "کارشناس ثبت نشده") : "";
          const route = runtimeRules.sheetColumns.route ? normalizeRoute(row["مسیر"] || "") : "";
          monthlyChannelCounts[source] = (monthlyChannelCounts[source] || 0) + 1;
          if (route) monthlyRouteCounts[route] = (monthlyRouteCounts[route] || 0) + 1;
          if (expert) monthlyExpertCounts[expert] = (monthlyExpertCounts[expert] || 0) + 1;
          if (runtimeRules.sheetColumns.route && route === "مسیر ثبت نشده") missingRouteRows.push(row.__row);
          if (runtimeRules.sheetColumns.expert && expert === "کارشناس ثبت نشده") missingExpertRows.push(row.__row);
          if (runtimeRules.sheetColumns.expert && expert !== "کارشناس ثبت نشده") {
            const current = monthlyPerformance[expert] || { calls: 0, sheetContracts: 0 };
            current.calls += 1;
            if (isContractOutcome(getRowOutcome(row))) current.sheetContracts += 1;
            monthlyPerformance[expert] = current;
          }
          const matched = channelDefs.some(channel => channel.keys.some(key => normalizeSource(key) === normalizeSource(source)));
          if (!matched) {
            const existing = monthlyConflictMap.get(source) || { source, rows: [] };
            existing.rows.push(row.__row);
            monthlyConflictMap.set(source, existing);
          }
        });
        // An explicit calendar choice owns the top report. Only the untouched default may fall back to latest recorded data.
        const monthDates = [...new Set(monthRows.map(row => row.__effectiveDate).filter(Boolean))].sort();
        const dateResolution = resolveDailyReportDate({
          selectedMonth,
          currentMonth,
          todayDate: today.sheetDate,
          manualDateOverride: mainDateOverride,
          availableDates: monthDates,
        });
        const activeDate = dateResolution.date;
        const activeRows = monthRows.filter(row => row.__effectiveDate === activeDate);
        const activeWeekday = activeRows[0]?.["روز های هفته"] || activeRows[0]?.["روزهای هفته"] || "";
        const nextActiveDateLabel = dateResolution.mode === "selected"
          ? `روز انتخاب‌شده: ${formatRecordedDate(activeDate, activeWeekday)}`
          : dateResolution.mode === "today"
            ? getPersianToday().label
            : dateResolution.mode === "latest"
              ? `آخرین روز دارای داده: ${formatRecordedDate(activeDate, activeWeekday)}`
              : mainDateOverride
                ? `برای ${formatRecordedDate(mainDateOverride)} داده‌ای ثبت نشده است`
                : `بدون داده در ${formatMonth(selectedMonth)}`;
        // Build independent channel, route, and expert aggregates from the exact same valid rows.
        const counts: Record<string, number> = {};
        activeRows.forEach(row => { const source = row["منبع فایل"] || ""; counts[source] = (counts[source] || 0) + 1; });
        const nextChannelContractCounts: Record<string, number> = {};
        activeRows.forEach(row => {
          if (!isContractOutcome(getRowOutcome(row))) return;
          const channel = getChannelName(row["منبع فایل"] || "");
          nextChannelContractCounts[channel] = (nextChannelContractCounts[channel] || 0) + 1;
        });
        const routes: Record<string, number> = {};
        activeRows.forEach(row => {
          const route = normalizeRoute(row["مسیر"] || "");
          routes[route] = (routes[route] || 0) + 1;
        });
        const experts: ExpertMatrix = {};
        activeRows.forEach(row => {
          const rawExpert = (row["کارشناس"] || "").trim();
          const expert = rawExpert ? canonicalExpertName(rawExpert) : "کارشناس ثبت نشده";
          const channel = getChannelName(row["منبع فایل"] || "");
          const route = normalizeRoute(row["مسیر"] || "");
          const current = experts[expert] || { total: 0, sheetContracts: 0, channelContracts: {}, contractRoutes: {}, contractRouteChannels: {}, aliases: [], channels: {}, routes: {}, routeChannels: {} };
          current.total += 1;
          if (isContractOutcome(getRowOutcome(row))) {
            current.sheetContracts = (current.sheetContracts || 0) + 1;
            current.channelContracts ||= {};
            current.channelContracts[channel] = (current.channelContracts[channel] || 0) + 1;
            current.contractRoutes ||= {};
            const contractRoute = route === "مسیر ثبت نشده" ? "بدون مسیر قابل انتساب" : route;
            current.contractRoutes[contractRoute] = (current.contractRoutes[contractRoute] || 0) + 1;
            // Preserve the exact source mix for every contracted destination in the daily expert card.
            current.contractRouteChannels ||= {};
            current.contractRouteChannels[contractRoute] ||= {};
            current.contractRouteChannels[contractRoute][channel] = (current.contractRouteChannels[contractRoute][channel] || 0) + 1;
          }
          if (rawExpert && !current.aliases?.includes(rawExpert)) current.aliases = [...(current.aliases || []), rawExpert];
          current.channels[channel] = (current.channels[channel] || 0) + 1;
          current.routes[route] = (current.routes[route] || 0) + 1;
          current.routeChannels ||= {};
          current.routeChannels[route] ||= {};
          current.routeChannels[route][channel] = (current.routeChannels[route][channel] || 0) + 1;
          experts[expert] = current;
        });
        // Preserve every unmatched source as its own visible channel and record its Sheet row.
        const conflictMap = new Map<string, DataConflict>();
        activeRows.forEach(row => {
          const source = row["منبع فایل"] || "";
          const matchedChannel = channelDefs.find(channel => channel.keys.some(key => normalizeSource(key) === normalizeSource(source)));
          if (matchedChannel) return;
          const suggestedChannel = channelDefs.find(channel => channel.keys.some(key => normalizeSource(key) === normalizeSource(source)));
          const existing = conflictMap.get(source) || { source, rows: [], suggestion: suggestedChannel?.name };
          existing.rows.push(row.__row);
          conflictMap.set(source, existing);
        });

        // Calculate previous-workday comparisons and the monthly daily average.
        const totalsByDate: Record<string, number> = {};
        monthRows.forEach(row => { const date = row.__effectiveDate; if (date) totalsByDate[date] = (totalsByDate[date] || 0) + 1; });
        const recordedDates = Object.keys(totalsByDate).sort();
        const previousDate = recordedDates.filter(date => date < activeDate).at(-1);
        const previousRecordDate = recordedDates
          .filter(date => date < activeDate)
          .sort((left, right) => totalsByDate[right] - totalsByDate[left] || right.localeCompare(left))[0] || "";
        const previousRecordTotal = previousRecordDate ? totalsByDate[previousRecordDate] : 0;
        const previousTotal = previousDate ? totalsByDate[previousDate] : 0;
        const previousCounts: Record<string, number> = {};
        if (previousDate) {
          monthRows.filter(row => row.__effectiveDate === previousDate).forEach(row => {
            const source = row["منبع فایل"] || "";
            previousCounts[source] = (previousCounts[source] || 0) + 1;
          });
        }
        const validRecordedDays = recordedDates.length;
        const avg = validRecordedDays ? Math.round(monthRows.length / validRecordedDays) : 0;
        // Sign each snapshot so temporary Sheet inconsistencies do not replace a known-valid view.
        const snapshotSignature = monthRows
          .map(row => `${row.__row}|${row.__effectiveDate}|${normalizeSource(row["منبع فایل"] || "")}|${(row["کارشناس"] || "").trim()}|${normalizeRoute(row["مسیر"] || "")}|${getRowOutcome(row)}`)
          .join("\n");
        const accepted = acceptedSnapshots.current[selectedMonth];
        const snapshotChanged = !accepted || accepted.signature !== snapshotSignature;
        const isImmediateIncrease = Boolean(accepted && monthRows.length > accepted.total);
        let acceptSnapshot = forceRefresh || !accepted || accepted.signature === snapshotSignature || isImmediateIncrease;

        // Decreases or edits must repeat consistently before acceptance; increases appear immediately.
        if (!acceptSnapshot) {
          const pending = pendingSnapshots.current[selectedMonth];
          const hits = pending?.signature === snapshotSignature ? pending.hits + 1 : 1;
          pendingSnapshots.current[selectedMonth] = { signature: snapshotSignature, hits };
          acceptSnapshot = hits >= 3;
        }

        // Reconcile every aggregate with the overall valid-row count before publishing the snapshot.
        if (acceptSnapshot) {
          const sourceTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
          const routeTotal = Object.values(routes).reduce((sum, count) => sum + count, 0);
          const expertTotal = Object.values(experts).reduce((sum, expert) => sum + expert.total, 0);
          if ([sourceTotal, routeTotal, expertTotal].some(total => total !== activeRows.length)) {
            setIntegrityIssue(`اختلاف در اسنپ‌شات جدید: کل ${activeRows.length.toLocaleString("en-US")}، کانال‌ها ${sourceTotal.toLocaleString("en-US")}، مسیرها ${routeTotal.toLocaleString("en-US")}، کارشناسان ${expertTotal.toLocaleString("en-US")}`);
            throw new Error("inconsistent daily snapshot");
          }
          // Commit all daily metrics together so the interface never shows mixed refresh states.
          const nextDashboardData: DashboardData = {
            sheetRows: validRows.length,
            todayTotal: activeRows.length,
            average: avg,
            change: previousTotal ? Math.round(((activeRows.length - previousTotal) / previousTotal) * 100) : 0,
            sourceCounts: counts,
            previousSourceCounts: previousCounts,
            routeCounts: routes,
            expertMatrix: experts,
            dataConflicts: [...conflictMap.values()],
            dateIssueRows: nextDateIssueRows,
            monthlyExpertPerformance: monthlyPerformance,
            channelContractCounts: nextChannelContractCounts,
            activeDateKey: activeDate,
            monthRecordTotal: previousRecordTotal,
            monthRecordDate: previousRecordDate,
            health: {
              monthTotal: monthRows.length,
              channelTotal: Object.values(monthlyChannelCounts).reduce((sum, count) => sum + count, 0),
              routeTotal: Object.values(monthlyRouteCounts).reduce((sum, count) => sum + count, 0),
              expertTotal: Object.values(monthlyExpertCounts).reduce((sum, count) => sum + count, 0),
              unknownSources: [...monthlyConflictMap.values()],
              dateIssueRows: nextDateIssueRows,
              missingRouteRows,
              missingExpertRows,
            },
            activeDateLabel: nextActiveDateLabel,
          };
          acceptedSnapshots.current[selectedMonth] = { signature: snapshotSignature, total: monthRows.length };
          delete pendingSnapshots.current[selectedMonth];
          // Avoid rebuilding the full dashboard when the periodic poll returns an identical snapshot.
          if (snapshotChanged) setDashboardData(nextDashboardData);
          setIntegrityIssue("");
          setHasUsableData(true);
          // Cache only a fully reconciled snapshot for offline/error fallback display.
          const cachePayload: CachedDashboard = {
            savedAt: Date.now(), signature: snapshotSignature, total: monthRows.length,
            ...nextDashboardData,
          };
          if (snapshotChanged) try { window.localStorage.setItem(dashboardCacheKey, JSON.stringify(cachePayload)); } catch { /* Durable server cache remains available when local storage is full. */ }
        }
        hasConnected.current = true;
        consecutiveFailures.current = 0;
        const successTime = Date.now();
        lastSuccessAtRef.current = successTime;
        setSheetDataError(stale ? "گوگل‌شیت فعلاً پاسخ تازه‌ای نداد؛ آخرین دادهٔ معتبر همین دفتر و همین منبع نمایش داده می‌شود. بروزرسانی خودکار ادامه دارد." : "");
        updateSheetConnection({ status: stale ? "unstable" : "connected", lastSuccessAt: successTime });
      } catch (error) {
        if (activeSourceRef.current !== sourceIdentity) return;
        setSheetDataError(`${error instanceof Error ? error.message : "دریافت داده ناموفق بود."} اگر دادهٔ قبلی موجود باشد حفظ می‌شود؛ در غیر این صورت هنوز گزارشی برای نمایش دریافت نشده است. بروزرسانی خودکار ادامه دارد؛ در صورت تداوم، اتصال همین دفتر را در تنظیمات بررسی کنید.`);
        // Keep the last valid data visible and downgrade only the connection status.
        consecutiveFailures.current += 1;
        const recentlyConnected = lastSuccessAtRef.current > 0 && Date.now() - lastSuccessAtRef.current < 60000;
        updateSheetConnection({ status: consecutiveFailures.current < 3 && recentlyConnected ? "unstable" : "disconnected" });
        if (forceRefresh) throw error;
      } finally {
        // Always release the refresh lock and expose the latest attempt time.
        updateSheetConnection({ lastCheck: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()) });
      }
  }, forceRefresh), [activeBrand.id, activeView, brandRegistryReady, brandSourceReady, currentMonth, mainDateOverride, selectedMonth, sheetMonthsReady, today.sheetDate, setDashboardData, sourceIdentity, dashboardCacheKey]);

  const [manualRefreshMessage, setManualRefreshMessage] = useState("");
  const manualClickLock = useRef(false);
  const handleManualRefresh = async () => {
    if (manualClickLock.current) return;
    manualClickLock.current = true;
    setIsRefreshing(true); setManualRefreshMessage("");
    sheetGeneration += 1; parsedSheetCache.clear(); sheetFailures.clear();
    try {
      const failures = await manualRefresh.run();
      setManualRefreshMessage(failures.length ? `بروزرسانی کامل نشد — ${failures.join(" | ")}` : "بروزرسانی تب و وضعیت اتصال‌ها انجام شد.");
    } finally { manualClickLock.current = false; setIsRefreshing(false); }
  };
  useEffect(() => manualRefresh.register("فهرست ماه‌ها", async () => {
    if (activeView !== "settings") await loadSheetMonths(true);
  }, 0), [activeView, loadSheetMonths]);
  useEffect(() => manualRefresh.register("گزارش روزانه", async () => {
    if (activeView === "dashboard") await loadSheet(true);
  }), [activeView, loadSheet]);
  useEffect(() => manualRefresh.register("وضعیت دفتر", async () => {
    await loadGoogleAdsStatus(); await loadBrands();
  }, 2), [loadBrands, loadGoogleAdsStatus]);

  // Fetch and aggregate all Sheet rows inside the independently selected Persian date range.
  useEffect(() => {
    if (!brandRegistryReady || !brandSourceReady || !sheetMonthsReady) return;
    const loadSelectedRange = async () => {
      const requestId = ++selectedDateRequestId.current;
      if (typeof window !== "undefined" && window.scrollY > 0) selectedDateScrollTopRef.current = window.scrollY;
      setSelectedDateLoading(true);
      setSelectedDateError("");
      // Keep the last valid range visible while refreshing to prevent layout collapse and scroll jumps.
      try {
        // Load every monthly tab touched by the selected start/end dates.
        const rangeMonths = getRangeMonths(selectedStartDate, selectedEndDate);
        if (!rangeMonths.length) throw new Error("missing sheet");
        const rowsByMonth = await Promise.all(rangeMonths.map(async month => {
          const { rows, stale } = await fetchParsedSheetMonth(activeBrand.id, month.value);
          if (stale && requestId === selectedDateRequestId.current) setSelectedDateError("گوگل‌شیت پاسخ تازه‌ای نداد؛ گزارش از آخرین دادهٔ معتبر همین دفتر تهیه شده است.");
          const validMonthRows = rows.filter(row => Boolean((row["منبع فایل"] || "").trim()));
          const observedMonths = new Set(validMonthRows.map(row => row.__effectiveDate.slice(0, 7)).filter(Boolean));
          if (observedMonths.size > 0 && !observedMonths.has(month.value)) throw new Error("selected month tab unavailable");
          return validMonthRows
            .filter(row => !row.__effectiveDate || row.__effectiveDate.startsWith(month.value))
            .map(row => ({
              ...row,
              __leadRef: `${month.value}:${row.__row}`,
              __row: `${month.label} · ${row.__row}`,
            }) as SheetRow & { __effectiveDate: string; __row: string });
        }));
        // Filter once, then derive all selected-range reports from this single row collection.
        const allRangeRows = rowsByMonth.flat();
        const nextDateIssueRows = allRangeRows.filter(row => !row.__effectiveDate).map(row => row.__row);
        const activeRows = allRangeRows.filter(row => row.__effectiveDate >= selectedStartDate && row.__effectiveDate <= selectedEndDate);
        const counts: Record<string, number> = {};
        const routes: Record<string, number> = {};
        const experts: ExpertMatrix = {};
        const resolvedLeadChannels = new Map<string, string>();
        const conflictMap = new Map<string, DataConflict>();
        activeRows.forEach(row => {
          const source = row["منبع فایل"] || "";
          const channel = getChannelName(source);
          const route = normalizeRoute(row["مسیر"] || "");
          const rawExpert = (row["کارشناس"] || "").trim();
          const expert = rawExpert ? canonicalExpertName(rawExpert) : "کارشناس ثبت نشده";
          counts[source] = (counts[source] || 0) + 1;
          routes[route] = (routes[route] || 0) + 1;
          if (getRowOutcome(row)) resolvedLeadChannels.set(row.__leadRef, channel);
          const current = experts[expert] || { total: 0, sheetContracts: 0, channelContracts: {}, contractRoutes: {}, contractRouteChannels: {}, aliases: [], channels: {}, routes: {}, routeChannels: {} };
          current.total += 1;
          if (isContractOutcome(getRowOutcome(row))) {
            current.sheetContracts = (current.sheetContracts || 0) + 1;
            current.channelContracts ||= {};
            current.channelContracts[channel] = (current.channelContracts[channel] || 0) + 1;
            current.contractRoutes ||= {};
            const contractRoute = route === "مسیر ثبت نشده" ? "بدون مسیر قابل انتساب" : route;
            current.contractRoutes[contractRoute] = (current.contractRoutes[contractRoute] || 0) + 1;
            // Preserve contracted destination-to-channel attribution for every shared range snapshot.
            current.contractRouteChannels ||= {};
            current.contractRouteChannels[contractRoute] ||= {};
            current.contractRouteChannels[contractRoute][channel] = (current.contractRouteChannels[contractRoute][channel] || 0) + 1;
          }
          if (rawExpert && !current.aliases?.includes(rawExpert)) current.aliases = [...(current.aliases || []), rawExpert];
          current.channels[channel] = (current.channels[channel] || 0) + 1;
          current.routes[route] = (current.routes[route] || 0) + 1;
          current.routeChannels ||= {};
          current.routeChannels[route] ||= {};
          current.routeChannels[route][channel] = (current.routeChannels[route][channel] || 0) + 1;
          experts[expert] = current;
          const matched = channelDefs.some(channel => channel.keys.some(key => normalizeSource(key) === normalizeSource(source)));
          if (!matched) {
            const existing = conflictMap.get(source) || { source, rows: [] };
            existing.rows.push(row.__row);
            conflictMap.set(source, existing);
          }
        });
        // Include zero-contact calendar days so the line chart preserves the real timeline.
        const dailyCountMap: Record<string, number> = {};
        const dailyContractMap: Record<string, number> = {};
        const dailyChannelCounts: Record<string, Record<string, number>> = {};
        const attributableContracts = new Map<string, { date: string; month: string; channel: string; expert: string; route: string; source: "sheet" | "detailed" }>();
        activeRows.forEach(row => {
          const channel = getChannelName(row["منبع فایل"] || "");
          const route = normalizeRoute(row["مسیر"] || "");
          const rawExpert = (row["کارشناس"] || "").trim();
          const expert = rawExpert ? canonicalExpertName(rawExpert) : "کارشناس ثبت نشده";
          dailyCountMap[row.__effectiveDate] = (dailyCountMap[row.__effectiveDate] || 0) + 1;
          dailyChannelCounts[row.__effectiveDate] ||= {};
          dailyChannelCounts[row.__effectiveDate][channel] = (dailyChannelCounts[row.__effectiveDate][channel] || 0) + 1;
          if (isContractOutcome(getRowOutcome(row))) {
            dailyContractMap[row.__effectiveDate] = (dailyContractMap[row.__effectiveDate] || 0) + 1;
            attributableContracts.set(row.__leadRef, { date: row.__effectiveDate, month: row.__effectiveDate.slice(0, 7), channel, expert, route: route === "مسیر ثبت نشده" ? "بدون مسیر قابل انتساب" : route, source: "sheet" });
          }
        });
        const dailyCounts = rangeMonths.flatMap(month => getPersianMonthCalendar(month.value).days.map(day => ({
          date: `${month.value}/${String(day).padStart(2, "0")}`,
          value: dailyCountMap[`${month.value}/${String(day).padStart(2, "0")}`] || 0,
          contracts: dailyContractMap[`${month.value}/${String(day).padStart(2, "0")}`] || 0,
          weekday: getPersianWeekday(`${month.value}/${String(day).padStart(2, "0")}`),
        }))).filter(day => day.date >= selectedStartDate && day.date <= selectedEndDate).sort((a, b) => a.date.localeCompare(b.date));
        // Resolve range efficiency month by month: an explicit manual value wins, otherwise the Sheet result inside the selected range is used.
        const performanceByMonth: Record<string, Record<string, { calls: number; sheetContracts: number }>> = {};
        activeRows.forEach(row => {
          const rawExpert = (row["کارشناس"] || "").trim();
          if (!rawExpert) return;
          const expert = canonicalExpertName(rawExpert);
          const monthKey = row.__effectiveDate.slice(0, 7);
          performanceByMonth[monthKey] ||= {};
          const performance = performanceByMonth[monthKey][expert] || { calls: 0, sheetContracts: 0 };
          performance.calls += 1;
          if (isContractOutcome(getRowOutcome(row))) performance.sheetContracts += 1;
          performanceByMonth[monthKey][expert] = performance;
        });
        const manualResponses = await Promise.allSettled(rangeMonths.map(async month => {
          const response = await fetchForBrand(`/api/expert-contracts?month=${encodeURIComponent(month.value)}`, activeBrand.id, { cache: "no-store" });
          if (!response.ok) throw new Error("manual_contracts_unavailable");
          const payload = await response.json() as { entries?: ManualContractEntry[] };
          return [month.value, Object.fromEntries([...aggregateManualContractEntries(payload.entries || []).entries()].map(([expert, entry]) => [expert, entry.contractCount]))] as const;
        }));
        const detailedResponses = await Promise.allSettled(rangeMonths.map(async month => {
          const response = await fetchForBrand(`/api/expert-contract-records?month=${encodeURIComponent(month.value)}`, activeBrand.id, { cache: "no-store" });
          if (!response.ok) throw new Error("detailed_contracts_unavailable");
          const payload = await response.json() as { records?: DetailedContractRecord[] };
          return payload.records || [];
        }));
        const manualByMonth: Record<string, Record<string, number>> = {};
        let manualContractsUnavailable = false;
        manualResponses.forEach(result => {
          if (result.status === "fulfilled") manualByMonth[result.value[0]] = result.value[1];
          else {
            manualContractsUnavailable = true;
          }
        });
        detailedResponses.forEach(result => {
          if (result.status !== "fulfilled") return;
          result.value.filter(record => record.firstContactDate >= selectedStartDate && record.firstContactDate <= selectedEndDate)
            .forEach(record => attributableContracts.set(record.leadRef, {
              date: record.firstContactDate,
              month: record.month,
              channel: getChannelName(record.sourceChannel),
              expert: canonicalExpertName(record.expert),
              route: record.route ? normalizeRoute(record.route) : "بدون مسیر قابل انتساب",
              source: "detailed",
            }));
        });
        // Manual monthly data has priority: retain its detailed records but suppress Sheet outcomes for that expert/month.
        attributableContracts.forEach((contract, leadRef) => {
          const manual = manualByMonth[contract.month];
          if (contract.source === "sheet" && manual && Object.prototype.hasOwnProperty.call(manual, contract.expert)) attributableContracts.delete(leadRef);
        });
        // A confirmed detailed contract is also a resolved lead even when its Sheet outcome cell is still blank.
        // This keeps the funnel monotonic without inventing outcomes or counting monthly aggregate contracts as attributable leads.
        const resolvedOutcomeChannels = new Map(resolvedLeadChannels);
        attributableContracts.forEach((contract, leadRef) => {
          if (!resolvedOutcomeChannels.has(leadRef)) resolvedOutcomeChannels.set(leadRef, contract.channel);
        });
        const outcomeCountsByChannel: Record<string, number> = {};
        resolvedOutcomeChannels.forEach(channel => {
          outcomeCountsByChannel[channel] = (outcomeCountsByChannel[channel] || 0) + 1;
        });
        const channelContractCounts: Record<string, number> = {};
        const expertChannelContracts: Record<string, Record<string, number>> = {};
        const expertContractRouteChannels: Record<string, Record<string, Record<string, number>>> = {};
        const dailyChannelContracts: Record<string, Record<string, number>> = {};
        attributableContracts.forEach(contract => {
          channelContractCounts[contract.channel] = (channelContractCounts[contract.channel] || 0) + 1;
          expertChannelContracts[contract.expert] ||= {};
          expertChannelContracts[contract.expert][contract.channel] = (expertChannelContracts[contract.expert][contract.channel] || 0) + 1;
          expertContractRouteChannels[contract.expert] ||= {};
          expertContractRouteChannels[contract.expert][contract.route] ||= {};
          expertContractRouteChannels[contract.expert][contract.route][contract.channel] = (expertContractRouteChannels[contract.expert][contract.route][contract.channel] || 0) + 1;
          dailyChannelContracts[contract.date] ||= {};
          dailyChannelContracts[contract.date][contract.channel] = (dailyChannelContracts[contract.date][contract.channel] || 0) + 1;
        });
        dailyCounts.forEach(day => {
          day.contracts = Object.values(dailyChannelContracts[day.date] || {}).reduce((sum, count) => sum + count, 0);
        });
        const expertEfficiency: SelectedDateData["expertEfficiency"] = {};
        Object.entries(experts).forEach(([expert, data]) => {
          if (expert === "کارشناس ثبت نشده") return;
          let contracts = 0;
          let manualMonths = 0;
          let sheetMonths = 0;
          let zeroContractMonths = 0;
          rangeMonths.forEach(month => {
            const performance = performanceByMonth[month.value]?.[expert];
            if (!performance?.calls) return;
            const manual = manualByMonth[month.value];
            if (manual && Object.prototype.hasOwnProperty.call(manual, expert)) {
              contracts += manual[expert];
              manualMonths += 1;
            } else {
              contracts += performance.sheetContracts;
              sheetMonths += 1;
              if (performance.sheetContracts === 0) zeroContractMonths += 1;
            }
          });
          const source = manualMonths && sheetMonths ? "ورودی دستی + Google Sheets"
            : manualMonths ? "ورودی دستی"
            : sheetMonths ? "Google Sheets"
            : "بدون قرارداد ثبت‌شده";
          expertEfficiency[expert] = {
            contracts,
            percentage: data.total > 0 ? contracts / data.total * 100 : 0,
            source: zeroContractMonths > 0 ? `${source} · ${zeroContractMonths.toLocaleString("en-US")} ماه بدون قرارداد` : source,
            anomaly: contracts > data.total,
          };
        });
        const resolvedExpertEfficiencies = Object.values(expertEfficiency);
        const resolvedContractTotal = resolvedExpertEfficiencies.length
          ? resolvedExpertEfficiencies.reduce((sum, item) => sum + item.contracts, 0)
          : null;
        const contractAttributionGap = resolvedContractTotal === null ? 0 : Math.max(0, resolvedContractTotal - attributableContracts.size);
        const recordedDays = dailyCounts.filter(day => day.value > 0).length;
        const sourceTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
        const routeTotal = Object.values(routes).reduce((sum, count) => sum + count, 0);
        const expertTotal = Object.values(experts).reduce((sum, expert) => sum + expert.total, 0);
        const dailyTotal = dailyCounts.reduce((sum, day) => sum + day.value, 0);
        // The total, channels, routes, experts, and line-chart points must reconcile exactly.
        if ([sourceTotal, routeTotal, expertTotal, dailyTotal].some(total => total !== activeRows.length)) throw new Error("inconsistent selected range");
        if (requestId !== selectedDateRequestId.current) return;
        const nextRange: SelectedDateData = {
          total: activeRows.length,
          resolvedOutcomeCount: resolvedOutcomeChannels.size,
          outcomeCountsByChannel,
          average: recordedDays ? Math.round(activeRows.length / recordedDays) : 0,
          recordedDays,
          dailyCounts,
          dailyChannelCounts,
          dailyChannelContracts,
          sourceCounts: counts,
          routeCounts: routes,
          expertMatrix: experts,
          expertEfficiency,
          expertChannelContracts,
          expertContractRouteChannels,
          channelContractCounts,
          contractAttributionGap,
          resolvedContractTotal,
          manualContractsUnavailable,
          conflicts: [...conflictMap.values()],
          dateIssueRows: nextDateIssueRows,
          label: `${formatRecordedDate(selectedStartDate)} تا ${formatRecordedDate(selectedEndDate)}`,
        };
        setSelectedDateData(previous => JSON.stringify(previous) === JSON.stringify(nextRange) ? previous : nextRange);
      } catch (error) {
        if (requestId === selectedDateRequestId.current) setSelectedDateError(`${error instanceof Error ? error.message : "دادهٔ این بازه دریافت نشد."} آخرین گزارش معتبر حفظ شده است؛ دریافت خودکار دوباره انجام می‌شود.`);
      } finally {
        if (requestId === selectedDateRequestId.current) {
          setSelectedDateLoading(false);
          const preservedTop = selectedDateScrollTopRef.current;
          if (preservedTop !== null) window.requestAnimationFrame(() => {
            const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            if (window.scrollY > preservedTop + 180 && window.scrollY >= maxScroll - 40) window.scrollTo({ top: preservedTop, behavior: "auto" });
          });
        }
      }
    };
    void loadSelectedRange();
    const unregister = manualRefresh.register("گزارش بازه", async () => { if (activeViewRef.current === "dashboard") await loadSelectedRange(); });
    return () => { unregister(); selectedDateRequestId.current += 1; };
  }, [activeBrand.id, brandRegistryReady, brandSourceReady, currentMonth, selectedEndDate, selectedStartDate, selectedDateReload, sheetMonthsReady, today.sheetDate]);

  // Compare the selected range with the immediately preceding range of identical calendar length.
  useEffect(() => {
    if (!brandRegistryReady || !brandSourceReady || !sheetMonthsReady) return;
    const controller = new AbortController();
    const loadComparison = async () => {
      const previous = getPreviousEquivalentRange(selectedStartDate, selectedEndDate);
      try {
        const months = getRangeMonths(previous.startDate, previous.endDate);
        const rowsByMonth = await Promise.all(months.map(async month => {
          const { rows } = await fetchParsedSheetMonth(activeBrand.id, month.value, false);
          return rows.filter(row => Boolean((row["منبع فایل"] || "").trim()) && row.__effectiveDate >= previous.startDate && row.__effectiveDate <= previous.endDate);
        }));
        const rows = rowsByMonth.flat();
        const recordedDays = new Set(rows.map(row => row.__effectiveDate).filter(Boolean)).size;
        const performance: Record<string, Record<string, { calls: number; sheetContracts: number }>> = {};
        rows.forEach(row => {
          const rawExpert = (row["کارشناس"] || "").trim();
          if (!rawExpert) return;
          const expert = canonicalExpertName(rawExpert);
          const month = row.__effectiveDate.slice(0, 7);
          performance[month] ||= {};
          const item = performance[month][expert] || { calls: 0, sheetContracts: 0 };
          item.calls += 1;
          if (isContractOutcome(getRowOutcome(row))) item.sheetContracts += 1;
          performance[month][expert] = item;
        });
        const manualResponses = await Promise.allSettled(months.map(async month => {
          const response = await fetchForBrand(`/api/expert-contracts?month=${encodeURIComponent(month.value)}`, activeBrand.id, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("manual_contracts_unavailable");
          const payload = await response.json() as { entries?: ManualContractEntry[] };
          return [month.value, Object.fromEntries([...aggregateManualContractEntries(payload.entries || []).entries()].map(([expert, entry]) => [expert, entry.contractCount]))] as const;
        }));
        let contracts = 0;
        let hasResolvedContracts = false;
        months.forEach((month, monthIndex) => {
          const manualResult = manualResponses[monthIndex];
          const manual = manualResult.status === "fulfilled" ? manualResult.value[1] : null;
          Object.entries(performance[month.value] || {}).forEach(([expert, item]) => {
            if (manual && Object.prototype.hasOwnProperty.call(manual, expert)) {
              contracts += manual[expert];
              hasResolvedContracts = true;
            } else {
              contracts += item.sheetContracts;
              hasResolvedContracts = true;
            }
          });
        });
        if (!controller.signal.aborted) setRangeComparison({
          total: rows.length,
          average: recordedDays ? Math.round(rows.length / recordedDays) : 0,
          recordedDays,
          contracts: hasResolvedContracts ? contracts : 0,
          startDate: previous.startDate,
          endDate: previous.endDate,
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setRangeComparison(null);
      }
    };
    void loadComparison();
    const unregister = manualRefresh.register("مقایسه بازه", async () => { if (activeViewRef.current === "dashboard") await loadComparison(); });
    return () => { unregister(); controller.abort(); };
  }, [activeBrand.id, brandRegistryReady, brandSourceReady, selectedEndDate, selectedStartDate, selectedDateReload, sheetMonthsReady]);

  // Historical edits, including late contract completion, refresh the visible range every thirty seconds.
  useEffect(() => {
    if (activeView !== "dashboard") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setSelectedDateReload(value => value + 1);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [activeView]);

  // One union request supplies both daily and selected-range financial metrics without changing either formula.
  useEffect(() => {
    if (!activeDateKey || !selectedDateData) return;
    const controller = new AbortController();
    const loadCosts = async () => {
      const previous = getPreviousEquivalentRange(selectedStartDate, selectedEndDate);
      const unionStart = [activeDateKey, selectedStartDate, previous.startDate].sort()[0];
      const unionEnd = [activeDateKey, selectedEndDate, previous.endDate].sort().at(-1) || selectedEndDate;
      try {
        const inputs = await fetchMarketingCostInputs(activeBrand.id, unionStart, unionEnd, controller.signal);
        if (controller.signal.aborted) return;
        setTodayCosts(buildMarketingCostSnapshot(inputs, activeDateKey, activeDateKey, canonicalChannelCounts(sourceCounts)));
        setRangeCosts(buildMarketingCostSnapshot(inputs, selectedStartDate, selectedEndDate, canonicalChannelCounts(selectedDateData.sourceCounts)));
        setPreviousRangeCosts(buildMarketingCostSnapshot(inputs, previous.startDate, previous.endDate, {}));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const failed: MarketingCostSnapshot = { costsByChannel: {}, dailyCosts: {}, adsCostTry: null, missingRateMonths: [], missingBudgetCells: [], missingContractorFees: [], staleAds: false, error: true, smsEstimatedSent: null, adsImpressions: null, awarenessTotal: null, awarenessIssues: ["داده‌های مرحله اول فانل دریافت نشد"] };
        setTodayCosts(failed);
        setRangeCosts(failed);
        setPreviousRangeCosts(failed);
      }
    };
    void loadCosts();
    const unregister = manualRefresh.register("محاسبات مالی", async () => { if (activeViewRef.current === "dashboard") await loadCosts(); }, 2);
    return () => { unregister(); controller.abort(); };
  }, [activeBrand.id, activeDateKey, costReload, selectedDateData, selectedDateReload, selectedEndDate, selectedStartDate, sourceCounts]);

  // Recalculate all visible financial metrics immediately after the budget workspace saves.
  useEffect(() => {
    const refreshCosts = () => setCostReload(value => value + 1);
    window.addEventListener("dashboard:budgets-saved", refreshCosts);
    return () => window.removeEventListener("dashboard:budgets-saved", refreshCosts);
  }, []);

  // A new date range starts unfiltered so an old channel selection never silently hides fresh data.
  /* eslint-disable react-hooks/set-state-in-effect -- resetting a dependent view filter is intentional */
  useEffect(() => setSelectedChannelFilter(null), [selectedEndDate, selectedStartDate]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load explicit monthly contract overrides for efficiency cards and health anomalies.
  useEffect(() => {
    const controller = new AbortController();
    const loadManualContracts = async () => {
      try {
        const response = await fetchForBrand(`/api/expert-contracts?month=${encodeURIComponent(selectedMonth)}`, activeBrand.id, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { entries?: ManualContractEntry[] };
        if (!response.ok) throw new Error("manual_contracts_unavailable");
        setManualContracts(Object.fromEntries([...aggregateManualContractEntries(payload.entries || []).entries()].map(([expert, entry]) => [expert, entry.contractCount])));
        setManualContractsError(false);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Preserve the last confirmed overrides during a transient D1 outage.
        setManualContractsError(true);
      }
    };
    void loadManualContracts();
    const unregister = manualRefresh.register("جمع قراردادها", async () => { if (activeViewRef.current === "dashboard") await loadManualContracts(); });
    return () => { unregister(); controller.abort(); };
  }, [activeBrand.id, monthlyContractReload, selectedMonth]);

  // Check the selected range inclusively through today; future dates and Fridays never create missing-cost warnings.
  useEffect(() => {
    const controller = new AbortController();
    const loadBudgetCompleteness = async () => {
      try {
        const end = selectedEndDate < today.sheetDate ? selectedEndDate : today.sheetDate;
        const start = selectedStartDate;
        const months = getRangeMonths(start, end);
        const response = await fetchForBrand(`/api/budgets?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`, activeBrand.id, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { entries?: BudgetEntry[]; monthlyCosts?: MonthlyChannelCost[] };
        if (!response.ok) throw new Error("budget status unavailable");
        const workdays = months.flatMap(month => getPersianMonthCalendar(month.value).days.map(day => `${month.value}/${String(day).padStart(2, "0")}`)).filter(date => getPersianWeekday(date) !== "جمعه");
        const missingDaily = findMissingDailyCosts({ dates: workdays, start, end, today: today.sheetDate, channels: activeDashboardRules.channels, entries: payload.entries || [] });
        const missingItems: string[] = [];
        months.forEach(month => {
          activeDashboardRules.channels.filter(channel => channel.enabled && channel.costMode === "monthly_budget").forEach(channel => {
            if (payload.monthlyCosts?.find(item => item.month === month.value && item.channelId === channel.id)?.mediaToman == null) missingItems.push(`${channel.name} · هزینه ماهانه ${formatMonth(month.value)}`);
          });
          activeDashboardRules.channels.filter(channel => channel.enabled && channel.contractorEnabled && (channel.costMode === "daily_budget" || channel.costMode === "monthly_budget" || channel.id === "google_ads")).forEach(channel => {
            if (payload.monthlyCosts?.find(item => item.month === month.value && item.channelId === channel.id)?.contractorToman == null) missingItems.push(`${channel.name} · دستمزد پیمانکار ${formatMonth(month.value)}`);
          });
        });
        if (!controller.signal.aborted) setBudgetReminder({ missingItems, missingDaily, start, end });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setBudgetReminder(null);
      }
    };
    const refreshAfterSave = () => void loadBudgetCompleteness();
    const unregister = manualRefresh.register("وضعیت هزینه‌ها", async () => { if (activeViewRef.current === "dashboard") await loadBudgetCompleteness(); }, 2);
    void loadBudgetCompleteness();
    window.addEventListener("dashboard:budgets-saved", refreshAfterSave);
    return () => {
      controller.abort();
      unregister();
      window.removeEventListener("dashboard:budgets-saved", refreshAfterSave);
    };
  }, [activeBrand.id, activeDashboardRules, activeView, selectedStartDate, selectedEndDate, selectedDateReload, today.sheetDate]);

  // Restore only a structurally valid last-known snapshot from browser cache.
  /* eslint-disable react-hooks/set-state-in-effect -- restoring an external persisted snapshot intentionally hydrates React state */
  useEffect(() => {
    if (!brandRegistryReady || !brandSourceReady) return;
    try {
      const cacheKey = dashboardCacheKey;
      const stored = window.localStorage.getItem(cacheKey);
      if (!stored) return;
      const cached = JSON.parse(stored) as CachedDashboard;
      if (!cached || !Number.isFinite(cached.savedAt)) return;
      const cachedSourceTotal = Object.values(cached.sourceCounts || {}).reduce((sum, count) => sum + count, 0);
      const cachedRouteTotal = Object.values(cached.routeCounts || {}).reduce((sum, count) => sum + count, 0);
      const cachedExpertTotal = Object.values(cached.expertMatrix || {}).reduce((sum, expert) => sum + expert.total, 0);
      // Delete cached data when any aggregate disagrees with its stored overall total.
      if ([cachedSourceTotal, cachedRouteTotal, cachedExpertTotal].some(total => total !== cached.todayTotal)) {
        window.setTimeout(() => setIntegrityIssue(`کش ناسازگار حذف شد: کل ${cached.todayTotal.toLocaleString("en-US")}، کانال‌ها ${cachedSourceTotal.toLocaleString("en-US")}، مسیرها ${cachedRouteTotal.toLocaleString("en-US")}، کارشناسان ${cachedExpertTotal.toLocaleString("en-US")}`), 0);
        window.localStorage.removeItem(cacheKey);
        return;
      }
      acceptedSnapshots.current[selectedMonth] = { signature: cached.signature, total: cached.total };
      setDashboardData({
        sheetRows: cached.sheetRows,
        todayTotal: cached.todayTotal,
        average: cached.average,
        change: cached.change,
        sourceCounts: cached.sourceCounts || {},
        previousSourceCounts: cached.previousSourceCounts || {},
        routeCounts: cached.routeCounts || {},
        expertMatrix: cached.expertMatrix || {},
        dataConflicts: cached.dataConflicts || [],
        dateIssueRows: cached.dateIssueRows || [],
        monthlyExpertPerformance: cached.monthlyExpertPerformance || {},
        channelContractCounts: cached.channelContractCounts || {},
        activeDateKey: cached.activeDateKey || "",
        health: cached.health || {
          monthTotal: cached.total || 0,
          channelTotal: cached.total || 0,
          routeTotal: cached.total || 0,
          expertTotal: cached.total || 0,
          unknownSources: cached.dataConflicts || [],
          dateIssueRows: cached.dateIssueRows || [],
          missingRouteRows: [],
          missingExpertRows: [],
        },
        activeDateLabel: cached.activeDateLabel || today.label,
        monthRecordTotal: cached.monthRecordTotal || 0,
        monthRecordDate: cached.monthRecordDate || "",
      });
      setHasUsableData(true);
    } catch {
      try { window.localStorage.removeItem(dashboardCacheKey); } catch { /* Storage disabled. */ }
    }
  }, [activeBrand.id, selectedMonth, today.label, dashboardCacheKey, brandRegistryReady, brandSourceReady]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Refresh on connectivity, focus, visibility, and a thirty-second polling cadence.
  useEffect(() => {
    const syncOnlineState = () => {
      if (navigator.onLine) void loadSheet();
      else updateSheetConnection({ status: "disconnected" });
    };
    const refreshOnFocus = () => void loadSheet();
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void loadSheet(); };
    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const sheetTimer = window.setInterval(() => { if (document.visibilityState === "visible" && activeViewRef.current !== "settings") void loadSheet(); }, 30000);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(sheetTimer);
    };
  }, [loadSheet]);

  const displayedGoogleAdsStatus = brandSourceReady ? googleAdsConnection.status : "blocked";
  const googleAdsStatusClass = displayedGoogleAdsStatus === "connected" ? "ok" : displayedGoogleAdsStatus === "pending" || displayedGoogleAdsStatus === "checking" ? "checking" : "error";
  const googleAdsCheckedAt = googleAdsConnection.checkedAt ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(googleAdsConnection.checkedAt)) : "—";
  const googleAdsFailureText: Record<string, string> = {
    google_ads_account_suspended: "حساب Google Ads تعلیق شده است",
    google_ads_account_canceled: "حساب Google Ads لغو شده است",
    google_ads_account_closed: "حساب Google Ads بسته شده است",
    google_ads_access_failed: "دسترسی Google Ads API تأیید نشد",
    google_ads_identity_failed: "هویت سرویس Google Ads نیازمند بررسی است",
    google_ads_rate_limited: "محدودیت موقت Google Ads API",
    google_ads_upstream_failed: "سرویس Google Ads موقتاً پاسخگو نیست",
    service_account_not_configured: "Service Account این دفتر هنوز کامل تنظیم نشده است",
  };
  const searchConsoleStatusClass = searchConsoleConnection.status === "connected" ? "ok" : searchConsoleConnection.status === "pending" || searchConsoleConnection.status === "checking" ? "checking" : "error";
  const searchConsoleCheckedAt = searchConsoleConnection.checkedAt ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(searchConsoleConnection.checkedAt)) : "—";
  const searchConsoleFailureText: Record<string, string> = {
    search_console_not_configured: "اتصال این دفتر هنوز تنظیم نشده است",
    search_console_access_failed: "ایمیل سرویس به Property دسترسی ندارد",
    search_console_identity_failed: "فایل حساب سرویس نیازمند بررسی است",
    search_console_unavailable: "سرویس Search Console پاسخگو نیست",
  };
  const viewingCurrentMonth = selectedMonth === currentMonth;
  const reportQualifier = mainDateOverride ? "روز انتخاب‌شده" : viewingCurrentMonth ? "امروز" : "آخرین روز کاری";
  const dailyInsight = (() => {
    const momentLabel = mainDateOverride ? "در روز انتخاب‌شده" : viewingCurrentMonth ? "امروز تا این لحظه" : "در آخرین روز کاری این ماه";
    // Rotate natural copy by report date, so refreshes stay stable while consecutive days do not sound repetitive.
    const chooseNarrative = (variants: string[], salt = 0) => {
      const daySeed = Number(activeDateKey.split("/").at(-1) || 0);
      return variants[(daySeed + salt) % variants.length];
    };
    const recordDateText = monthRecordDate ? ` در ${formatRecordedDayMonth(monthRecordDate)}` : "";
    if (!activeDateKey || todayTotal === 0) return { level: "neutral", text: `برای ${reportQualifier} هنوز ورودی معتبری ثبت نشده است.` };
    if (monthRecordTotal === 0) return { level: "positive", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شد؛ این اولین روز دارای دادهٔ ماه است و مبنای مقایسهٔ روزهای بعد خواهد بود.`,
      `برای شروع این ماه ${todayTotal.toLocaleString("en-US")} لید ثبت شده؛ عملکرد روزهای بعد با همین عدد مقایسه می‌شود.`,
      `اولین دادهٔ ثبت‌شدهٔ ماه ${todayTotal.toLocaleString("en-US")} ورودی است؛ روزهای بعد با همین مبنا سنجیده می‌شوند.`,
    ]) };
    if (todayTotal > monthRecordTotal) {
      const difference = todayTotal - monthRecordTotal;
      return { level: "record", text: chooseNarrative([
        `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شد؛ رکورد قبلی ماه ${monthRecordTotal.toLocaleString("en-US")} لید${recordDateText} بود و این روز بالاترین حجم ثبت‌شدهٔ ماه را دارد.`,
        `حجم ورودی این روز با ${todayTotal.toLocaleString("en-US")} لید، رکورد قبلی ${monthRecordTotal.toLocaleString("en-US")} لید${recordDateText} را پشت سر گذاشت و فعلاً بالاترین مقدار ماه است.`,
        `در این روز ${todayTotal.toLocaleString("en-US")} ورودی ثبت شد؛ این عدد ${difference.toLocaleString("en-US")} لید بیشتر از رکورد قبلی ماه است.`,
      ], 1) };
    }
    if (todayTotal === monthRecordTotal) return { level: "record", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شد؛ این عدد با رکورد فعلی ماه${recordDateText} برابر است و برای عبور از آن 1 لید دیگر لازم است.`,
      `حجم ورودی این روز ${todayTotal.toLocaleString("en-US")} لید است و با رکورد فعلی ماه${recordDateText} برابری می‌کند؛ لید بعدی رکورد را جابه‌جا می‌کند.`,
      `این روز با ${todayTotal.toLocaleString("en-US")} ورودی در سطح رکورد فعلی ماه قرار دارد؛ برای ثبت رکورد جدید 1 لید دیگر لازم است.`,
    ], 2) };
    const recordGap = Math.max(0, monthRecordTotal - todayTotal);
    if (recordGap === 1) return { level: "positive", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شده؛ 1 لید تا رسیدن به رکورد ماه و 2 لید تا ثبت رکورد جدید فاصله داریم.`,
      `این روز فقط 1 لید با رکورد ماه فاصله دارد؛ با لید دوم، رکورد جدید ثبت می‌شود.`,
      `حجم ثبت‌شده ${todayTotal.toLocaleString("en-US")} لید است؛ یک لید دیگر برای برابر شدن با رکورد و دو لید برای عبور از آن کافی است.`,
    ]) };
    if (recordGap <= 5) return { level: "positive", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شده؛ ${recordGap.toLocaleString("en-US")} لید تا برابری و ${(recordGap + 1).toLocaleString("en-US")} لید تا عبور از رکورد ماه فاصله است.`,
      `رکورد ماه در دسترس است؛ با ${recordGap.toLocaleString("en-US")} لید دیگر برابر می‌شویم و با ${(recordGap + 1).toLocaleString("en-US")} لید از آن عبور می‌کنیم.`,
      `${todayTotal.toLocaleString("en-US")} ورودی ثبت شده و این روز ${recordGap.toLocaleString("en-US")} لید با رکورد فعلی ماه فاصله دارد.`,
    ], 1) };
    if (change >= 20) return { level: "positive", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شد؛ این عدد ${change.toLocaleString("en-US")}% بیشتر از روز کاری قبل است.`,
      `تعداد ورودی‌ها به ${todayTotal.toLocaleString("en-US")} لید رسید؛ رشد نسبت به روز کاری قبل ${change.toLocaleString("en-US")}% است.`,
      `در این روز ${todayTotal.toLocaleString("en-US")} لید ثبت شده؛ حجم ورودی نسبت به روز کاری قبل ${change.toLocaleString("en-US")}% افزایش دارد.`,
    ]) };
    if (change >= 5) return { level: "positive", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شده؛ رشد ${change.toLocaleString("en-US")}% نسبت به روز کاری قبل داریم و ${recordGap.toLocaleString("en-US")} لید تا رکورد ماه فاصله مانده است.`,
      `در این روز ${todayTotal.toLocaleString("en-US")} لید ثبت شده؛ تعداد ورودی‌ها نسبت به روز کاری قبل ${change.toLocaleString("en-US")}% بیشتر است.`,
      `${todayTotal.toLocaleString("en-US")} ورودی در این روز ثبت شده؛ رشد نسبت به روز کاری قبل ${change.toLocaleString("en-US")}% است.`,
    ], 2) };
    if (change > -5) return { level: "neutral", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی داشتیم؛ روند نسبت به روز کاری قبل پایدار و نزدیک به میانگین ${average.toLocaleString("en-US")} لید ماه است.`,
      `تعداد ورودی‌ها تقریباً ثابت است؛ ${todayTotal.toLocaleString("en-US")} لید ثبت شده و نوسان نسبت به روز کاری قبل کمتر از 5% است.`,
      `در این روز ${todayTotal.toLocaleString("en-US")} ورودی ثبت شده؛ اختلاف روزانه در محدودهٔ پایدار است و تغییر قابل‌توجهی دیده نمی‌شود.`,
    ]) };
    if (change > -20) return { level: "warning", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی ثبت شده؛ افت ${Math.abs(change).toLocaleString("en-US")}% محدود است اما ترکیب کانال‌ها باید بررسی شود.`,
      `تعداد ورودی‌ها کمی پایین‌تر است؛ ${todayTotal.toLocaleString("en-US")} لید و افت ${Math.abs(change).toLocaleString("en-US")}% نسبت به روز کاری قبل ثبت شده است.`,
      `تعداد ورودی‌ها نسبت به روز کاری قبل ${Math.abs(change).toLocaleString("en-US")}% کاهش دارد؛ افت محدود است، اما سهم کانال‌ها باید بررسی شود.`,
    ], 1) };
    return { level: "warning", text: chooseNarrative([
      `${momentLabel} ${todayTotal.toLocaleString("en-US")} ورودی داشتیم؛ افت ${Math.abs(change).toLocaleString("en-US")}% معنادار است و سهم کانال‌ها و کامل‌بودن داده نیاز به کنترل فوری دارد.`,
      `تعداد ورودی‌ها کاهش یافته؛ ${todayTotal.toLocaleString("en-US")} لید یعنی ${Math.abs(change).toLocaleString("en-US")}% افت و لازم است کانال‌ها فوری بررسی شوند.`,
      `تعداد ورودی‌ها نسبت به الگوی معمول ${Math.abs(change).toLocaleString("en-US")}% کمتر است؛ عملکرد کانال‌ها و کامل‌بودن ثبت داده باید کنترل شود.`,
    ], 2) };
  })();
  const availableCalendarMonths = [...monthOptions].sort((a, b) => a.value.localeCompare(b.value));
  const calendarMonthIndex = availableCalendarMonths.findIndex(month => month.value === calendarMonth);
  /** Restores the range that was active immediately before a chart point narrowed the report. */
  const resetChartRange = () => {
    const previous = chartRangeBeforeClickRef.current;
    if (previous) {
      setSelectedStartDate(previous.startDate);
      setSelectedEndDate(previous.endDate);
      setSelectedMonth(previous.month);
      setMainDateOverride(previous.mainDateOverride);
    }
    setSelectedChannelFilter(null);
    setRangeAnchor(null);
    chartRangeBeforeClickRef.current = null;
  };
  /** Handles the two-click Persian date-range interaction and blocks future dates. */
  const chooseRangeDate = (day: number) => {
    const dateKey = `${calendarMonth}/${String(day).padStart(2, "0")}`;
    if (dateKey > today.sheetDate) return;
    chartRangeBeforeClickRef.current = null;
    if (!rangeAnchor) {
      setSelectedStartDate(dateKey);
      setSelectedEndDate(dateKey);
      setSelectedMonth(calendarMonth);
      setMainDateOverride(dateKey);
      setRangeAnchor(dateKey);
      return;
    }
    const startDate = rangeAnchor <= dateKey ? rangeAnchor : dateKey;
    const endDate = rangeAnchor <= dateKey ? dateKey : rangeAnchor;
    setSelectedStartDate(startDate);
    setSelectedEndDate(endDate);
    setSelectedMonth(endDate.slice(0, 7));
    // The main cards show the last explicitly selected day; the detailed section keeps the full range.
    setMainDateOverride(endDate);
    setRangeAnchor(null);
    setCalendarOpen(false);
  };
  const chooseMonth = (month: string) => {
    chartRangeBeforeClickRef.current = null;
    setSelectedMonth(month);
    setMainDateOverride(null);
  };

  // Build canonical channel cards and preserve unknown source values as separate anomaly cards.
  const standardChannels = channelDefs.map(def => {
    const value = Object.entries(sourceCounts).reduce((sum, [source, count]) => def.keys.some(key => normalizeSource(key) === normalizeSource(source)) ? sum + count : sum, 0);
    return { ...def, value, share: todayTotal ? Math.round((value / todayTotal) * 100) : 0 };
  });
  const recordedExtraChannels = dataConflicts.map(conflict => {
    const value = sourceCounts[conflict.source] || 0;
    return { name: conflict.source, keys: [conflict.source], color: "blue", icon: "•", value, share: todayTotal ? Math.round((value / todayTotal) * 100) : 0 };
  });
  const channels = [...standardChannels, ...recordedExtraChannels];
  const channelTotal = channels.reduce((sum, channel) => sum + channel.value, 0);
  const selectedStandardChannels = channelDefs.map(def => {
    const value = Object.entries(selectedDateData?.sourceCounts || {}).reduce((sum, [source, count]) => def.keys.some(key => normalizeSource(key) === normalizeSource(source)) ? sum + count : sum, 0);
    return { ...def, value, share: selectedDateData?.total ? Math.round((value / selectedDateData.total) * 100) : 0 };
  });
  const selectedExtraChannels = (selectedDateData?.conflicts || []).map(conflict => {
    const value = selectedDateData?.sourceCounts?.[conflict.source] || 0;
    return { name: conflict.source, keys: [conflict.source], color: "blue", icon: "•", value, share: selectedDateData?.total ? Math.round((value / selectedDateData.total) * 100) : 0 };
  });
  const selectedDateChannels = [...selectedStandardChannels, ...selectedExtraChannels].filter(channel => channel.value > 0);
  const selectedDateChannelTotal = selectedDateChannels.reduce((sum, channel) => sum + channel.value, 0);
  const todayCanonicalCounts = canonicalChannelCounts(sourceCounts);
  const rangeCanonicalCounts = canonicalChannelCounts(selectedDateData?.sourceCounts || {});
  const todayCostMetrics = buildChannelCostMetrics(todayCanonicalCounts, channelContractCounts, todayCosts);
  const rangeCostMetrics = buildChannelCostMetrics(rangeCanonicalCounts, selectedDateData?.channelContractCounts || {}, rangeCosts);
  const selectedFilterChannels = rangeFilterChannels(selectedChannelFilter);
  const selectedFilterLabel = selectedChannelFilter === primaryGoogleAdsChannel() ? `${primaryGoogleAdsChannel()} (تجمیعی)` : selectedChannelFilter;
  // WhatsApp and Site Form remain separate lead cards but roll into the single Google Ads daily KPI.
  const adsTodayLeads = googleAdsLeadChannels().reduce((sum, channel) => sum + (todayCanonicalCounts[channel] || 0), 0);
  const adsTodayContracts = googleAdsLeadChannels().reduce((sum, channel) => sum + (channelContractCounts[channel] || 0), 0);
  const knownAdsTodayCosts = googleAdsLeadChannels()
    .map(channel => todayCostMetrics[channel]?.costToman ?? null)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const adsTodayCost = knownAdsTodayCosts.length ? knownAdsTodayCosts.reduce((sum, value) => sum + value, 0) : null;
  const adsTodayMetric: ChannelCostMetric = {
    costToman: adsTodayCost,
    leads: adsTodayLeads,
    contracts: adsTodayContracts,
    cpl: adsTodayCost !== null && adsTodayLeads > 0 ? adsTodayCost / adsTodayLeads : null,
    cac: adsTodayCost !== null && adsTodayContracts > 0 ? adsTodayCost / adsTodayContracts : null,
  };
  const selectedFilteredTotal = selectedChannelFilter
    ? selectedFilterChannels.reduce((sum, channel) => sum + (rangeCanonicalCounts[channel] || 0), 0)
    : selectedDateData?.total || 0;
  // Filter the complete selected-range report from the same channel-specific source matrix.
  const filteredRouteCounts = selectedChannelFilter
    ? Object.values(selectedDateData?.expertMatrix || {}).reduce<Record<string, number>>((totals, expert) => {
      Object.entries(expert.routeChannels || {}).forEach(([route, channels]) => {
        totals[route] = (totals[route] || 0) + selectedFilterChannels.reduce((sum, channel) => sum + (channels[channel] || 0), 0);
      });
      return totals;
    }, {})
    : selectedDateData?.routeCounts || {};
  // Sort selected-range routes from highest to lowest without a generic "other" bucket.
  const selectedDateRoutes = Object.entries(filteredRouteCounts)
    .map(([name, value]) => ({ name, value }))
    .filter(route => route.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "fa"));
  const selectedDateRouteTotal = selectedDateRoutes.reduce((sum, route) => sum + route.value, 0);
  const selectedDateRouteMax = Math.max(1, ...selectedDateRoutes.map(route => route.value));
  const topContractRoutes = rankContractRoutes(
    selectedDateData?.expertContractRouteChannels || {},
    selectedChannelFilter ? selectedFilterChannels : [],
  );
  const topContractRouteMax = Math.max(1, ...topContractRoutes.map(route => route.count));
  const summaryLeadChannels = selectedDateChannels.filter(channel => !selectedChannelFilter || selectedFilterChannels.includes(channel.name));
  const summaryContractChips = topContractRoutes.flatMap(route => route.channels
    .filter(channel => channel.count > 0)
    .map(channel => ({ route: route.name, channel: channel.name, count: channel.count })))
    .slice(0, 12);
  // Convert daily counts to responsive SVG coordinates for the selected-range trend line.
  const selectedDailyCounts = (selectedDateData?.dailyCounts || []).map(day => selectedChannelFilter ? ({
    ...day,
    value: selectedFilterChannels.reduce((sum, channel) => sum + (selectedDateData?.dailyChannelCounts?.[day.date]?.[channel] || 0), 0),
    contracts: selectedFilterChannels.reduce((sum, channel) => sum + (selectedDateData?.dailyChannelContracts?.[day.date]?.[channel] || 0), 0),
  }) : day);
  const selectedFilteredRecordedDays = selectedDailyCounts.filter(day => day.value > 0).length;
  const selectedFilteredAverage = selectedFilteredRecordedDays ? Math.round(selectedFilteredTotal / selectedFilteredRecordedDays) : 0;
  const selectedFilteredContracts = selectedChannelFilter
    ? selectedFilterChannels.reduce((sum, channel) => sum + (selectedDateData?.channelContractCounts[channel] || 0), 0)
    : selectedDateData?.resolvedContractTotal ?? null;
  // Every aggregate financial numerator and denominator must cover the exact same channel set.
  const candidateCostChannels = selectedChannelFilter ? selectedFilterChannels : Object.keys(rangeCosts?.costsByChannel || {});
  const coveredRangeChannels = candidateCostChannels.filter(channel => {
    const cost = rangeCosts?.costsByChannel[channel];
    return typeof cost === "number" && Number.isFinite(cost);
  });
  const selectedCostCoveredLeads = coveredRangeChannels.reduce((sum, channel) => sum + (rangeCanonicalCounts[channel] || 0), 0);
  const selectedAttributableContracts = coveredRangeChannels.reduce((sum, channel) => sum + (selectedDateData?.channelContractCounts[channel] || 0), 0);
  const rangeCostValues = candidateCostChannels.map(channel => rangeCosts?.costsByChannel[channel] ?? null);
  const knownRangeCostValues = rangeCostValues.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const rangeCostCoverageIncomplete = rangeCostValues.some(value => value === null) || Boolean(rangeCosts?.missingBudgetCells.length || rangeCosts?.missingRateMonths.length || rangeCosts?.missingContractorFees.length);
  // Always calculate from every persisted cost currently available; never discard valid spend because another source is missing.
  const selectedRangeCost = rangeCosts && !rangeCosts.error && knownRangeCostValues.length > 0
    ? knownRangeCostValues.reduce((sum, value) => sum + value, 0)
    : null;
  const selectedRangeCpl = selectedRangeCost !== null && selectedCostCoveredLeads > 0 ? selectedRangeCost / selectedCostCoveredLeads : null;
  const selectedRangeCac = selectedRangeCost !== null && selectedAttributableContracts > 0 ? selectedRangeCost / selectedAttributableContracts : null;
  const rangeBudgetChannels = aggregateDisplayCosts(
    Object.fromEntries(Object.entries(rangeCosts?.costsByChannel || {}).filter(([channel]) => !NON_COST_CHANNELS.has(channel))),
    googleAdsLeadChannels(),
    primaryGoogleAdsChannel(),
  );
  // Brand-wide cards never change with a channel filter and never present partial spend as a complete CPL/CAC.
  const overallPaidChannels = Object.keys(rangeCosts?.costsByChannel || {}).filter(channel => !NON_COST_CHANNELS.has(channel));
  const overallCostValues = overallPaidChannels.map(channel => rangeCosts?.costsByChannel[channel] ?? null);
  const overallCoverageIncomplete = Boolean(
    !rangeCosts
    || rangeCosts.error
    || overallCostValues.some(value => value === null)
    || rangeCosts.missingBudgetCells.length
    || rangeCosts.missingRateMonths.length
    || rangeCosts.missingContractorFees.length,
  );
  const overallRangeMetric = calculateOverallRangeMetric({
    paidChannels: overallPaidChannels,
    costsByChannel: rangeCosts?.costsByChannel || {},
    leadsByChannel: rangeCanonicalCounts,
    contractsByChannel: selectedDateData?.channelContractCounts || {},
    totalContracts: selectedDateData?.resolvedContractTotal ?? null,
    coverageIncomplete: overallCoverageIncomplete,
  });
  // Build the narrative from every currently available lead and cost, without waiting for delayed contract entry.
  const rangeInsightFinancials: RangeInsightFinancials = {
    totalCost: selectedRangeCost,
    totalCpl: selectedRangeCpl,
    totalCac: selectedRangeCac,
    coverageIncomplete: rangeCostCoverageIncomplete,
    channels: buildFinancialChannels(runtimeRules.channels, rangeCanonicalCounts, selectedDateData?.channelContractCounts || {}, rangeCosts?.costsByChannel || {}),
  };
  const todayExpertCostAudit = auditExpertCostAllocation(`آمار امروز (${today.sheetDate})`, expertMatrix, todayCanonicalCounts, todayCosts);
  const rangeExpertCostAudit = auditExpertCostAllocation(selectedDateData?.label ? `بازه ${selectedDateData.label}` : "بازه انتخابی", selectedDateData?.expertMatrix || {}, rangeCanonicalCounts, rangeCosts);
  const expertCostAuditRows = [...todayExpertCostAudit, ...rangeExpertCostAudit];
  const expertCostAllocationMismatch = expertCostAuditRows.some(row => !row.balanced);
  const expertCostAuditIssues = expertCostAuditRows.filter(row => !row.balanced).map(row => ({ row, detail: buildExpertAllocationDiagnostic(row) }));
  const rangeInsight = selectedDateData ? buildRangeInsight(selectedDateData, rangeComparison, rangeInsightFinancials) : null;
  const rangeCoverageReasons = [
    ...(rangeCosts?.sourceIssues || []),
    rangeCosts?.error ? "دریافت اطلاعات مالی بازه ناموفق بود؛ این خطای دریافت است و به‌تنهایی به معنی ثبت‌نشدن هزینه نیست. اتصال منابع هزینه را در تنظیمات بررسی کنید و بروزرسانی دستی را بزنید؛ داده‌های تماس و قرارداد محفوظ‌اند." : "",
    !budgetReminder && rangeCosts?.missingBudgetCells.length ? `هزینه‌های ثبت‌نشدهٔ بازه: ${rangeCosts.missingBudgetCells.join("، ")}.` : "",
    rangeCosts?.missingRateMonths.length ? `نرخ ثابت TRY برای ${rangeCosts.missingRateMonths.map(formatMonth).join("، ")} ثبت نشده است.` : "",
    rangeCosts?.missingContractorFees.length ? `دستمزد پیمانکار برای ${rangeCosts.missingContractorFees.join("، ")} ثبت نشده است؛ عدد 0 نیز تأیید معتبر محسوب می‌شود.` : "",
    selectedDateData?.contractAttributionGap ? `${selectedDateData.contractAttributionGap.toLocaleString("en-US")} قرارداد قدیمی کانال قابل‌تأیید ندارد و وارد CAC نشده است.` : "",
    selectedDateData?.manualContractsUnavailable ? "ذخیره‌سازی قراردادهای دستی در این دریافت قابل بررسی نبود." : "",
  ];
  const unifiedFinancialReasons = [...new Set([
    ...(budgetReminder?.missingItems || []).map(item => `بودجه ثبت نشده: ${item}`),
    ...rangeCoverageReasons,
  ].filter(Boolean))];
  const missingDailyCosts = budgetReminder?.missingDaily || [];
  const financialIssueCount = unifiedFinancialReasons.length + expertCostAuditIssues.length + missingDailyCosts.length;
  const financialStatusCritical = Boolean(todayCosts?.error || rangeCosts?.error);
  const selectedTrendMonth = formatMonth(selectedStartDate.slice(0, 7));
  const selectedTrendTitle = selectedStartDate.slice(0, 7) === currentMonth
    ? `روند تماس‌های روزانه ماه جاری (${selectedTrendMonth})`
    : `روند تماس‌های روزانه ${selectedTrendMonth}`;
  const selectedEfficiencyLabel = selectedStartDate.endsWith("/01") && selectedStartDate.slice(0, 7) === selectedEndDate.slice(0, 7)
    ? "نرخ تبدیل ماه"
    : "نرخ تبدیل بازه";
  // Always rank expert cards by total answered calls, then by Persian name for stable ties.
  const selectedDateExperts: Array<{ name: string } & ExpertMatrix[string]> = Object.entries(selectedDateData?.expertMatrix || {})
    .map(([name, data]) => {
      if (!selectedChannelFilter) return { name, ...data };
      const total = selectedFilterChannels.reduce((sum, channel) => sum + (data.channels[channel] || 0), 0);
      const routes: Record<string, number> = Object.fromEntries(Object.entries(data.routeChannels || {})
        .map(([route, channelMap]) => [route, selectedFilterChannels.reduce((sum, channel) => sum + (channelMap[channel] || 0), 0)])
        .filter(([, value]) => Number(value) > 0));
      const filteredChannels: Record<string, number> = Object.fromEntries(selectedFilterChannels.map(channel => [channel, data.channels[channel] || 0]).filter(([, value]) => Number(value) > 0));
      const routeChannels: Record<string, Record<string, number>> = Object.fromEntries(Object.keys(routes).map(route => [route, Object.fromEntries(selectedFilterChannels.map(channel => [channel, data.routeChannels?.[route]?.[channel] || 0]).filter(([, value]) => Number(value) > 0))]));
      return { name, ...data, total, channels: filteredChannels, routes, routeChannels };
    })
    .filter(expert => expert.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "fa"));
  const selectedDateExpertTotal = selectedDateExperts.reduce((sum, expert) => sum + expert.total, 0);
  // Rank only experts with confirmed contracts: more contracts wins, then the higher conversion rate.
  // Call volume is intentionally never a positive tie-breaker because fewer calls for the same result is more efficient.
  const getRangeExpertEfficiency = (expertName: string, calls: number) => {
    if (!selectedChannelFilter) return selectedDateData?.expertEfficiency?.[expertName];
    const contracts = selectedFilterChannels.reduce((sum, channel) => sum + (selectedDateData?.expertChannelContracts?.[expertName]?.[channel] || 0), 0);
    return { contracts, percentage: calls > 0 ? contracts / calls * 100 : 0, source: `قراردادهای قابل انتساب به ${selectedFilterLabel}`, anomaly: contracts > calls };
  };
  const topRangeExperts = selectedDateExperts
    .filter(expert => expert.name !== "کارشناس ثبت نشده")
    .map(expert => ({ ...expert, efficiency: getRangeExpertEfficiency(expert.name, expert.total) }))
    .filter(expert => expert.efficiency?.contracts !== null && (expert.efficiency?.contracts || 0) > 0)
    .sort((a, b) => (b.efficiency!.contracts! - a.efficiency!.contracts!)
      || ((b.efficiency!.percentage || 0) - (a.efficiency!.percentage || 0))
      || a.name.localeCompare(b.name, "fa"))
    .slice(0, 3);
  // The range charts always receive the complete range matrix. A chart chip only changes
  // presentation opacity/aggregation, so selecting a second channel never destroys the
  // other series or makes the next selection impossible.
  const rangeAnalyticsChannels = selectedDateChannels.map(channel => ({ name: channel.name, color: channel.color, keys: channel.keys }));
  const rangeAnalyticsExperts = Object.entries(selectedDateData?.expertMatrix || {}).map(([name, expert]) => {
    const channelContracts = selectedDateData?.expertChannelContracts?.[name] || {};
    const contracts = Object.values(channelContracts).reduce((sum, value) => sum + value, 0);
    return { name, calls: expert.total, contracts, conversion: expert.total > 0 ? contracts / expert.total * 100 : null, channelCalls: expert.channels, channelContracts };
  });
  const routeChannelCalls: Record<string, Record<string, number>> = {};
  const routeChannelContracts: Record<string, Record<string, number>> = {};
  Object.values(selectedDateData?.expertMatrix || {}).forEach(expert => {
    Object.entries(expert.routeChannels || {}).forEach(([route, channelMap]) => {
      routeChannelCalls[route] ||= {};
      Object.entries(channelMap).forEach(([channel, count]) => { routeChannelCalls[route][channel] = (routeChannelCalls[route][channel] || 0) + count; });
    });
  });
  Object.values(selectedDateData?.expertContractRouteChannels || {}).forEach(routesByExpert => {
    Object.entries(routesByExpert).forEach(([route, channelMap]) => {
      routeChannelContracts[route] ||= {};
      Object.entries(channelMap).forEach(([channel, count]) => { routeChannelContracts[route][channel] = (routeChannelContracts[route][channel] || 0) + count; });
    });
  });
  const rangeAnalyticsRoutes = Object.keys(routeChannelCalls).map(name => ({
    name,
    calls: Object.values(routeChannelCalls[name]).reduce((sum, value) => sum + value, 0),
    contracts: Object.values(routeChannelContracts[name] || {}).reduce((sum, value) => sum + value, 0),
    channelCalls: routeChannelCalls[name],
    channelContracts: routeChannelContracts[name] || {},
  })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name, "fa"));
  const previousOnlySources = Object.keys(previousSourceCounts).filter(source =>
    !channels.some(channel => channel.keys.some(key => normalizeSource(key) === normalizeSource(source)))
  );
  // Keep channels that existed only on the previous workday visible in comparisons.
  const comparisonChannels = [
    ...channels.map(channel => ({
      name: channel.name,
      color: channel.color,
      today: channel.value,
      previous: Object.entries(previousSourceCounts).reduce((sum, [source, count]) =>
        channel.keys.some(key => normalizeSource(key) === normalizeSource(source)) ? sum + count : sum, 0),
    })),
    ...previousOnlySources.map(source => ({ name: source, color: "warning", today: 0, previous: previousSourceCounts[source] || 0 })),
  ].filter(channel => channel.today > 0 || channel.previous > 0);
  const comparisonMax = Math.max(1, ...comparisonChannels.flatMap(channel => [channel.today, channel.previous]));
  // Prepare the daily route chart and reconciliation total.
  const routes = Object.entries(routeCounts)
    .map(([name, value]) => ({ name, value }))
    .filter(route => route.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "fa"));
  const routeMax = Math.max(1, ...routes.map(route => route.value));
  const routeTotal = Object.values(routeCounts).reduce((sum, count) => sum + count, 0);
  // Prepare daily expert cards using the same descending ranking rule as the range report.
  const experts = Object.entries(expertMatrix)
    .map(([name, data]) => ({ name, ...data }))
    .filter(expert => expert.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "fa"));
  const expertTotal = experts.reduce((sum, expert) => sum + expert.total, 0);
  // Daily efficiency intentionally uses only exact "قرارداد شد" outcomes from the same report day.
  const resolveDailyExpertEfficiency = (expert: ExpertMatrix[string]) => {
    const contracts = expert.sheetContracts || 0;
    const percentage = expert.total > 0 ? contracts / expert.total * 100 : 0;
    return {
      calls: expert.total,
      contracts,
      percentage,
      source: "نتیجه «قرارداد شد» همان روز در Google Sheets",
      anomaly: contracts > expert.total,
    };
  };
  const getDailyExpertCost = (expert: ExpertMatrix[string]) => buildExpertCostMetric(expert.channels, todayCanonicalCounts, expert.channelContracts || {}, todayCosts);
  const getRangeExpertCost = (expert: ExpertMatrix[string] & { name: string }) => buildExpertCostMetric(expert.channels, rangeCanonicalCounts, selectedDateData?.expertChannelContracts?.[expert.name] || {}, rangeCosts);
  // Merge structural Sheet diagnostics with manual-contract anomalies for one compact health center.
  const manualContractAnomalies = Object.entries(manualContracts)
    .map(([expert, contracts]) => ({ expert, contracts, calls: monthlyExpertPerformance[expert]?.calls || 0 }))
    .filter(item => item.contracts > item.calls);
  const invariantMismatch = [health.channelTotal, health.routeTotal, health.expertTotal].some(total => total !== health.monthTotal);
  const healthIssueCount = (invariantMismatch ? 1 : 0) + health.dateIssueRows.length +
    health.missingRouteRows.length + health.missingExpertRows.length + manualContractAnomalies.length + (manualContractsError ? 1 : 0);
  const healthLevel = invariantMismatch || manualContractAnomalies.length || manualContractsError ? "critical" : healthIssueCount ? "warning" : "healthy";
  // Render one shared header plus either the live dashboard or the budget-entry workspace.
  return (
    <main className={`dashboard ${darkMode ? "dark" : "light"} ${sideMenuOpen ? "sidebarOpen" : "sidebarCollapsed"} ${mobileMenuOpen ? "mobileMenuOpen" : ""}`} dir="rtl">
      <div className="ambient one"/><div className="ambient two"/>
      <button className="mobileMenuTrigger" type="button" onClick={() => { setSideMenuOpen(true); setMobileMenuOpen(true); }} aria-label="باز کردن منوی داشبورد" aria-expanded={mobileMenuOpen}><NavigationIcon name="menu"/></button>
      {/* Desktop keeps the compact navigation visible; mobile turns it into an on-demand drawer. */}
      <button className={`menuScrim ${mobileMenuOpen ? "open" : ""}`} type="button" onClick={() => { setMobileMenuOpen(false); setSideMenuOpen(false); }} aria-label="بستن منوی کناری" tabIndex={mobileMenuOpen ? 0 : -1}/>
      <aside className={`sideMenu glass ${sideMenuOpen ? "open" : "collapsed"}`} aria-label="منوی اصلی">
        <div className="sideMenuHead"><div><strong>{activeBrand.shortName}</strong><span>مدیریت بازاریابی</span></div><button type="button" onClick={() => { if (mobileMenuOpen) { setMobileMenuOpen(false); setSideMenuOpen(false); } else setSideMenuOpen(value => !value); }} aria-label={mobileMenuOpen ? "بستن منوی کناری" : sideMenuOpen ? "کوچک کردن سایدبار" : "باز کردن سایدبار"} aria-expanded={mobileMenuOpen || sideMenuOpen}>{mobileMenuOpen ? "×" : sideMenuOpen ? "‹" : "›"}</button></div>
        <nav>
          <button className={activeView === "dashboard" ? "active" : ""} type="button" onClick={() => { setActiveView("dashboard"); setMobileMenuOpen(false); }} title="داشبورد اصلی"><i><NavigationIcon name="dashboard"/></i><span><strong>داشبورد اصلی</strong><small>آمار تماس‌ها و کارشناسان</small></span></button>
          <button className={activeView === "google-ads" ? "active" : ""} type="button" onClick={() => { setActiveView("google-ads"); setMobileMenuOpen(false); }} title="گزارش Google Ads"><i><NavigationIcon name="ads"/></i><span><strong>گزارش Google Ads</strong><small>هزینه، کلیک، لید و کمپین</small></span></button>
          <button className={activeView === "search-console" ? "active" : ""} type="button" onClick={() => { setActiveView("search-console"); setMobileMenuOpen(false); }} title="گزارش Search Console"><i><NavigationIcon name="search"/></i><span><strong>Search Console</strong><small>جست‌وجوی ارگانیک و SEO</small></span></button>
          <button className={activeView === "contracts" ? "active" : ""} type="button" onClick={() => { setActiveView("contracts"); setMobileMenuOpen(false); }} title="قرارداد کارشناسان"><i><NavigationIcon name="contracts"/></i><span><strong>قرارداد کارشناسان</strong><small>ورودی ماهانه و نرخ تبدیل</small></span></button>
          <button className={activeView === "phone-extraction" ? "active" : ""} type="button" onClick={() => { setActiveView("phone-extraction"); setMobileMenuOpen(false); }} title="استخراج شماره"><i><NavigationIcon name="phone"/></i><span><strong>استخراج شماره</strong><small>فیلتر و خروجی کامل تماس‌ها</small></span></button>
          <button className={activeView === "budgets" ? "active" : ""} type="button" onClick={() => { setActiveView("budgets"); setMobileMenuOpen(false); }} title="ثبت بودجه تبلیغات"><i><NavigationIcon name="budget"/></i><span><strong>ثبت بودجه تبلیغات</strong><small>بودجهٔ روزانهٔ کل ماه</small></span></button>
          <button className={activeView === "settings" ? "active" : ""} type="button" onClick={() => { setActiveView("settings"); setMobileMenuOpen(false); }} title="تنظیمات"><i><NavigationIcon name="settings"/></i><span><strong>تنظیمات</strong><small>برندها و منابع داده</small></span></button>
        </nav>
        <p>بودجه و قراردادهای دستی داخل خود داشبورد ذخیره می‌شوند.</p>
      </aside>
      <div className="dashboardWrap">
        {/* Shared identity, Tehran time, connection health, refresh, month, and theme controls. */}
        <header className="topbar glass">
          <div className="officeMark"><span className="logoFrame"><Image src={activeBrand.logoUrl || "/assets/donyagardi-logo-transparent.png"} alt={`لوگوی ${activeBrand.name}`} width={58} height={58} unoptimized/></span><div><strong>{activeBrand.name}</strong><small>داشبورد مدیریت بازاریابی<span lang="en">Marketing Manager Dashboard</span></small></div></div>
          <div className="pageTitle"><h1 lang="en" dir="ltr">Marketing Manager Dashboard</h1><TehranClock label={today.label}/></div>
          <div className="leftTools">
            <div className="syncControls">
              <button className="refreshButton" onClick={() => void handleManualRefresh()} disabled={isRefreshing} aria-label="بروزرسانی دستی اطلاعات و وضعیت اتصال‌ها">{isRefreshing ? "در حال دریافت…" : <><span className="refreshIcon" aria-hidden="true">↻</span> بروزرسانی دستی</>}</button>
              <small className="manualRefreshFeedback" role="status" aria-live="polite">{manualRefreshMessage}</small>
              <label className="brandPicker"><span>انتخاب برند</span><span className="selectWrap"><select value={activeBrand.id} onChange={event => void selectBrand(event.target.value)} aria-label="انتخاب برند داشبورد">{brands.map(brand => <option value={brand.id} disabled={brand.configStatus !== "active"} key={brand.id}>{brand.shortName}{brand.configStatus === "active" ? "" : " · نیازمند تکمیل"}</option>)}</select><i aria-hidden="true"/></span></label>
              <label className="monthPicker"><span>انتخاب ماه</span><span className="selectWrap"><select value={selectedMonth} onChange={event => chooseMonth(event.target.value)} aria-label="انتخاب ماه گزارش">{monthOptions.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select><i aria-hidden="true"/></span></label>
            </div>
            <button className="themeButton" onClick={() => setDarkMode(v => !v)} aria-label={darkMode ? "فعال کردن حالت روشن" : "فعال کردن حالت تیره"} title={darkMode ? "حالت روشن" : "حالت تیره"}>{darkMode ? "☀" : "☾"}</button>
            <LogoutButton />
          </div>
        </header>
        <ConnectionStatusRail telegramVisible={initialTelegramVisible} activeBrandId={activeBrand.id} sheetRows={brandSourceReady && sheetMonthsReady ? sheetRows : 0} hasUsableData={brandSourceReady && sheetMonthsReady && hasUsableData} sheetBlockedMessage={brandIsolationMessage || (!sheetMonthsReady ? sheetRegistryError : "")} googleAdsStatusClass={googleAdsStatusClass} googleAdsConnection={googleAdsConnection} googleAdsStatus={displayedGoogleAdsStatus} googleAdsCheckedAt={googleAdsCheckedAt} googleAdsFailureText={googleAdsFailureText} searchConsoleStatusClass={searchConsoleStatusClass} searchConsoleConnection={searchConsoleConnection} searchConsoleCheckedAt={searchConsoleCheckedAt} searchConsoleFailureText={searchConsoleFailureText} isRefreshing={isRefreshing}/>

        {activeView !== "settings" && activeView !== "search-console" && (sheetDataError || (sheetMonthsReady && sheetRegistryError)) && <section className="brandDataGuard glass" role="status"><div className="brandDataGuardTitle"><i>!</i><div><strong>بروزرسانی اطلاعات «{activeBrand.name}» کامل نشد</strong><span>{sheetDataError || sheetRegistryError}</span></div></div></section>}

        {activeView !== "settings" && activeView !== "search-console" && (!brandSourceReady || (activeView !== "phone-extraction" && !sheetMonthsReady && Boolean(sheetRegistryError)) || (activeView === "dashboard" && !hasUsableData && !selectedDateData && Boolean(sheetDataError))) ? <section className="brandDataGuard glass" role="alert" aria-live="assertive">
          {brandIsolationMessage && <div className="brandDataGuardTitle"><i>!</i><div><strong>نمایش داده برای جلوگیری از تداخل متوقف شد</strong><span>{brandIsolationMessage}</span></div></div>}
          {brandSourceReady && sheetRegistryError && <div className="brandDataGuardTitle"><i>!</i><div><strong>فهرست ماه‌های این برند دریافت نشد</strong><span>{sheetRegistryError}؛ دوباره «بروزرسانی دستی» را بزنید یا اتصال را در تنظیمات آزمایش کنید.</span></div></div>}
          <div className="brandDataGuardZeros" aria-label="تمام شاخص‌ها تا تأیید منبع صفر هستند"><span>تماس امروز <b>0</b></span><span>لید بازه <b>0</b></span><span>قرارداد <b>0</b></span><span>هزینه <b>0</b></span></div>
          <button type="button" onClick={() => setActiveView("settings")}>رفتن به تنظیمات و تأیید منبع</button>
        </section> : activeView === "dashboard" ? <>
        {googleAdsConnection.accountAlert && <section className="googleAdsAccountCritical glass" role="alert" aria-live="assertive"><i aria-hidden="true">!</i><div><strong>{googleAdsConnection.accountAlert.title}</strong><span>{googleAdsConnection.accountAlert.detail}</span>{googleAdsConnection.accountAlert.entityName && <small>حساب: {googleAdsConnection.accountAlert.entityName}</small>}</div><button type="button" onClick={() => setActiveView("google-ads")}>مشاهدهٔ هشدارهای Google Ads</button></section>}
        {sheetRegistryError && sheetMonthsReady && <div className="dataWarning" role="status"><strong>⚠ اتصال Google Sheets با نسخه ذخیره‌شده ادامه دارد</strong><span>{sheetRegistryError}</span></div>}
        {budgetReminder && (financialStatusCritical || financialIssueCount > 0 || missingDailyCosts.length > 0) && <details className={`financialStatus glass ${financialStatusCritical ? "critical" : "incomplete"}`}>
          <summary><i/><div><strong>وضعیت جامع بودجه، هزینه و قرارداد</strong><span>{missingDailyCosts.length ? `${missingDailyCosts.length.toLocaleString("en-US")} مبلغ روزانه تا پایان قابل بررسیِ بازه ثبت نشده؛ برای دیدن تاریخ و کانال باز کنید` : financialStatusCritical ? "دریافت بخشی از هزینه‌ها ناموفق است؛ وضعیت ثبت هزینه از این خطا مشخص نمی‌شود" : financialIssueCount ? `${financialIssueCount.toLocaleString("en-US")} مورد نیازمند اصلاح` : "بودجه، هزینه و قراردادهای قابل بررسی تکمیل است"}</span></div><b>{missingDailyCosts.length ? "هزینه ثبت نشده" : financialStatusCritical ? "اختلال دریافت" : financialIssueCount ? "نیازمند اصلاح" : "کامل"}</b><em>⌄</em></summary>
          <div className="financialStatusBody">
            <MissingDailyCostNotice items={missingDailyCosts} start={budgetReminder.start} end={budgetReminder.end}/>
            {unifiedFinancialReasons.map(reason => <p key={reason}>{reason}</p>)}
            {!financialIssueCount && <p>تمام مبالغ لازم تا امروز ثبت شده‌اند؛ عدد 0 نیز مقدار کامل و معتبر محسوب می‌شود.</p>}
            {expertCostAuditIssues.map(({ row, detail }) => <article className="financialAuditIssue" key={`${row.scope}-${row.channel}`}><header><strong>{detail.title}</strong><span>اختلاف تخصیص هزینه</span></header><div><span>هزینه کانال <b>{formatToman(row.channelCost)}</b></span><span>منتسب به کارشناسان <b>{formatToman(row.allocatedCost)}</b></span><span>اختلاف <b>{detail.difference === 0 ? "0 تومان" : `${formatToman(Math.abs(detail.difference))} ${detail.difference > 0 ? "بیشتر" : "کمتر"}`}</b></span><span>لید کانال / کارشناسان <b>{row.channelLeads.toLocaleString("en-US")} / {row.expertLeads.toLocaleString("en-US")}</b></span></div><p><b>علت قابل مشاهده:</b> {detail.diagnosis}</p><p><b>راه‌حل دائمی:</b> {detail.resolution}</p></article>)}
            {expertCostAuditRows.length > 0 && !expertCostAllocationMismatch && <p><b>کنترل تخصیص هزینه کارشناسان:</b> مجموع هزینهٔ منتسب در تمام کانال‌های هزینه‌دار دقیقاً با هزینهٔ همان کانال برابر است.</p>}
            {(missingDailyCosts.length > 0 || unifiedFinancialReasons.some(reason => reason.includes("بودجه") || reason.includes("نرخ ثابت") || reason.includes("دستمزد پیمانکار"))) && <button type="button" onClick={() => setActiveView("budgets")}>تکمیل بودجه و هزینه</button>}
          </div>
        </details>}
        {/* Month-wide data-health center keeps every reconciliation and row-level anomaly visible. */}
        {healthLevel !== "healthy" && <details className={`dataHealth glass ${healthLevel}`} aria-label={`سلامت داده ${formatMonth(selectedMonth)}`}>
          <summary className="dataHealthSummary"><span className="dataHealthPulse"><i/></span><div><strong>سلامت دادهٔ {formatMonth(selectedMonth)}</strong><small>{healthLevel === "healthy" ? "همهٔ محاسبات منطبق هستند" : healthLevel === "critical" ? `${healthIssueCount.toLocaleString("en-US")} اختلال نیازمند بررسی فوری` : `${healthIssueCount.toLocaleString("en-US")} مورد نیازمند اصلاح Google Sheets`}</small></div><span className="healthLegend" tabIndex={0} aria-label="راهنمای رنگ سلامت داده">?<em><b>سبز:</b> داده سالم و منطبق<br/><b>زرد:</b> نیازمند اصلاح Google Sheets<br/><b>قرمز:</b> اختلال فوری یا آنومالی جدی</em></span><b>{health.monthTotal.toLocaleString("en-US")} رکورد معتبر</b><i className="healthChevron" aria-hidden="true">⌄</i></summary>
          <div className="dataHealthBody"><div className="dataHealthTotals">
            <span className={health.channelTotal === health.monthTotal ? "ok" : "bad"}>کانال‌ها <b>{health.channelTotal.toLocaleString("en-US")}</b></span>
            <span className={health.routeTotal === health.monthTotal ? "ok" : "bad"}>مسیرها <b>{health.routeTotal.toLocaleString("en-US")}</b></span>
            <span className={health.expertTotal === health.monthTotal ? "ok" : "bad"}>کارشناسان <b>{health.expertTotal.toLocaleString("en-US")}</b></span>
          </div>
          {healthIssueCount > 0 && <div className="dataHealthDetails"><div>
            {invariantMismatch && <p className="critical"><b>عدم تطابق جمع‌ها:</b> کل {health.monthTotal.toLocaleString("en-US")}، کانال‌ها {health.channelTotal.toLocaleString("en-US")}، مسیرها {health.routeTotal.toLocaleString("en-US")} و کارشناسان {health.expertTotal.toLocaleString("en-US")}.</p>}
            {health.unknownSources.map(conflict => <p key={conflict.source}><b>منبع ناشناخته «{conflict.source}»:</b> ردیف‌های {conflict.rows.join("، ")}؛ مستقل شمرده شده و داخل «سایر» قرار نگرفته است.</p>)}
            {health.dateIssueRows.length > 0 && <p><b>تاریخ بلوکی نامشخص:</b> ردیف‌های {health.dateIssueRows.join("، ")}.</p>}
            {health.missingRouteRows.length > 0 && <p><b>مسیر ثبت نشده:</b> ردیف‌های {health.missingRouteRows.join("، ")}.</p>}
            {health.missingExpertRows.length > 0 && <p><b>نام کارشناس وارد نشده:</b> نام کارشناس در ردیف‌های {health.missingExpertRows.join("، ")} وارد نشده است.</p>}
            {manualContractAnomalies.map(item => <p className="critical" key={item.expert}><b>قرارداد بیشتر از تماس:</b> {item.expert} · {item.contracts.toLocaleString("en-US")} قرارداد در برابر {item.calls.toLocaleString("en-US")} تماس معتبر؛ داده ذخیره شده اما نیازمند اصلاح است.</p>)}
            {manualContractsError && <p className="critical"><b>قراردادهای دستی بررسی نشد:</b> اتصال به ذخیره‌سازی قراردادها برقرار نشد؛ نرخ‌های تبدیل تا بازیابی اتصال فقط براساس دادهٔ قابل‌دسترسی نمایش داده می‌شوند.</p>}
          </div></div>}
          </div>
        </details>}
        {/* Atomic daily report: total, channel split, comparison, routes, and expert matrix. */}
        <section className="compactDaily glass" aria-label="خلاصه تماس‌ها و کانال‌های ورودی روز">
          <div className="compactSummary">
            <div className="compactReportTitle"><i className="livePulseIcon" aria-hidden="true"><svg viewBox="0 0 32 20"><path pathLength="1" d="M2 11h5l2.6-5.4 4.2 10.6 4.3-9.2 3 4H30" /></svg></i><div><h2>آمار {reportQualifier}</h2><span title="منبع فایل، رکورد واقعی را مشخص می‌کند؛ تاریخ هر ردیف از اولین تاریخ ثبت‌شده در بلوک همان روز تعیین می‌شود.">{activeDateLabel}</span></div></div>
            <div className="compactTotal"><span>{viewingCurrentMonth ? "کل تماس‌های ورودی امروز" : `کل تماس‌های آخرین روز کاری ${formatMonth(selectedMonth)}`}</span><div className="compactNumber">{todayTotal.toLocaleString("en-US")}</div></div>
            <div className="compactMetrics">
              <div className={`compactMetric ${change >= 0 ? "positive" : "negative"}`}><small>تغییر نسبت به روز کاری قبل</small><strong>{change >= 0 ? "↑" : "↓"} {Math.abs(change)}%</strong></div>
              <div className="compactMetric average"><small>میانگین تعداد تماس روزانه این ماه</small><strong>{average.toLocaleString("en-US")} <em>تماس</em></strong></div>
            </div>
          </div>
          <div className={`dailyInsight ${dailyInsight.level}`} role="status"><i/>{dailyInsight.text}</div>
          {integrityIssue && <div className="dataWarning integrityWarning" role="alert"><strong>⚠ داده جدید نمایش داده نشد</strong><span>{integrityIssue}؛ آخرین اسنپ‌شات کاملاً معتبر همچنان نمایش داده می‌شود.</span></div>}
          {dateIssueRows.length > 0 && <div className="dataWarning" role="alert"><strong>⚠ تاریخ رکورد مشخص نیست</strong><span>ردیف‌های {dateIssueRows.join("، ")} منبع ورودی دارند اما پیش از اولین تاریخ معتبر بلوک قرار گرفته‌اند؛ در آمار کلی رکورد واقعی‌اند ولی به هیچ روزی نسبت داده نشده‌اند.</span></div>}
          <div className="compactChannelsTitle"><span>تفکیک کانال‌های {reportQualifier}</span><small>مجموع {todayTotal.toLocaleString("en-US")} ورودی</small></div>
          <div className="compactChannelGrid">
            {channels.map(channel => (
              <article className={`compactChannel ${channel.color}`} key={channel.name}>
                <div className="compactChannelIcon">{channel.icon}</div>
                <div className="compactChannelInfo"><span>{channel.name}</span><small>{channel.share}% سهم</small></div>
                <strong>{channel.value.toLocaleString("en-US")}</strong>
                {DAILY_COST_CHANNELS.has(channel.name) && (() => { const isAdsGroup = channel.name === primaryGoogleAdsChannel(); const metric = isAdsGroup ? adsTodayMetric : todayCostMetrics[channel.name]; const formula = metric?.costToman === null || metric?.costToman === undefined ? "هزینه ثبت نشده است." : `تومان ${formatDashboardNumber(metric.costToman)} ÷ ${metric.leads.toLocaleString("en-US")} لید؛ CAC بر پایه ${metric.contracts.toLocaleString("en-US")} قرارداد همان کانال‌ها.`; const detail = `${FINANCIAL_METRIC_DEFINITIONS} ${formula}`; return <small className="channelFinance" title={isAdsGroup ? `گروه تجمیعی ${googleAdsLeadChannels().join(" + ")}. ${detail}` : detail}><span>CPL <b>{metric?.cpl === null || metric?.cpl === undefined ? "ثبت نشده" : formatToman(metric.cpl)}</b></span><span>CAC <b>{metric?.cac === null || metric?.cac === undefined ? "ثبت نشده" : formatToman(metric.cac)}</b></span></small>; })()}
              </article>
            ))}
          </div>
          {channelTotal !== todayTotal && <div className="dataWarning" role="alert"><strong>⚠ گوگل‌شیت باید اصلاح شود</strong><span>جمع کل {todayTotal.toLocaleString("en-US")} است اما مجموع کانال‌ها {channelTotal.toLocaleString("en-US")} است.</span></div>}
          {dataConflicts.length > 0 && channelTotal === todayTotal && <div className="dataInfo" role="status"><strong>● کانال جدید شناسایی شد</strong><span>{formatDataConflictNotice(dataConflicts)}</span></div>}
          <div className="dailyComparison" aria-label="نمودار مقایسه کانال‌های روز با روز کاری قبل">
            <div className="comparisonHeader"><strong>مقایسه کانال‌های {reportQualifier}</strong><div className="comparisonLegend"><span><i className="today"/>روز گزارش</span><span><i className="previous"/>روز کاری قبل</span></div></div>
            <div className="comparisonRows">
              {comparisonChannels.map(channel => (
                <div className="comparisonRow" key={channel.name} tabIndex={0} role="img" aria-label={`${channel.name}: روز گزارش ${channel.today.toLocaleString("en-US")} تماس، روز کاری قبل ${channel.previous.toLocaleString("en-US")} تماس`}>
                  <span className="comparisonLabel">{channel.name}</span>
                  <div className="comparisonBars">
                    <span className="comparisonBarLine"><span className="comparisonTrack"><i className="today" style={{ width: `${(channel.today / comparisonMax) * 100}%` }}/></span><b className="todayValue">{channel.today.toLocaleString("en-US")}</b></span>
                    <span className="comparisonBarLine"><span className="comparisonTrack"><i className="previous" style={{ width: `${(channel.previous / comparisonMax) * 100}%` }}/></span><b className="previousValue">{channel.previous.toLocaleString("en-US")}</b></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="routeComparison" aria-label="نمودار مسیرهای ورودی روز گزارش">
            <div className="routeHeader"><strong>تفکیک مسیرهای ورودی {reportQualifier}</strong><small>مجموع {routeTotal.toLocaleString("en-US")} ورودی</small></div>
            <div className="routeComparisonRows">
              {routes.map(route => (
                <div className="routeComparisonRow" key={route.name} role="img" aria-label={`${route.name}: ${route.value.toLocaleString("en-US")} تماس`}>
                  <span className="comparisonLabel">{route.name}</span>
                  <span className="comparisonTrack"><i className="today" style={{ width: `${(route.value / routeMax) * 100}%` }}/></span>
                  <strong className="routeValue">{route.value.toLocaleString("en-US")}</strong>
                </div>
              ))}
            </div>
            {routeTotal !== todayTotal && <div className="dataWarning" role="alert"><strong>⚠ گوگل‌شیت باید اصلاح شود</strong><span>جمع کل {todayTotal.toLocaleString("en-US")} است اما مجموع مسیرها {routeTotal.toLocaleString("en-US")} است.</span></div>}
          </div>
          <div className="expertMatrix" aria-label="ماتریس عملکرد کارشناسان روز گزارش">
            <div className="expertMatrixHeader"><div><strong>عملکرد کارشناسان {reportQualifier}</strong><small>تعداد پاسخ، کانال ورودی و مسیر هر کارشناس</small></div><span>مجموع {expertTotal.toLocaleString("en-US")} پاسخ</span></div>
            <div className="expertGrid">
              {experts.map(expert => {
                const expertChannels = Object.entries(expert.channels).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
                const expertRoutes = Object.entries(expert.routes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
                const efficiency = resolveDailyExpertEfficiency(expert);
                const expertCost = getDailyExpertCost(expert);
                const mergedAliases = expert.aliases || [];
                const aliasTooltip = mergedAliases.length > 1 ? `املای ادغام‌شده: ${mergedAliases.join("، ")}` : "";
                return (
                  <article className={`expertCard ${expert.name === "کارشناس ثبت نشده" ? "unassigned" : ""}`} key={expert.name}>
                    <div className="expertTop"><span className="expertAvatar">{expert.name === "کارشناس ثبت نشده" ? "!" : expert.name.slice(0, 1)}</span><div><strong title={aliasTooltip || undefined}>{expert.name}{aliasTooltip && <i className="aliasBadge" tabIndex={0}>ادغام</i>}</strong><small>{viewingCurrentMonth ? "پاسخ امروز" : "پاسخ روز گزارش"}</small>{expert.name !== "کارشناس ثبت نشده" && <small className="expertContractCount">قرارداد روز: <b>{efficiency.contracts.toLocaleString("en-US")}</b></small>}</div><b>{expert.total.toLocaleString("en-US")}</b></div>
                    {expert.name !== "کارشناس ثبت نشده" && <div className={`expertEfficiency ${efficiency.anomaly ? "anomaly" : ""}`} tabIndex={0} title={`${efficiency.contracts.toLocaleString("en-US")} قرارداد از ${efficiency.calls.toLocaleString("en-US")} تماس همان روز · ${efficiency.source}${aliasTooltip ? ` · ${aliasTooltip}` : ""}`}><span>نرخ تبدیل روزانه</span><strong>{`${formatDashboardNumber(efficiency.percentage)}%`}</strong><i>?</i><em>{efficiency.contracts.toLocaleString("en-US")} قرارداد از {efficiency.calls.toLocaleString("en-US")} تماس همان روز · منبع: {efficiency.source}{aliasTooltip ? ` · ${aliasTooltip}` : ""}</em></div>}
                    {expert.name !== "کارشناس ثبت نشده" && efficiency.contracts > 0 && <ContractRouteChips routes={expert.contractRoutes || {}} routeChannels={expert.contractRouteChannels || {}}/>}
                    {expert.name !== "کارشناس ثبت نشده" && <div className="expertFinance" title={`${FINANCIAL_METRIC_DEFINITIONS} هزینه فقط بین لیدهای همان کانال تخصیص یافته است؛ CPL بر پایه ${expertCost.leads.toLocaleString("en-US")} لید و CAC بر پایه ${expertCost.contracts.toLocaleString("en-US")} قرارداد دارای هزینه محاسبه می‌شود.`}><span>CPL <b>{expertCost.cpl === null ? "ثبت نشده" : formatToman(expertCost.cpl)}</b></span><span>CAC <b>{expertCost.cac === null ? "ثبت نشده" : formatToman(expertCost.cac)}</b></span></div>}
                    <div className="expertStack" aria-label={`تفکیک کانال‌های ${expert.name}`}>
                      {expertChannels.map(([channel, count]) => <span className={`expertSegment ${channelColor(channel)}`} style={{ width: `${(count / expert.total) * 100}%` }} key={channel} tabIndex={0}><i>{channel}: {count.toLocaleString("en-US")}</i></span>)}
                    </div>
                    <div className="expertChannels">{expertChannels.map(([channel, count]) => <span className={channelColor(channel)} key={channel}><i/>{channel}<b>{count.toLocaleString("en-US")}</b></span>)}</div>
                    <div className="expertRoutes"><small>مسیرها</small><div>{expertRoutes.map(([route, count]) => {
                      const routeChannels = Object.entries(expert.routeChannels?.[route] || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
                      const channelSummary = routeChannels.map(([channel, value]) => `${channel} ${value.toLocaleString("en-US")}`).join("، ");
                      return <details className={`expertRouteDetail ${routeDetailWidthClass(route)}`} key={route}>
                        <summary className="expertRouteChip" aria-label={`${route}: ${count.toLocaleString("en-US")} تماس؛ کانال‌ها: ${channelSummary}`}><span>{route}</span><b>{count.toLocaleString("en-US")}</b><span className="routeMiniBar" aria-hidden="true">{routeChannels.map(([channel, value]) => <i className={channelColor(channel)} style={{ width: `${(value / count) * 100}%` }} key={channel}/>)}</span><span className="routeChannelTooltip"><strong>{route} · {count.toLocaleString("en-US")} تماس</strong>{routeChannels.map(([channel, value]) => <em key={channel}><i className={channelColor(channel)}/><span>{channel}</span><b>{value.toLocaleString("en-US")}</b></em>)}</span></summary>
                        <div className="routeChannelInline">{routeChannels.map(([channel, value]) => <span key={channel}><i className={channelColor(channel)}/><em>{channel}</em><b>{value.toLocaleString("en-US")}</b></span>)}</div>
                      </details>;
                    })}</div></div>
                  </article>
                );
              })}
            </div>
            {expertTotal !== todayTotal && <div className="dataWarning" role="alert"><strong>⚠ گوگل‌شیت باید اصلاح شود</strong><span>جمع کل {todayTotal.toLocaleString("en-US")} است اما مجموع رکوردهای کارشناسان {expertTotal.toLocaleString("en-US")} است.</span></div>}
          </div>
          <div className="heroGlow"/>
        </section>

        {/* Independent Persian date-range report with its own aggregation and integrity checks. */}
        <section className={`selectedDateSection glass ${calendarOpen ? "calendarOpen" : ""}`} aria-label="آمار بازه زمانی انتخابی" aria-busy={selectedDateLoading}>
          <div className="selectedDateHeader">
            <div><h2>آمار بازهٔ زمانی <span>(انتخاب شمسی)</span></h2><p>حالت پیش‌فرض: از ابتدای ماه جاری تا امروز؛ برای تغییر، ابتدا روز شروع و سپس روز پایان را انتخاب کنید.</p></div>
            <div className="datePicker" ref={calendarRef}>
              <button className="datePickerButton active" type="button" onClick={() => { setCalendarMonth(selectedEndDate.slice(0, 7)); setRangeAnchor(null); setCalendarOpen(open => !open); }} aria-expanded={calendarOpen} aria-haspopup="dialog"><span className={`selectedDateRefreshIndicator ${selectedDateLoading ? "active" : ""}`} aria-hidden="true">↻</span>▦ {formatRecordedDate(selectedStartDate)} تا {formatRecordedDate(selectedEndDate)}</button>
              {calendarOpen && <div className="persianCalendar glass" role="dialog" aria-label="انتخاب تاریخ شمسی">
                <div className="calendarHeader">
                  <button type="button" onClick={() => calendarMonthIndex > 0 && setCalendarMonth(availableCalendarMonths[calendarMonthIndex - 1].value)} disabled={calendarMonthIndex <= 0} aria-label="ماه قبل">‹</button>
                  <strong>{formatMonth(calendarMonth)}</strong>
                  <button type="button" onClick={() => calendarMonthIndex < availableCalendarMonths.length - 1 && setCalendarMonth(availableCalendarMonths[calendarMonthIndex + 1].value)} disabled={calendarMonthIndex >= availableCalendarMonths.length - 1} aria-label="ماه بعد">›</button>
                </div>
                <div className="calendarWeekdays" aria-hidden="true">{["ش", "ی", "د", "س", "چ", "پ", "ج"].map(day => <span key={day}>{day}</span>)}</div>
                <div className="calendarDays">{Array.from({ length: calendar.firstWeekday }, (_, index) => <i key={`empty-${index}`}/>)}{calendar.days.map(day => {
                  const dateKey = `${calendarMonth}/${String(day).padStart(2, "0")}`;
                  const isFuture = dateKey > today.sheetDate;
                  const isRangeEdge = selectedStartDate === dateKey || selectedEndDate === dateKey;
                  const isInRange = dateKey >= selectedStartDate && dateKey <= selectedEndDate;
                  return <button type="button" key={day} disabled={isFuture} className={`${isRangeEdge ? "selected" : ""} ${isInRange ? "inRange" : ""} ${today.sheetDate === dateKey ? "today" : ""}`} onClick={() => chooseRangeDate(day)}>{day.toLocaleString("en-US", { useGrouping: false })}</button>;
                })}</div>
                <div className="calendarFooter"><button type="button" onClick={() => { chartRangeBeforeClickRef.current = null; setSelectedStartDate(`${currentMonth}/01`); setSelectedEndDate(today.sheetDate); setMainDateOverride(null); setRangeAnchor(null); setSelectedMonth(currentMonth); setCalendarMonth(currentMonth); setCalendarOpen(false); }}>بازهٔ پیش‌فرض ماه جاری</button><small>{rangeAnchor ? "حالا روز پایان را انتخاب کنید" : "ابتدا شروع، سپس پایان"}</small></div>
              </div>}
            </div>
          </div>

          <span className="srOnly" role="status" aria-live="polite">{selectedDateLoading ? "در حال بروزرسانی اطلاعات بازه در پس‌زمینه" : ""}</span>
          {selectedDateError && <div className="dataWarning" role="alert"><strong>⚠ دریافت ناموفق</strong><span>{selectedDateError}</span></div>}
          {selectedDateData && <>
            <div className="selectedDateSummary">
              <div className="selectedDateTotal"><small>{selectedFilterLabel ? `ورودی‌های ${selectedFilterLabel}` : "کل تماس‌های ورودی"}</small><strong>{selectedFilteredTotal.toLocaleString("en-US")}</strong>{!selectedChannelFilter && rangeComparison && <em className="periodComparison">{formatPeriodComparison(selectedDateData.total, rangeComparison.total, "لید")}</em>}{summaryLeadChannels.length > 0 && <div className="summaryChips" aria-label="کانال‌های ورودی بازه">{summaryLeadChannels.map(channel => <span key={channel.name} title={`${channel.name}: ${channel.value.toLocaleString("en-US")} لید`}><b>{channel.name}</b><strong>{channel.value.toLocaleString("en-US")}</strong><small>لید</small></span>)}</div>}</div>
              <div className="selectedDateContracts"><small>{selectedFilterLabel ? `قرارداد قابل انتساب به ${selectedFilterLabel}` : "تعداد قرارداد بازه"}</small><strong>{selectedFilteredContracts === null ? "ثبت نشده" : selectedFilteredContracts.toLocaleString("en-US")}</strong>{!selectedChannelFilter && rangeComparison && selectedDateData.resolvedContractTotal !== null && rangeComparison.contracts !== null && <em className="periodComparison">{formatPeriodComparison(selectedDateData.resolvedContractTotal, rangeComparison.contracts, "قرارداد")}</em>}{summaryContractChips.length > 0 && <div className="summaryChips summaryContractChips" aria-label="مسیر و کانال قراردادهای بازه">{summaryContractChips.map(chip => <span key={`${chip.route}-${chip.channel}`} title={`${chip.route} · ${chip.channel} · ${chip.count.toLocaleString("en-US")} قرارداد`}><b>{chip.route}</b><i>·</i><em>{chip.channel}</em><strong>{chip.count.toLocaleString("en-US")}</strong><small>قرارداد</small></span>)}</div>}</div>
              {/* The range budget uses the exact same covered costs as CPL and CAC, so every summary card stays reconcilable. */}
              <div className={`selectedDateBudget ${rangeCostCoverageIncomplete ? "incomplete" : ""}`} title={selectedRangeCost === null ? "برای این بازه هنوز هزینه یا بودجهٔ قابل‌محاسبه ثبت نشده است." : `مجموع هزینه‌های قابل‌محاسبهٔ کانال‌های بازه: ${formatToman(selectedRangeCost)}${rangeCostCoverageIncomplete ? "؛ بخشی از اطلاعات هزینه هنوز تکمیل نشده است." : "."}`}><small>{selectedFilterLabel ? `بودجهٔ ${selectedFilterLabel}` : "کل بودجهٔ بازه"}</small><strong>{selectedRangeCost === null ? "ثبت نشده" : formatToman(selectedRangeCost)}</strong><em>{rangeCostCoverageIncomplete ? "پوشش هزینه ناقص" : "اطلاعات هزینه کامل"}</em>{!selectedChannelFilter && rangeBudgetChannels.length > 0 && <div className="rangeBudgetChips" aria-label="بودجهٔ هر کانال در بازه">{rangeBudgetChannels.map(([channel, cost]) => <span key={channel} title={`${channel}: ${formatToman(cost as number)}`}><b>{channel}</b><strong>{formatDashboardNumber(cost as number)}</strong><small>تومان</small></span>)}</div>}</div>
              <div className="selectedDateChange positive"><small>{selectedFilteredRecordedDays.toLocaleString("en-US")} روز دارای رکورد</small><strong>میانگین {selectedFilteredAverage.toLocaleString("en-US")} تماس</strong>{!selectedChannelFilter && rangeComparison && <em className="periodComparison">{formatPeriodComparison(selectedDateData.average, rangeComparison.average, "تماس روزانه")}</em>}</div>
              <OverallCostCard metric={overallRangeMetric} kind="cpl"/>
              <OverallCostCard metric={overallRangeMetric} kind="cac"/>
              <div className="selectedDateTopContractRoutes" aria-label="ده مسیر دارای بیشترین قرارداد در بازه انتخابی">
                <header><div><i aria-hidden="true">⌁</i><b>۱۰ مسیر برتر از نظر تعداد قرارداد</b></div><small>{selectedFilterLabel ? `فیلتر ${selectedFilterLabel}` : "کل کانال‌ها"} · بازهٔ انتخابی</small></header>
                {topContractRoutes.length > 0 ? <ol>{topContractRoutes.map(route => { const channelSummary = route.channels.map(channel => `${channel.name} ${channel.count.toLocaleString("en-US")}`).join("، "); return <li key={route.name} title={`${route.count.toLocaleString("fa-IR")} قرارداد ${route.name} · کانال ورودی: ${channelSummary}`}><span className="contractRouteName"><b>{route.count.toLocaleString("fa-IR")}</b> قرارداد {route.name}</span><span className="contractRouteChannels" aria-label={`کانال‌های ورودی ${route.name}`}>{route.channels.map(channel => <small key={channel.name}><span>{channel.name}</span><b>{channel.count.toLocaleString("en-US")}</b></small>)}</span><i aria-hidden="true"><b style={{ width: `${Math.max(12, route.count / topContractRouteMax * 100)}%` }}/></i></li>; })}</ol> : <p>در این بازه مسیرِ دارای قرارداد ثبت نشده است.</p>}
              </div>
            </div>
            <RangeConversionFunnel
              key={`${selectedStartDate}-${selectedEndDate}`}
              awarenessTotal={rangeCosts?.awarenessTotal ?? null}
              adsImpressions={rangeCosts?.adsImpressions ?? null}
              smsEstimatedSent={rangeCosts?.smsEstimatedSent ?? null}
              awarenessIssues={rangeCosts?.awarenessIssues || ["داده‌های هزینه و تبلیغات هنوز دریافت نشده"]}
              total={selectedDateData.total}
              resolved={selectedDateData.resolvedOutcomeCount}
              contracts={Object.values(selectedDateData.channelContractCounts).reduce((sum, count) => sum + count, 0)}
            />
            {!selectedChannelFilter && rangeInsight && <section className={`rangeInsight ${rangeInsight.level}`} role="status" aria-label="برآورد مدیریتی بازهٔ انتخابی">
              {/* The management conclusion is visually separated from the supporting metrics to remain readable at a glance. */}
              <header className="rangeInsightHeadline"><span><i/>برآورد مدیریتی</span><strong>{rangeInsight.headline}</strong><small>{rangeInsight.detail}</small></header>
              {/* One compact card per financial scope replaces the former single dense sentence. */}
              <FinancialChannelCards channels={[{ name: "جمع کل بازه", color: "total", leads: selectedDateData.total, contracts: Object.values(selectedDateData.channelContractCounts).reduce((sum, count) => sum + count, 0), conversionRate: selectedDateData.total > 0 ? Object.values(selectedDateData.channelContractCounts).reduce((sum, count) => sum + count, 0) / selectedDateData.total * 100 : null, costToman: rangeInsightFinancials.totalCost, cpl: rangeInsightFinancials.totalCpl, cac: rangeInsightFinancials.totalCac }, ...rangeInsightFinancials.channels]}/>
              <small className="rangeInsightGuide">{RANGE_INSIGHT_GUIDE}</small>
            </section>}
            {selectedDateData.manualContractsUnavailable && <div className="dataWarning" role="alert"><strong>⚠ قرارداد دستی قابل بررسی نیست</strong><span>بخشی از ذخیره‌سازی قراردادهای دستی این بازه در دسترس نبود؛ نرخ‌های تبدیل بازه تا اتصال مجدد فقط از دادهٔ قابل‌دسترسی محاسبه شده‌اند.</span></div>}
            {selectedDateData.dateIssueRows.length > 0 && <div className="dataWarning" role="alert"><strong>⚠ تاریخ رکورد مشخص نیست</strong><span>ردیف‌های {selectedDateData.dateIssueRows.join("، ")} منبع ورودی دارند اما تاریخ بلوکی قابل‌تشخیص ندارند و وارد آمار این بازه نشده‌اند.</span></div>}
            {selectedDateData.contractAttributionGap > 0 && <div className="dataWarning" role="status"><strong>⚠ پوشش CAC ناقص است</strong><span>{selectedDateData.contractAttributionGap.toLocaleString("en-US")} قرارداد تجمیعی قدیمی کانال قابل‌تأیید ندارد؛ در تعداد کل قرارداد حفظ شده اما طبق قانون شما وارد CAC کانالی نشده است.</span></div>}
            {rangeCosts?.missingRateMonths.length ? <div className="dataWarning" role="alert"><strong>⚠ نرخ تبدیل ماهانه ناقص است</strong><span>نرخ TRY برای {rangeCosts.missingRateMonths.map(formatMonth).join("، ")} ثبت نشده؛ CPL و CAC کانال‌های Google Ads تا تکمیل نرخ نمایش داده نمی‌شوند.</span></div> : null}
            {selectedDateData.total === 0 ? <div className="emptyDateNotice" role="status">برای این بازه رکوردی در گوگل‌شیت ثبت نشده است.</div> : <>
              <div className="selectedDateChannelsHead"><strong>تفکیک کانال‌ها</strong><small>{selectedChannelFilter ? `فیلتر فعال: ${selectedChannelFilter === primaryGoogleAdsChannel() ? `${primaryGoogleAdsChannel()} (تجمیعی)` : selectedChannelFilter} · برای حذف دوباره کلیک کنید` : `مجموع ${selectedDateChannelTotal.toLocaleString("en-US")} ورودی · برای فیلتر کلیک کنید`}</small></div>
              <div className="rangeAggregationNote" role="note"><i>i</i><span>عملکرد هر کانال در کارت خودش محاسبه می‌شود؛ کلیک روی کانال‌های وابسته به Google Ads همچنان گزارش کل گروه {googleAdsLeadChannels().join(" + ")} را فیلتر می‌کند.</span></div>
              <div className="selectedDateChannelGrid">{selectedDateChannels.map(channel => {
                const groupedFilter = googleAdsLeadChannels().includes(channel.name) ? primaryGoogleAdsChannel() : channel.name;
                const isSelected = selectedChannelFilter === groupedFilter;
                const metric = rangeCostMetrics[channel.name];
                const contracts = metric?.contracts || 0;
                const conversionRate = channel.value > 0 ? contracts / channel.value * 100 : 0;
                const cacLabel = NON_COST_CHANNELS.has(channel.name)
                  ? "بدون هزینه"
                  : metric?.cac === null || metric?.cac === undefined ? "ثبت نشده" : formatToman(metric.cac);
                const formula = NON_COST_CHANNELS.has(channel.name)
                  ? "این کانال طبق تنظیمات برند بدون هزینه است؛ CAC برای آن موضوعیت ندارد."
                  : metric?.costToman === null || metric?.costToman === undefined ? "هزینه ثبت نشده است." : `تومان ${formatDashboardNumber(metric.costToman)} ÷ ${metric.leads.toLocaleString("en-US")} لید؛ CAC بر پایه ${metric.contracts.toLocaleString("en-US")} قرارداد همان کانال‌ها.`;
                const detail = `${FINANCIAL_METRIC_DEFINITIONS} ${formula}`;
                return <button type="button" aria-pressed={isSelected} aria-label={`${channel.name}: ${channel.value} لید، ${contracts} قرارداد، نرخ تبدیل ${formatDashboardNumber(conversionRate)} درصد، CAC ${cacLabel}`} onClick={() => setSelectedChannelFilter(current => current === groupedFilter ? null : groupedFilter)} className={`compactChannel rangeChannelPerformance ${channel.color} ${isSelected ? "selected" : ""} ${selectedChannelFilter && !isSelected ? "dimmed" : ""}`} key={channel.name} title={detail}><div className="compactChannelIcon">{channel.icon}</div><div className="compactChannelInfo"><span>{channel.name}</span><small>{channel.share}% سهم بازه</small></div><strong><small>لید</small>{channel.value.toLocaleString("en-US")}</strong><div className="channelPerformanceMetrics"><span><small>قرارداد</small><b>{contracts.toLocaleString("en-US")}</b></span><span><small>نرخ تبدیل</small><b>{formatDashboardNumber(conversionRate)}%</b></span><span className="cac"><small>CAC کانال</small><b>{cacLabel}</b></span></div></button>;
              })}</div>
              <DashboardSectionBoundary fallback={<section className="rangeAnalyticsFallback" role="status"><strong>تحلیل نموداری موقتاً در دسترس نیست</strong><span>داده‌های جدول و گزارش بازه محفوظ است. بازه را دوباره انتخاب یا صفحه را تازه‌سازی کنید.</span></section>}>
                <RangeAnalyticsDashboard
                  key={`${selectedStartDate}:${selectedEndDate}:${selectedChannelFilter || ""}`}
                  title={selectedTrendTitle}
                  startDate={selectedStartDate}
                  endDate={selectedEndDate}
                  dailyCounts={selectedDateData.dailyCounts}
                  dailyChannelCounts={selectedDateData.dailyChannelCounts || {}}
                  dailyChannelContracts={selectedDateData.dailyChannelContracts || {}}
                  channels={rangeAnalyticsChannels}
                  costs={rangeCostMetrics}
                  dailyCosts={rangeCosts?.dailyCosts || {}}
                  previousDailyCosts={previousRangeCosts?.dailyCosts || {}}
                  routes={rangeAnalyticsRoutes}
                  experts={rangeAnalyticsExperts}
                  selectedChannelFilter={selectedChannelFilter}
                  selectedFilterLabel={selectedFilterLabel}
                  formatDate={formatRecordedDate}
                  onChannelFilter={setSelectedChannelFilter}
                  onResetSelection={resetChartRange}
                  onBucketSelect={(startDate, endDate) => {
                    if (!chartRangeBeforeClickRef.current) chartRangeBeforeClickRef.current = { startDate: selectedStartDate, endDate: selectedEndDate, month: selectedMonth, mainDateOverride };
                    setSelectedStartDate(startDate);
                    setSelectedEndDate(endDate);
                    setSelectedMonth(endDate.slice(0, 7));
                    setMainDateOverride(endDate);
                    setRangeAnchor(null);
                  }}
                />
              </DashboardSectionBoundary>
              <div className="selectedDateRoutes">
                <div className="selectedDateChannelsHead"><strong>تفکیک مسیرهای ورودی{selectedChannelFilter ? ` · ${selectedChannelFilter}` : ""}</strong><small>مجموع {selectedDateRouteTotal.toLocaleString("en-US")} ورودی</small></div>
                <div className="routeComparisonRows">{selectedDateRoutes.map(route => <div className="routeComparisonRow" key={route.name} role="img" aria-label={`${route.name}: ${route.value.toLocaleString("en-US")} تماس`}><span className="comparisonLabel">{route.name}</span><span className="comparisonTrack"><i className="today" style={{ width: `${(route.value / selectedDateRouteMax) * 100}%` }}/></span><strong className="routeValue">{route.value.toLocaleString("en-US")}</strong></div>)}</div>
              </div>
              <div className="selectedDateExperts">
                <div className="expertMatrixHeader"><div><strong>عملکرد کارشناسان بازهٔ انتخابی{selectedChannelFilter ? ` · ${selectedChannelFilter}` : ""}</strong><small>مرتب‌شده از بیشترین تماس به کمترین</small></div><span>مجموع {selectedDateExpertTotal.toLocaleString("en-US")} پاسخ</span></div>
                {topRangeExperts.length > 0 && <div className="topExpertsPanel">
                  <div className="topExpertsHead"><div><strong>3 کارشناس برتر بازه</strong><small>اولویت با قرارداد بیشتر، سپس نرخ تبدیل بالاتر</small></div><span className="trendInfo" tabIndex={0}>?<em>تعداد تماس بیشتر مزیت رتبه‌بندی نیست. اگر دو کارشناس قرارداد برابر داشته باشند، کارشناسی که با تماس کمتر نرخ تبدیل بالاتری ساخته باشد رتبهٔ بهتر می‌گیرد.</em></span></div>
                  <div className="topExpertsGrid">{topRangeExperts.map((expert, index) => <article className={`topExpert rank${index + 1}`} key={expert.name}>
                    <span className="topExpertRank">{index + 1}</span><div><strong>{expert.name}</strong><small>{expert.efficiency!.contracts!.toLocaleString("en-US")} قرارداد از {expert.total.toLocaleString("en-US")} تماس</small></div><b>{formatDashboardNumber(expert.efficiency!.percentage!)}%</b>
                  </article>)}</div>
                </div>}
                <div className="expertGrid">{selectedDateExperts.map(expert => {
                  const expertChannels = Object.entries(expert.channels).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
                  const expertRoutes = Object.entries(expert.routes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
                  const efficiency = getRangeExpertEfficiency(expert.name, expert.total) || { contracts: null, percentage: null, source: "ثبت نشده", anomaly: false };
                  const expertCost = getRangeExpertCost(expert);
                  const mergedAliases = expert.aliases || [];
                  const aliasTooltip = mergedAliases.length > 1 ? `املای ادغام‌شده: ${mergedAliases.join("، ")}` : "";
                  const contractRouteChannels = selectedDateData.expertContractRouteChannels?.[expert.name] || {};
                  const contractRoutes = Object.fromEntries(Object.entries(contractRouteChannels).map(([route, channelMap]) => [
                    route,
                    selectedChannelFilter
                      ? selectedFilterChannels.reduce((sum, channel) => sum + (channelMap[channel] || 0), 0)
                      : Object.values(channelMap).reduce((sum, count) => sum + count, 0),
                  ]).filter(([, count]) => Number(count) > 0)) as Record<string, number>;
                  // Keep only the channels represented by the active range filter before rendering contract chips.
                  const visibleContractRouteChannels = Object.fromEntries(Object.entries(contractRouteChannels).map(([route, channelMap]) => [
                    route,
                    Object.fromEntries(Object.entries(channelMap).filter(([channel, count]) => Number(count) > 0 && (!selectedChannelFilter || selectedFilterChannels.includes(channel)))),
                  ]).filter(([, channelMap]) => Object.keys(channelMap as Record<string, number>).length > 0)) as Record<string, Record<string, number>>;
                  const attributableRouteContracts = Object.values(contractRoutes).reduce((sum, count) => sum + count, 0);
                  const unknownRouteContracts = !selectedChannelFilter && efficiency.contracts !== null ? Math.max(0, efficiency.contracts - attributableRouteContracts) : 0;
                  return <article className={`expertCard ${expert.name === "کارشناس ثبت نشده" ? "unassigned" : ""}`} key={expert.name}>
                    <div className="expertTop"><span className="expertAvatar">{expert.name === "کارشناس ثبت نشده" ? "!" : expert.name.slice(0, 1)}</span><div><strong title={aliasTooltip || undefined}>{expert.name}{aliasTooltip && <i className="aliasBadge" tabIndex={0}>ادغام</i>}</strong><small>پاسخ بازهٔ انتخابی</small>{expert.name !== "کارشناس ثبت نشده" && <small className="expertContractCount">تعداد قرارداد: <b>{efficiency.contracts.toLocaleString("en-US")}</b></small>}</div><b>{expert.total.toLocaleString("en-US")}</b></div>
                    {expert.name !== "کارشناس ثبت نشده" && <div className={`expertEfficiency ${efficiency.anomaly ? "anomaly" : ""}`} tabIndex={0} title={`${efficiency.contracts.toLocaleString("en-US")} قرارداد از ${expert.total.toLocaleString("en-US")} تماس بازه · منبع: ${efficiency.source}${aliasTooltip ? ` · ${aliasTooltip}` : ""}`}><span>{selectedEfficiencyLabel}</span><strong>{`${formatDashboardNumber(efficiency.percentage)}%`}</strong><i>?</i><em>{`${efficiency.contracts.toLocaleString("en-US")} قرارداد از ${expert.total.toLocaleString("en-US")} تماس بازه · منبع: ${efficiency.source}`}{aliasTooltip ? ` · ${aliasTooltip}` : ""}</em></div>}
                    {expert.name !== "کارشناس ثبت نشده" && efficiency.contracts !== null && efficiency.contracts > 0 && <ContractRouteChips routes={contractRoutes} routeChannels={visibleContractRouteChannels} unknown={unknownRouteContracts}/>}
                    {expert.name !== "کارشناس ثبت نشده" && <div className="expertFinance" title={`${FINANCIAL_METRIC_DEFINITIONS} هزینه فقط بین لیدهای همان کانال تخصیص یافته است؛ CPL بر پایه ${expertCost.leads.toLocaleString("en-US")} لید و CAC بر پایه ${expertCost.contracts.toLocaleString("en-US")} قرارداد دارای هزینه محاسبه می‌شود.`}><span>CPL <b>{expertCost.cpl === null ? "ثبت نشده" : formatToman(expertCost.cpl)}</b></span><span>CAC <b>{expertCost.cac === null ? "ثبت نشده" : formatToman(expertCost.cac)}</b></span></div>}
                    <div className="expertStack" aria-label={`تفکیک کانال‌های ${expert.name}`}>{expertChannels.map(([channel, count]) => <span className={`expertSegment ${channelColor(channel)}`} style={{ width: `${(count / expert.total) * 100}%` }} key={channel} tabIndex={0}><i>{channel}: {count.toLocaleString("en-US")}</i></span>)}</div>
                    <div className="expertChannels">{expertChannels.map(([channel, count]) => <span className={channelColor(channel)} key={channel}><i/>{channel}<b>{count.toLocaleString("en-US")}</b></span>)}</div>
                    <div className="expertRoutes"><small>مسیرها</small><div>{expertRoutes.map(([route, count]) => {
                      const routeChannels = Object.entries(expert.routeChannels?.[route] || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"));
                      const channelSummary = routeChannels.map(([channel, value]) => `${channel} ${value.toLocaleString("en-US")}`).join("، ");
                      return <details className={`expertRouteDetail ${routeDetailWidthClass(route)}`} key={route}><summary className="expertRouteChip" aria-label={`${route}: ${count.toLocaleString("en-US")} تماس؛ کانال‌ها: ${channelSummary}`}><span>{route}</span><b>{count.toLocaleString("en-US")}</b><span className="routeMiniBar" aria-hidden="true">{routeChannels.map(([channel, value]) => <i className={channelColor(channel)} style={{ width: `${(value / count) * 100}%` }} key={channel}/>)}</span><span className="routeChannelTooltip"><strong>{route} · {count.toLocaleString("en-US")} تماس</strong>{routeChannels.map(([channel, value]) => <em key={channel}><i className={channelColor(channel)}/><span>{channel}</span><b>{value.toLocaleString("en-US")}</b></em>)}</span></summary><div className="routeChannelInline">{routeChannels.map(([channel, value]) => <span key={channel}><i className={channelColor(channel)}/><em>{channel}</em><b>{value.toLocaleString("en-US")}</b></span>)}</div></details>;
                    })}</div></div>
                  </article>;
                })}</div>
              </div>
            </>}
            {selectedDateChannelTotal !== selectedDateData.total && <div className="dataWarning" role="alert"><strong>⚠ گوگل‌شیت باید اصلاح شود</strong><span>جمع کل {selectedDateData.total.toLocaleString("en-US")} است اما مجموع کانال‌ها {selectedDateChannelTotal.toLocaleString("en-US")} است.</span></div>}
            {selectedDateData.conflicts.length > 0 && selectedDateChannelTotal === selectedDateData.total && <div className="dataInfo" role="status"><strong>● کانال جدید شناسایی شد</strong><span>{formatDataConflictNotice(selectedDateData.conflicts)}</span></div>}
            {(selectedDateRouteTotal !== selectedFilteredTotal || selectedDateExpertTotal !== selectedFilteredTotal) && <div className="dataWarning" role="alert"><strong>⚠ گوگل‌شیت باید اصلاح شود</strong><span>{selectedChannelFilter ? `فیلتر ${selectedChannelFilter}` : "کل بازه"} {selectedFilteredTotal.toLocaleString("en-US")}، مسیرها {selectedDateRouteTotal.toLocaleString("en-US")} و کارشناسان {selectedDateExpertTotal.toLocaleString("en-US")} رکورد است.</span></div>}
          </>}
        </section>

        </> : activeView === "google-ads" ? <GoogleAdsReportPage key={activeBrand.id} brandId={activeBrand.id} today={today} reloadToken={googleAdsReportReload} availableSheetMonths={availableSheetMonths} onSetup={() => { setActiveView("settings"); window.setTimeout(() => document.getElementById("google-ads-connection")?.scrollIntoView({ block: "start" }), 0); }}/>
          : activeView === "search-console" ? <SearchConsolePage key={activeBrand.id} brandId={activeBrand.id} onSetup={() => { setActiveView("settings"); window.setTimeout(() => document.getElementById("search-console-connection")?.scrollIntoView({ block: "start" }), 0); }}/>
          : activeView === "contracts" ? <ExpertContractsPage key={activeBrand.id} brandId={activeBrand.id} month={selectedMonth} onSaved={() => setMonthlyContractReload(value => value + 1)}/>
          : activeView === "phone-extraction" ? <PhoneExtractionPage key={activeBrand.id} brandId={activeBrand.id} defaultStartDate={selectedStartDate} defaultEndDate={selectedEndDate} todayDate={today.sheetDate} availableSheetMonths={availableSheetMonths}/>
          : activeView === "budgets" ? <BudgetEntryPage key={activeBrand.id} brandId={activeBrand.id} month={selectedMonth} rules={activeDashboardRules}/>
          : <BrandSettingsPage brands={brands} activeBrandId={activeBrand.id} onReload={loadBrands} onSelect={selectBrand} onRulesPublished={publishedRules => { applyRuntimeRules(publishedRules); setActiveDashboardRules(publishedRules); setCostReload(value => value + 1); }}/>} {/* Independent reports and persistent brand settings. */}

        <AppCopyright />
      </div>
    </main>
  );
}
