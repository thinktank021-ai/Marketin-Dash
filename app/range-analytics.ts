export type RangeAnalyticsDailyPoint = {
  date: string;
  value: number;
  contracts: number;
  /** Persian workweek label is carried with the day so matrix views do not re-derive calendar dates. */
  weekday?: string;
};

export type RangeAnalyticsChannel = {
  name: string;
  color: string;
  keys: string[];
};

export type RangeAnalyticsBucket = {
  key: string;
  startDate: string;
  endDate: string;
  days: number;
  value: number;
  contracts: number;
  channelValues: Record<string, number>;
  channelContracts: Record<string, number>;
};

export type RangeAnalyticsPlan = {
  bucketDays: number;
  label: string;
};

function normalizeAnalyticsKey(value: unknown) {
  return String(value ?? "").replace(/[\s‌_-]/g, "").toLowerCase();
}

function finiteMetric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keeps the selected range readable without throwing away daily precision for ranges up to 60 days. */
export function getRangeAnalyticsPlan(dayCount: number): RangeAnalyticsPlan {
  if (dayCount <= 31) return { bucketDays: 1, label: "روزانه" };
  if (dayCount <= 60) return { bucketDays: 1, label: "روزانه فشرده" };
  if (dayCount <= 90) return { bucketDays: 7, label: "تجمیع ۷روزه" };
  if (dayCount <= 180) return { bucketDays: 14, label: "تجمیع ۱۴روزه" };
  return { bucketDays: 30, label: "تجمیع ۳۰روزه" };
}

function sumChannelValues(
  days: RangeAnalyticsDailyPoint[],
  dailyValues: Record<string, Record<string, number>> = {},
  channels: RangeAnalyticsChannel[] = [],
) {
  const source = isRecord(dailyValues) ? dailyValues : {};
  const safeChannels = Array.isArray(channels) ? channels.filter(Boolean) : [];
  return Object.fromEntries(safeChannels.map(channel => [channel.name, days.reduce((sum, day) => {
    const values = isRecord(source[day.date]) ? source[day.date] : {};
    const acceptedKeys = new Set((Array.isArray(channel.keys) ? channel.keys : []).map(normalizeAnalyticsKey));
    return sum + Object.entries(values).reduce((channelSum, [key, value]) => acceptedKeys.has(normalizeAnalyticsKey(key)) ? channelSum + finiteMetric(value) : channelSum, 0);
  }, 0)]));
}

/** Builds every chart's shared bucket model in one linear pass over the selected days. */
export function buildRangeAnalyticsBuckets(
  dailyCounts: RangeAnalyticsDailyPoint[],
  dailyChannelCounts: Record<string, Record<string, number>> = {},
  dailyChannelContracts: Record<string, Record<string, number>> = {},
  channels: RangeAnalyticsChannel[] = [],
): { plan: RangeAnalyticsPlan; buckets: RangeAnalyticsBucket[] } {
  // API/cache payloads are runtime data, even though the component contract is typed.
  // Normalize them here so one malformed optional field cannot crash the dashboard tree.
  const orderedDays = (Array.isArray(dailyCounts) ? dailyCounts : [])
    .filter(Boolean)
    .map(day => ({
      date: String(day?.date ?? ""),
      value: finiteMetric(day?.value),
      contracts: finiteMetric(day?.contracts),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const plan = getRangeAnalyticsPlan(orderedDays.length);
  const buckets: RangeAnalyticsBucket[] = [];

  for (let index = 0; index < orderedDays.length; index += plan.bucketDays) {
    const days = orderedDays.slice(index, index + plan.bucketDays);
    const startDate = days[0]?.date || "";
    const endDate = days[days.length - 1]?.date || startDate;
    buckets.push({
      key: `${startDate}-${endDate}`,
      startDate,
      endDate,
      days: days.length,
      value: days.reduce((sum, day) => sum + finiteMetric(day.value), 0),
      contracts: days.reduce((sum, day) => sum + finiteMetric(day.contracts), 0),
      channelValues: sumChannelValues(days, dailyChannelCounts, channels),
      channelContracts: sumChannelValues(days, dailyChannelContracts, channels),
    });
  }

  return { plan, buckets };
}

export function buildMovingAverage(values: number[], windowSize = 7) {
  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const sample = values.slice(start, index + 1);
    return sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : 0;
  });
}

export function formatRangeBucketLabel(bucket: RangeAnalyticsBucket, formatDate: (date: string) => string) {
  if (bucket.startDate === bucket.endDate) return formatDate(bucket.startDate);
  return `${formatDate(bucket.startDate)} تا ${formatDate(bucket.endDate)}`;
}
