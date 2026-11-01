"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  buildRangeAnalyticsBuckets,
  formatRangeBucketLabel,
  type RangeAnalyticsBucket,
  type RangeAnalyticsChannel,
  type RangeAnalyticsDailyPoint,
} from "./range-analytics";

type CostMetric = { costToman: number | null; leads: number; contracts: number; cpl: number | null; cac: number | null };
type AnalyticsExpert = { name: string; calls: number; contracts: number; conversion: number | null; channelCalls?: Record<string, number>; channelContracts?: Record<string, number> };
type AnalyticsRoute = { name: string; calls: number; contracts: number; channelCalls?: Record<string, number>; channelContracts?: Record<string, number> };
type HoverState = { chart: string; index: number } | null;
type LegendEntry = { label: string; color: string; dashed?: boolean; muted?: boolean };
type TreemapItem = { name: string; value: number; color: string };
type TreemapRect = TreemapItem & { x: number; y: number; width: number; height: number };

type Props = {
  title: string;
  startDate: string;
  endDate: string;
  dailyCounts: RangeAnalyticsDailyPoint[];
  dailyChannelCounts: Record<string, Record<string, number>>;
  dailyChannelContracts: Record<string, Record<string, number>>;
  channels: RangeAnalyticsChannel[];
  costs: Record<string, CostMetric>;
  dailyCosts?: Record<string, number | null>;
  previousDailyCosts?: Record<string, number | null>;
  routes: AnalyticsRoute[];
  experts: AnalyticsExpert[];
  selectedChannelFilter: string | null;
  selectedFilterLabel: string | null;
  formatDate: (date: string) => string;
  onChannelFilter: (channel: string | null) => void;
  onBucketSelect: (startDate: string, endDate: string) => void;
  onResetSelection: () => void;
};

const W = 820;
const H = 252;
const LEFT = 52;
const RIGHT = 24;
const TOP = 28;
const BOTTOM = 42;
const PLOT_W = W - LEFT - RIGHT;
const PLOT_H = H - TOP - BOTTOM;
const TIME_CHARTS = new Set(["trend", "share", "volume", "dailyCost"]);
// The three management trend charts requested in the reference layout get a full row;
// the channel, cost, route, and expert comparisons remain in the two-column grid.
const FULL_WIDTH_CHART_IDS = new Set(["range-conversion", "range-trend", "range-average"]);
const PALETTE: Record<string, string> = {
  teal: "#39c4b3",
  blue: "#73b9ff",
  gold: "#f5b83e",
  coral: "#f27671",
  violet: "#c9a7ff",
  warning: "#e7a74d",
  indigo: "#9b8cff",
  magenta: "#ee82c5",
  cyan: "#61d9e6",
  orange: "#f39a58",
  lime: "#a8d96a",
  plum: "#c295e8",
  sky: "#65b9ee",
  rose: "#ef8c9f",
};
const WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه"];

function chartColor(color: string | undefined, fallback = "#73b9ff") {
  return PALETTE[color || ""] || (color?.startsWith("#") ? color : fallback);
}

function maxValue(values: number[]) {
  return Math.max(1, ...values.filter(Number.isFinite));
}

function finiteOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableMetric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Converts persisted/API values to the exact small shape this SVG layer renders. */
function normalizeChannels(value: unknown): RangeAnalyticsChannel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((channel, index) => ({
    name: String(channel.name || `کانال ${index + 1}`),
    color: String(channel.color || "blue"),
    keys: Array.isArray(channel.keys) ? channel.keys.map(key => String(key)) : [],
  }));
}

function normalizeRoutes(value: unknown): AnalyticsRoute[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((route, index) => ({
    name: String(route.name || `مسیر ${index + 1}`),
    calls: finiteOrZero(route.calls),
    contracts: finiteOrZero(route.contracts),
    channelCalls: isObject(route.channelCalls) ? Object.fromEntries(Object.entries(route.channelCalls).map(([key, item]) => [key, finiteOrZero(item)])) : {},
    channelContracts: isObject(route.channelContracts) ? Object.fromEntries(Object.entries(route.channelContracts).map(([key, item]) => [key, finiteOrZero(item)])) : {},
  }));
}

function normalizeExperts(value: unknown): AnalyticsExpert[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((expert, index) => ({
    name: String(expert.name || `کارشناس ${index + 1}`),
    calls: finiteOrZero(expert.calls),
    contracts: finiteOrZero(expert.contracts),
    conversion: nullableMetric(expert.conversion),
    channelCalls: isObject(expert.channelCalls) ? Object.fromEntries(Object.entries(expert.channelCalls).map(([key, item]) => [key, finiteOrZero(item)])) : {},
    channelContracts: isObject(expert.channelContracts) ? Object.fromEntries(Object.entries(expert.channelContracts).map(([key, item]) => [key, finiteOrZero(item)])) : {},
  }));
}

function normalizeCosts(value: unknown): Record<string, CostMetric> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, metric]) => isObject(metric)).map(([name, rawMetric]) => {
    const metric = rawMetric as Record<string, unknown>;
    return [name, {
    costToman: nullableMetric(metric.costToman),
    leads: finiteOrZero(metric.leads),
    contracts: finiteOrZero(metric.contracts),
    cpl: nullableMetric(metric.cpl),
    cac: nullableMetric(metric.cac),
  }];
  }));
}

function xFor(index: number, count: number) {
  return count <= 1 ? LEFT + PLOT_W / 2 : LEFT + (index / (count - 1)) * PLOT_W;
}

function yFor(value: number, maximum: number) {
  return TOP + PLOT_H - (Math.max(0, value) / maximum) * PLOT_H;
}

function pointsFor(values: number[], maximum: number) {
  return values.map((value, index) => `${xFor(index, values.length)},${yFor(value, maximum)}`).join(" ");
}

function axisLabelStep(count: number) {
  if (count <= 31) return 1;
  if (count <= 60) return 4;
  return Math.max(1, Math.ceil(count / 12));
}

/** Keeps every value exact in the accessible label/hover while making SVG labels collision-resistant. */
function compactChartValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function valueLabelStep(count: number) {
  if (count <= 10) return 1;
  if (count <= 20) return 2;
  if (count <= 31) return 4;
  if (count <= 60) return 6;
  return Math.max(1, Math.ceil(count / 10));
}

function shortChartLabel(value: string, maxLength = 11) {
  const normalized = value.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function dayNumber(date: string) {
  return Number(date.split("/").pop() || 0);
}

function bucketAxisLabel(bucket: RangeAnalyticsBucket) {
  const start = dayNumber(bucket.startDate).toLocaleString("en-US");
  if (bucket.startDate === bucket.endDate) return start;
  return `${start}–${dayNumber(bucket.endDate).toLocaleString("en-US")}`;
}

function formatMetric(value: number | null, digits = 0) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function SvgTitle({ children }: { children: ReactNode }) {
  const text = Array.isArray(children) ? children.join("") : children;
  // `title` creates a browser-native black tooltip that covers the chart and is
  // inconsistent across desktop/mobile. The visible hover strip is the single
  // predictable tooltip surface; `desc` keeps the SVG content accessible.
  return <desc>{text}</desc>;
}

function ChartFrame({
  id,
  title,
  description,
  children,
  hoverText,
  legend = [],
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
  hoverText?: string;
  legend?: LegendEntry[];
}) {
  return <article className={`rangeAnalyticsCard rangeAnalyticsCard-${id} ${FULL_WIDTH_CHART_IDS.has(id) ? "rangeAnalyticsFullWidth" : ""}`} aria-labelledby={`${id}-title`}>
    <header><div><strong id={`${id}-title`}>{title}</strong><small>{description}</small></div></header>
    {hoverText && <div className="rangeAnalyticsHover" role="status"><i aria-hidden="true">●</i><span>{hoverText}</span></div>}
    {legend.length > 0 && <div className="rangeAnalyticsChartLegend" aria-label={`راهنمای ${title}`}>{legend.map(entry => <span key={entry.label}><i className={`${entry.dashed ? "dashed" : ""} ${entry.muted ? "muted" : ""}`} style={{ background: entry.dashed ? "transparent" : entry.color, borderColor: entry.color }}/>{entry.label}</span>)}</div>}
    <div className="rangeAnalyticsViewport">{children}</div>
  </article>;
}

function GridLines() {
  return <>{[0, .25, .5, .75, 1].map(level => <line className="rangeAnalyticsGridLine" x1={LEFT} x2={W - RIGHT} y1={yFor(level, 1)} y2={yFor(level, 1)} key={level}/>)}</>;
}

function BucketAxis({ buckets, formatDate = date => date }: { buckets: RangeAnalyticsBucket[]; formatDate?: (date: string) => string }) {
  const step = axisLabelStep(buckets.length);
  return <>{buckets.map((bucket, index) => index % step === 0 || index === buckets.length - 1 ? <text className="rangeAnalyticsAxis" x={xFor(index, buckets.length)} y={H - 8} aria-label={formatDate(bucket.startDate)} key={bucket.key}>{bucketAxisLabel(bucket)}</text> : null)}</>;
}

function channelHoverLabel(bucket: RangeAnalyticsBucket, formatDate: (date: string) => string, visibleChannels: RangeAnalyticsChannel[]) {
  const entries = visibleChannels
    .map(channel => [channel.name, bucket.channelValues[channel.name] || 0] as const)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, value]) => `${name} ${value.toLocaleString("en-US")}`);
  const remaining = visibleChannels.filter(channel => (bucket.channelValues[channel.name] || 0) > 0).length - entries.length;
  return `${formatRangeBucketLabel(bucket, formatDate)} · ${entries.join("، ") || "بدون ورودی"}${remaining > 0 ? ` و ${remaining.toLocaleString("en-US")} کانال دیگر` : ""}`;
}

/** Creates a deterministic slice-and-dice treemap without a charting dependency. */
function layoutTreemap(items: TreemapItem[], x: number, y: number, width: number, height: number): TreemapRect[] {
  const sorted = items.filter(item => item.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "fa"));
  const layout = (entries: TreemapItem[], left: number, top: number, boxWidth: number, boxHeight: number): TreemapRect[] => {
    if (!entries.length || boxWidth <= 0 || boxHeight <= 0) return [];
    if (entries.length === 1) return [{ ...entries[0], x: left, y: top, width: boxWidth, height: boxHeight }];
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    let running = 0;
    let split = 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    entries.forEach((entry, index) => {
      if (index === entries.length - 1) return;
      running += entry.value;
      const distance = Math.abs(total / 2 - running);
      if (distance < bestDistance) { bestDistance = distance; split = index + 1; }
    });
    const first = entries.slice(0, split);
    const second = entries.slice(split);
    const firstTotal = first.reduce((sum, entry) => sum + entry.value, 0);
    if (boxWidth >= boxHeight) {
      const firstWidth = boxWidth * firstTotal / total;
      return [...layout(first, left, top, firstWidth, boxHeight), ...layout(second, left + firstWidth, top, boxWidth - firstWidth, boxHeight)];
    }
    const firstHeight = boxHeight * firstTotal / total;
    return [...layout(first, left, top, boxWidth, firstHeight), ...layout(second, left, top + firstHeight, boxWidth, boxHeight - firstHeight)];
  };
  return layout(sorted, x, y, width, height);
}

function BucketInteraction({ bucket, index, buckets, chart, onHover, onLeave, onSelect, formatDate, value = bucket.value, contractsValue = bucket.contracts, children }: {
  bucket: RangeAnalyticsBucket;
  index: number;
  buckets: RangeAnalyticsBucket[];
  chart: string;
  onHover: (chart: string, index: number) => void;
  onLeave: () => void;
  onSelect: (start: string, end: string) => void;
  formatDate: (date: string) => string;
  value?: number;
  contractsValue?: number;
  children: ReactNode;
}) {
  return <g className="rangeAnalyticsInteractive" tabIndex={0} role="button" aria-label={`${formatRangeBucketLabel(bucket, formatDate)}، ${bucket.days} روز؛ برای نمایش همین بازه کلیک کنید`} onMouseEnter={() => onHover(chart, index)} onFocus={() => onHover(chart, index)} onMouseLeave={onLeave} onBlur={onLeave} onClick={() => onSelect(bucket.startDate, bucket.endDate)}>{children}<SvgTitle>{`${formatRangeBucketLabel(bucket, formatDate)} · ${bucket.days} روز · ${buckets.length.toLocaleString("en-US")} نقطه در نمودار · ${value.toLocaleString("en-US")} لید · ${contractsValue.toLocaleString("en-US")} قرارداد`}</SvgTitle></g>;
}

export function RangeAnalyticsDashboard({ title, startDate, endDate, dailyCounts, dailyChannelCounts, dailyChannelContracts, channels, costs, dailyCosts = {}, previousDailyCosts = {}, routes, experts, selectedChannelFilter, selectedFilterLabel, formatDate = date => date, onBucketSelect, onResetSelection = () => {} }: Props) {
  const [hovered, setHovered] = useState<HoverState>(null);
  const [chartChannelFilters, setChartChannelFilters] = useState<string[]>(selectedChannelFilter ? [selectedChannelFilter] : []);
  // Keep this presentation layer defensive: persisted/API payloads can be incomplete at refresh time.
  const safeDailyCounts = useMemo(() => Array.isArray(dailyCounts) ? dailyCounts.filter(Boolean).map(day => ({
    date: String(day?.date || ""),
    value: finiteOrZero(day?.value),
    contracts: finiteOrZero(day?.contracts),
    weekday: String(day?.weekday || ""),
  })) : [], [dailyCounts]);
  const safeChannels = useMemo(() => normalizeChannels(channels), [channels]);
  const safeCosts = useMemo(() => normalizeCosts(costs), [costs]);
  const safeRoutes = useMemo(() => normalizeRoutes(routes), [routes]);
  const safeExperts = useMemo(() => normalizeExperts(experts), [experts]);
  const { plan, buckets } = useMemo(() => buildRangeAnalyticsBuckets(safeDailyCounts, dailyChannelCounts, dailyChannelContracts, safeChannels), [safeDailyCounts, dailyChannelCounts, dailyChannelContracts, safeChannels]);
  const activeChannelNames = useMemo(() => new Set(safeChannels
    .filter(channel => chartChannelFilters.some(filter => channel.name === filter || channel.keys.includes(filter) || channel.name === selectedFilterLabel))
    .map(channel => channel.name)), [chartChannelFilters, safeChannels, selectedFilterLabel]);
  const hasChartChannelFilter = chartChannelFilters.length > 0 && activeChannelNames.size > 0;
  const channelIsActive = (channel: RangeAnalyticsChannel) => !hasChartChannelFilter || activeChannelNames.has(channel.name);
  const selectedChannels = safeChannels.filter(channel => channelIsActive(channel));
  const leads = buckets.map(bucket => hasChartChannelFilter
    ? selectedChannels.reduce((sum, channel) => sum + (bucket.channelValues[channel.name] || 0), 0)
    : bucket.value);
  const contracts = buckets.map(bucket => hasChartChannelFilter
    ? selectedChannels.reduce((sum, channel) => sum + (bucket.channelContracts[channel.name] || 0), 0)
    : bucket.contracts);
  const maxLeads = maxValue(leads);
  const maxContracts = maxValue(contracts);
  const maxChannelVolume = maxValue(buckets.map(bucket => safeChannels.reduce((sum, channel) => sum + (bucket.channelValues[channel.name] || 0), 0)));
  const average = leads.length ? leads.reduce((sum, value) => sum + value, 0) / leads.length : 0;
  const hoverBucket = hovered && TIME_CHARTS.has(hovered.chart) ? buckets[hovered.index] : undefined;
  const hoverText = hoverBucket && hovered ? `${formatRangeBucketLabel(hoverBucket, formatDate)} · ${hoverBucket.days} روز · ${hoverBucket.value.toLocaleString("en-US")} لید · ${hoverBucket.contracts.toLocaleString("en-US")} قرارداد` : undefined;
  const costRows = safeChannels.map(channel => ({ channel, metric: safeCosts?.[channel.name] })).filter(row => row.metric);
  const maxCpl = maxValue(costRows.map(row => row.metric?.cpl || 0));
  const maxCac = maxValue(costRows.map(row => row.metric?.cac || 0));
  const costValues = buckets.map(bucket => nullableMetric(dailyCosts[bucket.startDate]) ?? 0);
  const previousCostValues = buckets.map(bucket => {
    const dates = Object.keys(previousDailyCosts).sort();
    const index = buckets.indexOf(bucket);
    return nullableMetric(previousDailyCosts[dates[index] || ""]) ?? 0;
  });
  const maxDailyCost = maxValue([...costValues, ...previousCostValues]);
  const channelKeyIsActive = (key: string) => selectedChannels.some(channel => channel.name === key || channel.keys.includes(key));
  const activeMetric = (fallback: number, values?: Record<string, number>) => hasChartChannelFilter && values
    ? Object.entries(values).filter(([key]) => channelKeyIsActive(key)).reduce((sum, [, value]) => sum + finiteOrZero(value), 0)
    : fallback;
  const topRoutes = safeRoutes.map(route => ({ ...route, calls: activeMetric(route.calls, route.channelCalls), contracts: activeMetric(route.contracts, route.channelContracts) }));
  const maxRouteCalls = maxValue(topRoutes.map(route => route.calls));
  const maxRouteContracts = maxValue(topRoutes.map(route => route.contracts));
  const topExperts = safeExperts.filter(expert => expert.name !== "کارشناس ثبت نشده").map(expert => ({ ...expert, calls: activeMetric(expert.calls, expert.channelCalls), contracts: activeMetric(expert.contracts, expert.channelContracts), conversion: expert.calls > 0 ? activeMetric(expert.contracts, expert.channelContracts) / activeMetric(expert.calls, expert.channelCalls) * 100 : null }));
  const maxExpertCalls = maxValue(topExperts.map(expert => expert.calls));
  const maxExpertContracts = maxValue(topExperts.map(expert => expert.contracts));
  const channelTotals = safeChannels.map(channel => ({
    ...channel,
    value: buckets.reduce((sum, bucket) => sum + (bucket.channelValues[channel.name] || 0), 0),
  }));
  const channelTotal = channelTotals.reduce((sum, channel) => sum + channel.value, 0);
  const donutCircumference = 2 * Math.PI * 78;
  const donutSegments = channelTotals.reduce<Array<{ name: string; color: string; value: number; percentage: number; dashOffset: number; dashLength: number }>>((segments, channel) => {
    const percentage = channelTotal > 0 ? channel.value / channelTotal : 0;
    const previous = segments.length ? segments[segments.length - 1] : undefined;
    const dashOffset = previous ? previous.dashOffset - previous.dashLength : 0;
    segments.push({ name: channel.name, color: chartColor(channel.color), value: channel.value, percentage, dashOffset, dashLength: percentage * donutCircumference });
    return segments;
  }, []);
  const heatmapCells = safeChannels.flatMap((channel, channelIndex) => buckets.map((bucket, bucketIndex) => ({
    channel,
    channelIndex,
    bucket,
    bucketIndex,
    value: bucket.channelValues[channel.name] || 0,
  })));
  const maxHeatmapValue = maxValue(heatmapCells.map(cell => cell.value));
  const heatmapCellWidth = PLOT_W / Math.max(1, buckets.length);
  const heatmapRowHeight = PLOT_H / Math.max(1, safeChannels.length);
  const bubbleItems = topRoutes.filter(route => route.calls > 0).map((route, index) => ({
    ...route,
    conversion: route.calls > 0 ? route.contracts / route.calls * 100 : 0,
    color: ["#39c4b3", "#f5b83e", "#73b9ff", "#c9a7ff", "#f27671", "#61d9e6", "#a8d96a", "#ee82c5"][index % 8],
  }));
  const maxBubbleCalls = maxValue(bubbleItems.map(item => item.calls));
  const maxBubbleConversion = maxValue(bubbleItems.map(item => item.conversion));
  const treemapRects = layoutTreemap(channelTotals.map(channel => ({ name: channel.name, value: channel.value, color: chartColor(channel.color) })), LEFT, TOP, PLOT_W, PLOT_H);
  const waterfallItems = costRows.flatMap(row => typeof row.metric?.costToman === "number" && Number.isFinite(row.metric.costToman) ? [{ name: row.channel.name, value: row.metric.costToman, contracts: row.metric.contracts, color: chartColor(row.channel.color) }] : []);
  const waterfallTotal = waterfallItems.reduce((sum, item) => sum + item.value, 0);
  const waterfallBars = [...waterfallItems.reduce<Array<typeof waterfallItems[number] & { start: number; end: number; total: boolean }>>((bars, item) => {
    const start = bars.length ? bars[bars.length - 1].end : 0;
    bars.push({ ...item, start, end: start + item.value, total: false });
    return bars;
  }, []), ...(waterfallTotal > 0 ? [{ name: "جمع هزینه", value: waterfallTotal, contracts: waterfallItems.reduce((sum, item) => sum + item.contracts, 0), color: "#f5b83e", start: 0, end: waterfallTotal, total: true }] : [])];
  const maxWaterfall = maxValue(waterfallBars.map(item => item.end));
  const hoveredCost = hovered && (hovered.chart === "cost" || hovered.chart === "conversion") ? costRows[hovered.index] : undefined;
  const hoveredRoute = hovered?.chart === "routes" ? topRoutes[hovered.index] : undefined;
  const hoveredExpert = hovered?.chart === "experts" ? topExperts[hovered.index] : undefined;
  const hoveredHeatmap = hovered?.chart === "heatmap" ? heatmapCells[hovered.index] : undefined;
  const hoveredBubble = hovered?.chart === "bubble" ? bubbleItems[hovered.index] : undefined;
  const hoveredTreemap = hovered?.chart === "treemap" ? treemapRects[hovered.index] : undefined;
  const hoveredWaterfall = hovered?.chart === "waterfall" ? waterfallBars[hovered.index] : undefined;
  const trendBarWidth = Math.min(24, Math.max(3, PLOT_W / Math.max(1, buckets.length) * .58));
  const cplValues = costRows.map(row => row.metric?.cpl ?? 0);
  const cacValues = costRows.map(row => row.metric?.cac ?? 0);
  const maxCplCac = maxValue([...cplValues, ...cacValues]);
  const weekdayMatrix = WEEKDAYS.flatMap(weekday => safeChannels.map(channel => {
    const days = safeDailyCounts.filter(day => day.weekday === weekday);
    const total = days.reduce((sum, day) => sum + Object.entries(dailyChannelCounts[day.date] || {})
      .filter(([key]) => key === channel.name || channel.keys.includes(key))
      .reduce((inner, [, value]) => inner + finiteOrZero(value), 0), 0);
    return { weekday, channel, days: days.length, value: safeDailyCounts.length > 31 && days.length ? total / days.length : total };
  }));
  const maxWeekdayValue = maxValue(weekdayMatrix.map(cell => cell.value));
  const matrixAverageMode = safeDailyCounts.length > 31;
  const hoveredWeekday = hovered?.chart === "weekdayMatrix" ? weekdayMatrix[hovered.index] : undefined;
  const detailedHoverText = (() => {
    if (hoveredHeatmap) return `${formatRangeBucketLabel(hoveredHeatmap.bucket, formatDate)} · ${hoveredHeatmap.channel.name}: ${hoveredHeatmap.value.toLocaleString("en-US")} لید`;
    if (hoveredWeekday) return `${hoveredWeekday.weekday} · ${hoveredWeekday.channel.name}: ${formatMetric(hoveredWeekday.value, 1)} لید${matrixAverageMode ? ` · ${hoveredWeekday.days} وقوع` : ""}`;
    if (hoveredBubble) return `${hoveredBubble.name} · ${hoveredBubble.calls.toLocaleString("en-US")} تماس · ${hoveredBubble.contracts.toLocaleString("en-US")} قرارداد · نرخ ${formatMetric(hoveredBubble.conversion, 2)}%`;
    if (hoveredTreemap) return `${hoveredTreemap.name} · ${hoveredTreemap.value.toLocaleString("en-US")} لید · ${channelTotal > 0 ? formatMetric(hoveredTreemap.value / channelTotal * 100, 1) : "0"}% سهم`;
    if (hoveredWaterfall) return `${hoveredWaterfall.name} · ${formatMetric(hoveredWaterfall.value)} تومان · ${hoveredWaterfall.contracts.toLocaleString("en-US")} قرارداد`;
    if (hoverBucket && hovered) {
      if (hovered.chart === "trend") return `${formatRangeBucketLabel(hoverBucket, formatDate)} · لید ${hoverBucket.value.toLocaleString("en-US")} · قرارداد ${hoverBucket.contracts.toLocaleString("en-US")}`;
      if (hovered.chart === "dailyCost") return `${formatRangeBucketLabel(hoverBucket, formatDate)} · هزینه ${formatMetric(costValues[hovered.index])} تومان · مقایسه بازه قبل ${formatMetric(previousCostValues[hovered.index])} تومان`;
      if (hovered.chart === "share" || hovered.chart === "volume") return channelHoverLabel(hoverBucket, formatDate, safeChannels);
      return hoverText;
    }
    if (hoveredCost) return `${hoveredCost.channel.name} · CPL ${formatMetric(hoveredCost.metric?.cpl)} تومان · CAC ${formatMetric(hoveredCost.metric?.cac)} تومان`;
    if (hoveredRoute) return `${hoveredRoute.name} · ${hoveredRoute.calls.toLocaleString("en-US")} تماس · ${hoveredRoute.contracts.toLocaleString("en-US")} قرارداد`;
    if (hoveredExpert) return `${hoveredExpert.name} · ${hoveredExpert.calls.toLocaleString("en-US")} تماس · ${hoveredExpert.contracts.toLocaleString("en-US")} قرارداد · نرخ ${formatMetric(hoveredExpert.conversion, 2)}%`;
    return undefined;
  })();
  const selectedDescription = selectedFilterLabel ? ` · فیلتر ${selectedFilterLabel}` : "";

  return <section className="rangeAnalytics" aria-label={`تحلیل نموداری ${title}`}>
    <header className="rangeAnalyticsHeader"><div><span>تحلیل تعاملی بازه</span><h3>{title}{selectedDescription}</h3><p>تا 60 روز با نقاط روزانه نمایش داده می‌شود؛ بیشتر از آن به‌صورت خودکار در بازه‌های چندروزه جمع می‌شود. روی هر نقطه یا میله نگه دارید تا نام شاخص و عدد دقیق را ببینید؛ با کلیک روی نقطهٔ زمانی، همان بازه در گزارش‌های پایین انتخاب می‌شود.</p><div className="rangeAnalyticsGuide" role="note"><span>راهنما: رنگ هر خط/میله در لجند همان نمودار مشخص شده است؛ عددهای زیر نمودار، روز یا بازهٔ روزهای هر نود را نشان می‌دهند.</span><button type="button" onClick={() => { setChartChannelFilters([]); onResetSelection(); }}>↺ بازنشانی بازه و فیلتر</button></div></div><b>{plan.label} · {safeDailyCounts.length.toLocaleString("en-US")} روز</b></header>
    <div className="rangeAnalyticsLegend" aria-label="فیلتر چندانتخابی کانال‌های ورودی">{safeChannels.map(channel => { const isActive = channelIsActive(channel); const isSelected = hasChartChannelFilter && isActive; return <button type="button" className={isSelected ? "selected" : hasChartChannelFilter ? "muted" : ""} aria-pressed={isSelected} onClick={() => setChartChannelFilters(current => current.includes(channel.name) ? current.filter(name => name !== channel.name) : [...current, channel.name])} title={isSelected ? "کلیک برای حذف این کانال از انتخاب" : "کلیک برای افزودن این کانال به انتخاب چندگانه"} key={channel.name}><i style={{ background: chartColor(channel.color) }}/>{channel.name}</button>; })}<button type="button" className="rangeAnalyticsLegendReset" onClick={() => setChartChannelFilters([])} disabled={!hasChartChannelFilter}>همه کانال‌ها</button></div>
    <div className="rangeAnalyticsGrid">
      <ChartFrame id="range-trend" title="روند روزانه لید و قرارداد" description={`لیدها به‌صورت میله‌ای و قراردادها به‌صورت خطی نمایش داده می‌شوند؛ میانگین هر نقطه ${average.toLocaleString("en-US", { maximumFractionDigits: 1 })} لید است.`} hoverText={hovered?.chart === "trend" ? detailedHoverText : undefined} legend={[{ label: "لید", color: "#39c4b3" }, { label: "قرارداد", color: "#f5b83e", dashed: true }]}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="روند لید و قرارداد در بازه انتخابی"><GridLines/><polyline className="rangeAnalyticsLine contract" points={pointsFor(contracts, maxContracts)}/>{buckets.map((bucket, index) => <BucketInteraction bucket={bucket} index={index} buckets={buckets} chart="trend" value={leads[index]} contractsValue={contracts[index]} onHover={(chart, pointIndex) => setHovered({ chart, index: pointIndex })} onLeave={() => setHovered(null)} onSelect={onBucketSelect} formatDate={formatDate} key={bucket.key}><rect className="rangeAnalyticsBar leadBar" x={xFor(index, buckets.length) - trendBarWidth / 2} y={yFor(leads[index], maxLeads)} width={trendBarWidth} height={TOP + PLOT_H - yFor(leads[index], maxLeads)} fill="#39c4b3" opacity={.82}/><circle className="rangeAnalyticsPoint contract" cx={xFor(index, buckets.length)} cy={yFor(contracts[index], maxContracts)} r={hovered?.chart === "trend" && hovered.index === index ? 4.5 : 3}/>{(index % valueLabelStep(buckets.length) === 0 || hovered?.chart === "trend" && hovered.index === index) && <><text className="rangeAnalyticsValue lead" x={xFor(index, buckets.length)} y={Math.max(TOP + 10, yFor(leads[index], maxLeads) - 6)}>{compactChartValue(leads[index])}</text><text className="rangeAnalyticsValue contract" x={xFor(index, buckets.length)} y={Math.max(TOP + 10, yFor(contracts[index], maxContracts) - 8)}>{compactChartValue(contracts[index])}</text></>}</BucketInteraction>) }<BucketAxis buckets={buckets} formatDate={formatDate}/></svg>
      </ChartFrame>

      <ChartFrame id="range-conversion" title="CPL خطی و CAC میله‌ای" description="CPL هزینهٔ هر لید و CAC هزینهٔ هر قرارداد قابل انتساب است؛ برچسب کوتاه روی نمودار و عدد دقیق در راهنمای hover دیده می‌شود." hoverText={hovered?.chart === "conversion" ? detailedHoverText : undefined} legend={[{ label: "CPL خطی", color: "#61d9e6" }, { label: "CAC میله‌ای", color: "#f39a58" }]}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="CPL خطی و CAC میله‌ای به تفکیک کانال"><GridLines/><polyline className="rangeAnalyticsLine cplLine" points={pointsFor(cplValues, maxCplCac)}/>{costRows.map((row, index) => { const center = xFor(index, costRows.length); const barWidth = Math.min(34, Math.max(7, PLOT_W / Math.max(1, costRows.length) * .46)); const active = channelIsActive(row.channel); return <g className="rangeAnalyticsInteractive" key={row.channel.name} tabIndex={0} role="img" aria-label={`${row.channel.name}: CPL ${formatMetric(row.metric?.cpl)} تومان، CAC ${formatMetric(row.metric?.cac)} تومان`} onMouseEnter={() => setHovered({ chart: "conversion", index })} onFocus={() => setHovered({ chart: "conversion", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><rect className="rangeAnalyticsBar cacBar" x={center - barWidth / 2} y={yFor(cacValues[index], maxCplCac)} width={barWidth} height={TOP + PLOT_H - yFor(cacValues[index], maxCplCac)} fill="#f39a58" opacity={active ? .72 : .14}/><circle className="rangeAnalyticsPoint cplPoint" cx={center} cy={yFor(cplValues[index], maxCplCac)} r={hovered?.chart === "conversion" && hovered.index === index ? 5 : 3.5} opacity={active ? 1 : .18}/>{(index % valueLabelStep(costRows.length) === 0 || hovered?.chart === "conversion" && hovered.index === index) && <><text className="rangeAnalyticsValue cpl" x={center} y={Math.max(TOP + 10, yFor(cplValues[index], maxCplCac) - 8)}>{compactChartValue(row.metric?.cpl)}</text><text className="rangeAnalyticsValue cac" x={center} y={Math.max(TOP + 10, yFor(cacValues[index], maxCplCac) - 8)}>{compactChartValue(row.metric?.cac)}</text></>}<text className="rangeAnalyticsAxis" x={center} y={H - 8}>{shortChartLabel(row.channel.name)}</text><SvgTitle>{row.channel.name} · CPL {formatMetric(row.metric?.cpl)} تومان · CAC {formatMetric(row.metric?.cac)} تومان</SvgTitle></g>; })}</svg>
      </ChartFrame>

      <ChartFrame id="range-share" title="سهم کانال‌ها در هر بازه" description="هر ستون 100% است؛ انتخاب چند کانال فقط سری‌های انتخاب‌شده را برجسته می‌کند." hoverText={hovered?.chart === "share" ? detailedHoverText : undefined} legend={safeChannels.map(channel => ({ label: channel.name, color: chartColor(channel.color), muted: !channelIsActive(channel) }))}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="سهم کانال‌ها در بازه‌های انتخابی"><GridLines/>{buckets.map((bucket, index) => { const total = safeChannels.reduce((sum, channel) => sum + (bucket.channelValues[channel.name] || 0), 0); let offset = 0; return <BucketInteraction bucket={bucket} index={index} buckets={buckets} chart="share" onHover={(chart, pointIndex) => setHovered({ chart, index: pointIndex })} onLeave={() => setHovered(null)} onSelect={onBucketSelect} formatDate={formatDate} key={bucket.key}>{safeChannels.map(channel => { const value = bucket.channelValues[channel.name] || 0; const height = total ? value / total * PLOT_H : 0; const y = TOP + PLOT_H - offset - height; offset += height; return <rect className="rangeAnalyticsStack" x={xFor(index, buckets.length) - Math.max(2, Math.min(16, PLOT_W / Math.max(1, buckets.length) / 2))} y={y} width={Math.max(4, Math.min(32, PLOT_W / Math.max(1, buckets.length) * .62))} height={height} fill={chartColor(channel.color)} opacity={channelIsActive(channel) ? (hovered?.chart === "share" && hovered.index === index ? 1 : .82) : .16} key={channel.name}/>; })}</BucketInteraction>; })}<BucketAxis buckets={buckets} formatDate={formatDate}/></svg>
      </ChartFrame>

      <ChartFrame id="range-volume" title="حجم ورودی به تفکیک کانال" description="تعداد واقعی لیدها را نشان می‌دهد؛ کانال‌های انتخاب‌نشده برای مقایسه کم‌رنگ می‌مانند." hoverText={hovered?.chart === "volume" ? detailedHoverText : undefined} legend={safeChannels.map(channel => ({ label: channel.name, color: chartColor(channel.color), muted: !channelIsActive(channel) }))}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="حجم ورودی به تفکیک کانال"><GridLines/>{buckets.map((bucket, index) => { let offset = 0; return <BucketInteraction bucket={bucket} index={index} buckets={buckets} chart="volume" onHover={(chart, pointIndex) => setHovered({ chart, index: pointIndex })} onLeave={() => setHovered(null)} onSelect={onBucketSelect} formatDate={formatDate} key={bucket.key}>{safeChannels.map(channel => { const value = bucket.channelValues[channel.name] || 0; const height = value / maxChannelVolume * PLOT_H; const y = TOP + PLOT_H - offset - height; offset += height; return <rect className="rangeAnalyticsStack" x={xFor(index, buckets.length) - Math.max(2, Math.min(16, PLOT_W / Math.max(1, buckets.length) / 2))} y={y} width={Math.max(4, Math.min(32, PLOT_W / Math.max(1, buckets.length) * .62))} height={height} fill={chartColor(channel.color)} opacity={channelIsActive(channel) ? (hovered?.chart === "volume" && hovered.index === index ? 1 : .82) : .16} key={channel.name}/>; })}</BucketInteraction>; })}<BucketAxis buckets={buckets} formatDate={formatDate}/></svg>
      </ChartFrame>

      <ChartFrame id="range-average" title="هزینه روزانه و مقایسه با بازه قبل" description="خط پررنگ هزینهٔ روزانه/تجمیعی بازهٔ انتخابی و خط کم‌رنگ همان روزهای بازهٔ متناظر قبلی را نشان می‌دهد." hoverText={hovered?.chart === "dailyCost" ? detailedHoverText : undefined} legend={[{ label: "هزینه بازه انتخابی", color: "#c9a7ff" }, { label: "بازهٔ متناظر قبل", color: "#73b9ff", muted: true }] }>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="هزینه روزانه و مقایسه با بازه متناظر قبلی"><GridLines/><polyline className="rangeAnalyticsLine previousCostLine mutedLine" points={pointsFor(previousCostValues, maxDailyCost)}/><polyline className="rangeAnalyticsLine costLine" points={pointsFor(costValues, maxDailyCost)}/>{buckets.map((bucket, index) => <BucketInteraction bucket={bucket} index={index} buckets={buckets} chart="dailyCost" onHover={(chart, pointIndex) => setHovered({ chart, index: pointIndex })} onLeave={() => setHovered(null)} onSelect={onBucketSelect} formatDate={formatDate} key={bucket.key}><circle className="rangeAnalyticsPoint costPoint" cx={xFor(index, buckets.length)} cy={yFor(costValues[index], maxDailyCost)} r={hovered?.chart === "dailyCost" && hovered.index === index ? 5 : 3}/>{(index % valueLabelStep(buckets.length) === 0 || hovered?.chart === "dailyCost" && hovered.index === index) && <text className="rangeAnalyticsValue cost" x={xFor(index, buckets.length)} y={Math.max(TOP + 10, yFor(costValues[index], maxDailyCost) - 8)}>{compactChartValue(dailyCosts[bucket.startDate])}</text>}</BucketInteraction>)}<BucketAxis buckets={buckets} formatDate={formatDate}/></svg>
      </ChartFrame>

      <ChartFrame id="range-cost" title="هزینه، CPL و CAC کانال‌ها" description="هزینه از داده مالی همان بازه می‌آید؛ نبود هزینه با خط تیره نمایش داده می‌شود." hoverText={hovered?.chart === "cost" ? detailedHoverText : undefined} legend={[{ label: "CPL", color: "#73b9ff" }, { label: "CAC", color: "#f5b83e" }, { label: "هزینه", color: "#c9a7ff" }] }>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="هزینه CPL و CAC کانال‌ها"><GridLines/>{costRows.map((row, index) => { const groupWidth = PLOT_W / Math.max(1, costRows.length); const center = LEFT + groupWidth * index + groupWidth / 2; const barWidth = Math.min(20, groupWidth * .24); const cpl = row.metric.cpl || 0; const cac = row.metric.cac || 0; const active = channelIsActive(row.channel); return <g className="rangeAnalyticsInteractive" key={row.channel.name} tabIndex={0} role="img" aria-label={`${row.channel.name}: هزینه ${formatMetric(row.metric.costToman)} تومان، CPL ${formatMetric(row.metric.cpl)} تومان، CAC ${formatMetric(row.metric.cac)} تومان`} onMouseEnter={() => setHovered({ chart: "cost", index })} onFocus={() => setHovered({ chart: "cost", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)} opacity={active ? 1 : .2}><rect className="rangeAnalyticsBar" x={center - barWidth - 2} y={yFor(cpl, maxCpl)} width={barWidth} height={TOP + PLOT_H - yFor(cpl, maxCpl)} fill="#73b9ff"><SvgTitle>{row.channel.name} · CPL {formatMetric(row.metric.cpl)} تومان</SvgTitle></rect><rect className="rangeAnalyticsBar" x={center + 2} y={yFor(cac, maxCac)} width={barWidth} height={TOP + PLOT_H - yFor(cac, maxCac)} fill="#f5b83e"><SvgTitle>{row.channel.name} · CAC {formatMetric(row.metric.cac)} تومان</SvgTitle></rect><text className="rangeAnalyticsValue cpl" x={center - barWidth / 2 - 2} y={Math.max(TOP + 10, yFor(cpl, maxCpl) - 7)}>{compactChartValue(row.metric.cpl)}</text><text className="rangeAnalyticsValue cac" x={center + barWidth / 2 + 2} y={Math.max(TOP + 10, yFor(cac, maxCac) - 7)}>{compactChartValue(row.metric.cac)}</text><text className="rangeAnalyticsAxis" x={center} y={H - 8}>{shortChartLabel(row.channel.name)}</text></g>; })}</svg>
      </ChartFrame>

      <ChartFrame id="range-routes" title="مسیرهای ورودی و قرارداد" description="مسیرها را بر اساس تعداد تماس و قرارداد قابل انتساب مقایسه می‌کند." hoverText={hovered?.chart === "routes" ? detailedHoverText : undefined} legend={[{ label: "تماس", color: "#39c4b3" }, { label: "قرارداد", color: "#f5b83e" }]}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="مقایسه مسیرهای ورودی و قرارداد"><GridLines/>{topRoutes.map((route, index) => { const groupWidth = PLOT_W / Math.max(1, topRoutes.length); const center = LEFT + groupWidth * index + groupWidth / 2; const barWidth = Math.min(24, groupWidth * .28); return <g className="rangeAnalyticsInteractive" key={route.name} tabIndex={0} role="img" aria-label={`${route.name}: ${route.calls.toLocaleString("en-US")} تماس، ${route.contracts.toLocaleString("en-US")} قرارداد`} onMouseEnter={() => setHovered({ chart: "routes", index })} onFocus={() => setHovered({ chart: "routes", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)} opacity={hasChartChannelFilter ? (route.calls > 0 ? 1 : .2) : 1}><rect className="rangeAnalyticsBar" x={center - barWidth - 2} y={yFor(route.calls, maxRouteCalls)} width={barWidth} height={TOP + PLOT_H - yFor(route.calls, maxRouteCalls)} fill="#39c4b3"><SvgTitle>{route.name} · {route.calls.toLocaleString("en-US")} تماس · {route.contracts.toLocaleString("en-US")} قرارداد</SvgTitle></rect><rect className="rangeAnalyticsBar" x={center + 2} y={yFor(route.contracts, maxRouteContracts)} width={barWidth} height={TOP + PLOT_H - yFor(route.contracts, maxRouteContracts)} fill="#f5b83e"><SvgTitle>{route.name} · {route.contracts.toLocaleString("en-US")} قرارداد</SvgTitle></rect><text className="rangeAnalyticsValue" x={center - barWidth / 2} y={Math.max(TOP + 10, yFor(route.calls, maxRouteCalls) - 7)}>{compactChartValue(route.calls)}</text><text className="rangeAnalyticsValue gold" x={center + barWidth / 2} y={Math.max(TOP + 10, yFor(route.contracts, maxRouteContracts) - 7)}>{compactChartValue(route.contracts)}</text><text className="rangeAnalyticsAxis" x={center} y={H - 8}>{shortChartLabel(route.name)}</text></g>; })}</svg>
      </ChartFrame>

      <ChartFrame id="range-experts" title="عملکرد کارشناسان" description="مقایسه تماس، قرارداد و نرخ تبدیل کارشناسان منتخب بازه." hoverText={hovered?.chart === "experts" ? detailedHoverText : undefined} legend={[{ label: "تماس", color: "#73b9ff" }, { label: "قرارداد", color: "#f5b83e" }]}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="عملکرد کارشناسان"><GridLines/>{topExperts.map((expert, index) => { const groupWidth = PLOT_W / Math.max(1, topExperts.length); const center = LEFT + groupWidth * index + groupWidth / 2; const barWidth = Math.min(24, groupWidth * .28); return <g className="rangeAnalyticsInteractive" key={expert.name} tabIndex={0} role="img" aria-label={`${expert.name}: ${expert.calls.toLocaleString("en-US")} تماس، ${expert.contracts.toLocaleString("en-US")} قرارداد، نرخ ${formatMetric(expert.conversion, 2)} درصد`} onMouseEnter={() => setHovered({ chart: "experts", index })} onFocus={() => setHovered({ chart: "experts", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><rect className="rangeAnalyticsBar" x={center - barWidth - 2} y={yFor(expert.calls, maxExpertCalls)} width={barWidth} height={TOP + PLOT_H - yFor(expert.calls, maxExpertCalls)} fill="#73b9ff"><SvgTitle>{expert.name} · {expert.calls.toLocaleString("en-US")} تماس · {expert.contracts.toLocaleString("en-US")} قرارداد</SvgTitle></rect><rect className="rangeAnalyticsBar" x={center + 2} y={yFor(expert.contracts, maxExpertContracts)} width={barWidth} height={TOP + PLOT_H - yFor(expert.contracts, maxExpertContracts)} fill="#f5b83e"><SvgTitle>{expert.name} · {expert.contracts.toLocaleString("en-US")} قرارداد · نرخ {formatMetric(expert.conversion, 2)}%</SvgTitle></rect><text className="rangeAnalyticsValue" x={center - barWidth / 2} y={Math.max(TOP + 10, yFor(expert.calls, maxExpertCalls) - 7)}>{compactChartValue(expert.calls)}</text><text className="rangeAnalyticsValue gold" x={center + barWidth / 2} y={Math.max(TOP + 10, yFor(expert.contracts, maxExpertContracts) - 7)}>{compactChartValue(expert.contracts)}</text><text className="rangeAnalyticsAxis" x={center} y={H - 8}>{shortChartLabel(expert.name)}</text></g>; })}</svg>
      </ChartFrame>

      <ChartFrame id="range-donut" title="ترکیب ورودی در بازه" description="سهم واقعی هر کانال از کل لیدهای همین بازه؛ برای تمرکز بودجه و محتوا." hoverText={hovered?.chart === "donut" ? detailedHoverText : undefined} legend={donutSegments.map(segment => ({ label: segment.name, color: segment.color }))}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="نمودار دونات ترکیب کانال‌ها"><circle className="rangeAnalyticsDonutTrack" cx={W / 2} cy={H / 2} r="78"/><g>{donutSegments.map((segment, index) => <circle className="rangeAnalyticsDonutSegment" key={segment.name} cx={W / 2} cy={H / 2} r="78" stroke={segment.color} strokeDasharray={`${segment.dashLength} ${donutCircumference - segment.dashLength}`} strokeDashoffset={segment.dashOffset} transform={`rotate(-90 ${W / 2} ${H / 2})`} tabIndex={0} role="img" aria-label={`${segment.name}: ${segment.value.toLocaleString("en-US")} لید، ${formatMetric(segment.percentage * 100, 1)} درصد`} onMouseEnter={() => setHovered({ chart: "donut", index })} onFocus={() => setHovered({ chart: "donut", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><SvgTitle>{segment.name} · {segment.value.toLocaleString("en-US")} لید · {formatMetric(segment.percentage * 100, 1)}%</SvgTitle></circle>)}</g><text className="rangeAnalyticsDonutTotal" x={W / 2} y={H / 2 - 2}>{channelTotal.toLocaleString("en-US")}</text><text className="rangeAnalyticsAxis" x={W / 2} y={H / 2 + 15}>کل لید بازه</text></svg>
      </ChartFrame>

      <ChartFrame id="range-heatmap" title="ماتریس بازه × کانال" description="شدت رنگ، حجم لید هر کانال را در هر روز یا بازهٔ تجمیعی نشان می‌دهد." hoverText={hovered?.chart === "heatmap" ? detailedHoverText : undefined} legend={safeChannels.map(channel => ({ label: channel.name, color: chartColor(channel.color), muted: !channelIsActive(channel) }))}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="ماتریس بازه‌ای کانال‌ها"><GridLines/>{safeChannels.map((channel, channelIndex) => <text className="rangeAnalyticsAxis rangeAnalyticsHeatmapLabel" x={LEFT - 6} y={TOP + channelIndex * heatmapRowHeight + heatmapRowHeight / 2 + 3} key={channel.name}>{channel.name}</text>)}{heatmapCells.map((cell, index) => { const opacity = channelIsActive(cell.channel) ? .16 + cell.value / maxHeatmapValue * .84 : .08; return <g className="rangeAnalyticsInteractive" key={`${cell.channel.name}-${cell.bucket.key}`} tabIndex={0} role="button" aria-label={`${cell.channel.name}، ${formatRangeBucketLabel(cell.bucket, formatDate)}: ${cell.value.toLocaleString("en-US")} لید`} onMouseEnter={() => setHovered({ chart: "heatmap", index })} onFocus={() => setHovered({ chart: "heatmap", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)} onClick={() => onBucketSelect(cell.bucket.startDate, cell.bucket.endDate)}><rect className="rangeAnalyticsHeatmapCell" x={LEFT + cell.bucketIndex * heatmapCellWidth} y={TOP + cell.channelIndex * heatmapRowHeight} width={Math.max(2, heatmapCellWidth - 1)} height={Math.max(6, heatmapRowHeight - 2)} fill={chartColor(cell.channel.color)} opacity={opacity}/><SvgTitle>{cell.channel.name} · {formatRangeBucketLabel(cell.bucket, formatDate)} · {cell.value.toLocaleString("en-US")} لید</SvgTitle></g>; })}<BucketAxis buckets={buckets} formatDate={formatDate}/></svg>
      </ChartFrame>

      <ChartFrame id="range-weekday-matrix" title="ماتریس روز هفته × کانال" description={`${matrixAverageMode ? "میانگین هر وقوع روز در بازهٔ طولانی" : "جمع لیدهای ثبت‌شده در بازه"}؛ شنبه تا پنجشنبه مقایسه می‌شود.`} hoverText={hovered?.chart === "weekdayMatrix" ? detailedHoverText : undefined} legend={safeChannels.map(channel => ({ label: channel.name, color: chartColor(channel.color), muted: !channelIsActive(channel) }))}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="ماتریس روزهای هفته و کانال‌های ورودی"><g>{safeChannels.map((channel, index) => <text className="rangeAnalyticsAxis" x={LEFT + (index + .5) * (PLOT_W / Math.max(1, safeChannels.length))} y={TOP - 5} textAnchor="middle" key={channel.name}>{channel.name}</text>)}</g>{WEEKDAYS.map((weekday, rowIndex) => <text className="rangeAnalyticsAxis rangeAnalyticsHeatmapLabel" x={LEFT - 6} y={TOP + (rowIndex + .5) * (PLOT_H / WEEKDAYS.length) + 3} textAnchor="end" key={weekday}>{weekday}</text>)}{weekdayMatrix.map((cell, index) => { const columnIndex = safeChannels.indexOf(cell.channel); const rowIndex = WEEKDAYS.indexOf(cell.weekday); const cellWidth = PLOT_W / Math.max(1, safeChannels.length); const cellHeight = PLOT_H / WEEKDAYS.length; const active = channelIsActive(cell.channel); return <g className="rangeAnalyticsInteractive" key={`${cell.weekday}-${cell.channel.name}`} tabIndex={0} role="img" aria-label={`${cell.weekday}، ${cell.channel.name}: ${formatMetric(cell.value, 1)} لید`} onMouseEnter={() => setHovered({ chart: "weekdayMatrix", index })} onFocus={() => setHovered({ chart: "weekdayMatrix", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><rect className="rangeAnalyticsHeatmapCell" x={LEFT + columnIndex * cellWidth + 1} y={TOP + rowIndex * cellHeight + 1} width={Math.max(2, cellWidth - 2)} height={Math.max(6, cellHeight - 2)} fill={chartColor(cell.channel.color)} opacity={active ? .18 + cell.value / maxWeekdayValue * .82 : .07}/><text className="rangeAnalyticsValue matrixValue" x={LEFT + (columnIndex + .5) * cellWidth} y={TOP + (rowIndex + .5) * cellHeight + 4} textAnchor="middle">{formatMetric(cell.value, matrixAverageMode ? 1 : 0)}</text><SvgTitle>{cell.weekday} · {cell.channel.name} · {formatMetric(cell.value, 1)} لید{matrixAverageMode ? ` · ${cell.days} وقوع` : ""}</SvgTitle></g>; })}</svg>
      </ChartFrame>

      <ChartFrame id="range-bubble" title="حباب مسیرها: حجم و بازده" description="محور افقی حجم ورودی، محور عمودی نرخ تبدیل و اندازهٔ حباب تعداد قرارداد را نشان می‌دهد." hoverText={hovered?.chart === "bubble" ? detailedHoverText : undefined} legend={[{ label: "محور عمودی: نرخ تبدیل", color: "#c9a7ff" }, { label: "اندازه: قرارداد", color: "#f5b83e" }]}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="نمودار حباب مسیرها"><GridLines/>{bubbleItems.map((item, index) => { const cx = LEFT + item.calls / maxBubbleCalls * PLOT_W; const cy = yFor(item.conversion, maxBubbleConversion); const radius = 6 + Math.sqrt(Math.max(0, item.contracts)) * 2.2; return <g className="rangeAnalyticsInteractive" key={item.name} tabIndex={0} role="img" aria-label={`${item.name}: ${item.calls.toLocaleString("en-US")} تماس، ${item.contracts.toLocaleString("en-US")} قرارداد، نرخ ${formatMetric(item.conversion, 1)}%`} onMouseEnter={() => setHovered({ chart: "bubble", index })} onFocus={() => setHovered({ chart: "bubble", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><circle className="rangeAnalyticsBubble" cx={cx} cy={cy} r={radius} fill={item.color}/>{radius > 10 && <text className="rangeAnalyticsAxis" x={cx} y={cy + 3}>{item.name}</text>}<SvgTitle>{item.name} · {item.calls.toLocaleString("en-US")} تماس · {item.contracts.toLocaleString("en-US")} قرارداد · نرخ {formatMetric(item.conversion, 1)}%</SvgTitle></g>; })}</svg>
      </ChartFrame>

      <ChartFrame id="range-treemap" title="نقشهٔ سهم کانال‌ها" description="مساحت هر خانه متناسب با حجم لید است؛ برای دیدن تمرکز ورودی در یک نگاه." hoverText={hovered?.chart === "treemap" ? detailedHoverText : undefined} legend={channelTotals.map(channel => ({ label: channel.name, color: chartColor(channel.color) }))}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="نقشهٔ سهم کانال‌ها">{treemapRects.map((rect, index) => <g className="rangeAnalyticsInteractive" key={rect.name} tabIndex={0} role="img" aria-label={`${rect.name}: ${rect.value.toLocaleString("en-US")} لید`} onMouseEnter={() => setHovered({ chart: "treemap", index })} onFocus={() => setHovered({ chart: "treemap", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><rect className="rangeAnalyticsTreemapRect" x={rect.x} y={rect.y} width={Math.max(1, rect.width - 2)} height={Math.max(1, rect.height - 2)} fill={rect.color}/>{rect.width > 62 && rect.height > 28 && <text className="rangeAnalyticsTreemapLabel" x={rect.x + rect.width / 2} y={rect.y + rect.height / 2 - 2}>{rect.name}</text>}{rect.width > 45 && rect.height > 28 && <text className="rangeAnalyticsTreemapValue" x={rect.x + rect.width / 2} y={rect.y + rect.height / 2 + 13}>{rect.value.toLocaleString("en-US")}</text>}<SvgTitle>{rect.name} · {rect.value.toLocaleString("en-US")} لید · {channelTotal > 0 ? formatMetric(rect.value / channelTotal * 100, 1) : "0"}% سهم</SvgTitle></g>)}</svg>
      </ChartFrame>

      <ChartFrame id="range-waterfall" title="نردبان هزینه تا قرارداد" description="هزینهٔ هر کانال به‌صورت تجمعی تا جمع کل دیده می‌شود؛ hover قرارداد و CAC همان کانال را نشان می‌دهد." hoverText={hovered?.chart === "waterfall" ? detailedHoverText : undefined} legend={[{ label: "هزینهٔ کانال", color: "#73b9ff" }, { label: "جمع هزینه", color: "#f5b83e" }]}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="نمودار نردبانی هزینهٔ کانال‌ها"><GridLines/>{waterfallBars.map((item, index) => { const groupWidth = PLOT_W / Math.max(1, waterfallBars.length); const center = LEFT + groupWidth * index + groupWidth / 2; const barWidth = Math.min(38, groupWidth * .62); const y = yFor(item.end, maxWaterfall); const base = yFor(item.start, maxWaterfall); return <g className="rangeAnalyticsInteractive" key={`${item.name}-${index}`} tabIndex={0} role="img" aria-label={`${item.name}: ${formatMetric(item.value)} تومان، ${item.contracts.toLocaleString("en-US")} قرارداد`} onMouseEnter={() => setHovered({ chart: "waterfall", index })} onFocus={() => setHovered({ chart: "waterfall", index })} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><rect className="rangeAnalyticsWaterfallBar" x={center - barWidth / 2} y={item.total ? y : y} width={barWidth} height={Math.max(2, (item.total ? TOP + PLOT_H - y : base - y))} fill={item.color}/>{!item.total && <line className="rangeAnalyticsWaterfallConnector" x1={center + barWidth / 2} x2={center + groupWidth - barWidth / 2} y1={base} y2={base}/>}<text className="rangeAnalyticsAxis" x={center} y={H - 8}>{item.name}</text><SvgTitle>{item.name} · {formatMetric(item.value)} تومان · {item.contracts.toLocaleString("en-US")} قرارداد</SvgTitle></g>; })}</svg>
      </ChartFrame>
    </div>
    <footer className="rangeAnalyticsFooter">بازهٔ انتخابی: {formatDate(startDate)} تا {formatDate(endDate)} · هر نود/میله با hover یا تمرکز صفحه‌کلید جزئیات عددی دارد. {plan.bucketDays > 1 ? `هر نقطه نمایندهٔ حداکثر ${plan.bucketDays} روز است.` : "هر نقطه نمایندهٔ یک روز تقویمی است."}</footer>
  </section>;
}
