export type SeoMetric = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SeoRow = {
  key: string;
  current: SeoMetric;
  previous: SeoMetric;
};

export type SeoDatasetProfile = "small" | "medium" | "large";
export type SeoConfidence = "بالا" | "متوسط" | "پایین";
export type SeoWorkType = "content" | "content_and_links";

export type SeoOpportunity = SeoRow & {
  score: number;
  potentialClicks: number;
  expectedCtr: number;
  ctrGap: number;
  category: string;
  priority: "زیاد" | "متوسط" | "کم";
  effort: "آسان" | "متوسط" | "سخت";
  qualified: boolean;
  confidence: SeoConfidence;
  reason: string;
  action: string;
  workType: SeoWorkType;
  workTypeLabel: string;
};

export type SeoAnalysis = {
  opportunities: SeoOpportunity[];
  profile: SeoDatasetProfile;
  profileLabel: string;
  impressionThreshold: number;
  scoreThreshold: number;
  rowCount: number;
};

const RANK_BUCKETS = ["1–3", "4–10", "11–20", "21–50"] as const;
type RankBucket = (typeof RANK_BUCKETS)[number];

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function number(value: number) {
  return finite(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function percent(value: number) {
  return `${(finite(value) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function percentile(values: number[], point: number) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = clamp(point, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function expectedCtrForPosition(value: number) {
  const position = finite(value, 100);
  if (position <= 1) return 0.28;
  if (position <= 2) return 0.15;
  if (position <= 3) return 0.1;
  if (position <= 5) return 0.06;
  if (position <= 10) return 0.035;
  if (position <= 20) return 0.015;
  return 0.008;
}

function rankBucket(value: number): RankBucket {
  const position = finite(value, 100);
  if (position <= 3) return "1–3";
  if (position <= 10) return "4–10";
  if (position <= 20) return "11–20";
  return "21–50";
}

function representativePosition(bucket: RankBucket) {
  if (bucket === "1–3") return 2;
  if (bucket === "4–10") return 7;
  if (bucket === "11–20") return 15;
  return 30;
}

function profileFor(rowCount: number) {
  if (rowCount < 30) {
    return {
      profile: "small" as const,
      label: "داده کم",
      impressionPercentile: 0.6,
      impressionFloor: 6,
      totalShare: 0.005,
      scoreThreshold: 2.5,
      declineThreshold: 0.3,
      previousClicks: 2,
      nearClicks: 1,
    };
  }
  if (rowCount <= 300) {
    return {
      profile: "medium" as const,
      label: "داده متوسط",
      impressionPercentile: 0.7,
      impressionFloor: 12,
      totalShare: 0.008,
      scoreThreshold: 3,
      declineThreshold: 0.22,
      previousClicks: 3,
      nearClicks: 2,
    };
  }
  return {
    profile: "large" as const,
    label: "داده زیاد",
    impressionPercentile: 0.75,
    impressionFloor: 20,
    totalShare: 0.01,
    scoreThreshold: 3.5,
    declineThreshold: 0.18,
    previousClicks: 5,
    nearClicks: 3,
  };
}

function cleanMetric(metric: SeoMetric): SeoMetric {
  const rawPosition = finite(metric?.position, 100);
  return {
    clicks: Math.max(0, finite(metric?.clicks)),
    impressions: Math.max(0, finite(metric?.impressions)),
    ctr: clamp(finite(metric?.ctr), 0, 1),
    position: rawPosition > 0 ? rawPosition : 100,
  };
}

export function analyzeSeoOpportunities(inputRows: SeoRow[]): SeoAnalysis {
  const rows = (inputRows || []).map((row) => ({
    ...row,
    current: cleanMetric(row.current),
    previous: cleanMetric(row.previous),
  }));
  const rowCount = rows.length;
  const profileConfig = profileFor(rowCount);
  const totalImpressions = rows.reduce((sum, row) => sum + row.current.impressions, 0);
  const impressionValues = rows.map((row) => row.current.impressions);
  const impressionThreshold = Math.max(
    profileConfig.impressionFloor,
    percentile(impressionValues, profileConfig.impressionPercentile),
    totalImpressions * profileConfig.totalShare,
  );

  const bucketBaselines = new Map<RankBucket, number>();
  for (const bucket of RANK_BUCKETS) {
    const bucketRows = rows.filter((row) => rankBucket(row.current.position) === bucket);
    const fallback = expectedCtrForPosition(representativePosition(bucket));
    const observedP75 = percentile(bucketRows.map((row) => row.current.ctr), 0.75);
    const impressions = bucketRows.reduce((sum, row) => sum + row.current.impressions, 0);
    const clicks = bucketRows.reduce((sum, row) => sum + row.current.clicks, 0);
    const observedWeighted = impressions > 0 ? clicks / impressions : 0;
    const observed = Math.max(observedP75, observedWeighted);
    const enoughEvidence = bucketRows.length >= (profileConfig.profile === "large" ? 8 : 4);
    const baseline = enoughEvidence
      ? clamp(fallback * 0.45 + observed * 0.55, fallback * 0.85, fallback * 1.6)
      : fallback;
    bucketBaselines.set(bucket, finite(baseline, fallback));
  }

  const maxPotential = Math.max(
    1,
    ...rows.map((row) => {
      const expected = bucketBaselines.get(rankBucket(row.current.position)) || expectedCtrForPosition(row.current.position);
      return Math.max(0, row.current.impressions * expected - row.current.clicks);
    }),
  );

  const opportunities = rows
    .map((row) => {
      const { clicks, impressions, ctr, position: currentPosition } = row.current;
      const previous = row.previous;
      const bucket = rankBucket(currentPosition);
      const expectedCtr = finite(bucketBaselines.get(bucket) || expectedCtrForPosition(currentPosition));
      const ctrGap = Math.max(0, expectedCtr - ctr);
      const potentialClicks = Math.max(0, Math.round(impressions * expectedCtr - clicks));
      const clickChange = previous.clicks > 0 ? (clicks - previous.clicks) / previous.clicks : clicks > 0 ? 1 : 0;
      const meaningfulCtrGap = ctrGap >= Math.max(0.006, expectedCtr * 0.18) && ctr <= expectedCtr * 0.86;
      const highImpressionLowCtr = impressions >= impressionThreshold && meaningfulCtrGap && currentPosition <= 20;
      const declining = clickChange <= -profileConfig.declineThreshold && previous.clicks >= profileConfig.previousClicks && impressions >= impressionThreshold * 0.35;
      const nearPageOne = currentPosition > 10 && currentPosition <= 20 && impressions >= impressionThreshold * 0.7 && (clicks >= profileConfig.nearClicks || ctrGap >= expectedCtr * 0.12);
      const quickWin = currentPosition >= 4 && currentPosition <= 15 && impressions >= impressionThreshold * 0.6 && ctrGap >= Math.max(0.005, expectedCtr * 0.16);
      const qualified = highImpressionLowCtr || declining || nearPageOne || quickWin;
      const category = highImpressionLowCtr
        ? "Impression بالا / CTR پایین"
        : declining
          ? "هشدار افت عملکرد"
          : nearPageOne
            ? "نزدیک صفحهٔ اول"
            : quickWin
              ? "افزایش سریع CTR"
              : "تقویت محتوا";
      const impact = Math.min(1, potentialClicks / maxPotential);
      const volumeFactor = impressionValues.length > 1
        ? impressionValues.filter((value) => value <= impressions).length / impressionValues.length
        : 1;
      const positionFactor = currentPosition > 3 && currentPosition <= 20 ? 1 : currentPosition <= 30 ? 0.55 : 0.2;
      // The score is intentionally normalized to 0–10 so it remains readable and comparable across datasets.
      const score = Math.min(10, Math.round((
        impact * 4
        + Math.min(1, ctrGap / Math.max(0.02, expectedCtr)) * 2.5
        + positionFactor * 2
        + volumeFactor * 1
        + Math.min(1, Math.abs(clickChange) / 0.5) * 0.5
      ) * 10) / 10);
      const priority = score >= 7 ? "زیاد" : score >= 4 ? "متوسط" : "کم";
      const effort = highImpressionLowCtr || quickWin ? "آسان" : nearPageOne ? "متوسط" : "سخت";
      const confidence: SeoConfidence = rowCount >= 300 && impressions >= impressionThreshold * 1.5
        ? "بالا"
        : rowCount >= 30 && impressions >= impressionThreshold
          ? "متوسط"
          : "پایین";
      const reason = highImpressionLowCtr
        ? `CTR این مورد ${percent(ctrGap)} پایین‌تر از خط مبنای پویا در رتبهٔ ${bucket} است؛ حدود ${number(potentialClicks)} کلیک بالقوه`
        : declining
          ? `کاهش ${Math.abs(clickChange * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}% کلیک نسبت به بازهٔ قبل`
          : nearPageOne
            ? `رتبه در بازهٔ ${bucket} است و با تقویت می‌تواند به صفحهٔ اول نزدیک شود`
            : `فاصله CTR با خط مبنای پویا حدود ${percent(ctrGap)} است`;
      const workType: SeoWorkType = nearPageOne && !highImpressionLowCtr && !quickWin ? "content_and_links" : "content";
      const workTypeLabel = workType === "content_and_links" ? "محتوا + لینک‌سازی داخلی" : "بهینه‌سازی محتوا";
      const action = highImpressionLowCtr || quickWin
        ? "بازنویسی Title و Meta و بهبود محتوای صفحه"
        : declining
          ? "بررسی افت محتوا، رقبا و لینک‌های داخلی"
          : nearPageOne
            ? "تقویت محتوای صفحه و لینک‌سازی داخلی از صفحات مرتبط"
            : "بررسی نیت جست‌وجو و کامل‌کردن محتوای هدف";
      return { ...row, score, potentialClicks, expectedCtr, ctrGap, category, priority, effort, qualified, confidence, reason, action, workType, workTypeLabel };
    })
    .filter((row) => row.qualified && row.score >= profileConfig.scoreThreshold)
    .sort((left, right) => right.score - left.score || right.potentialClicks - left.potentialClicks);

  return {
    opportunities,
    profile: profileConfig.profile,
    profileLabel: profileConfig.label,
    impressionThreshold: Math.round(impressionThreshold),
    scoreThreshold: profileConfig.scoreThreshold,
    rowCount,
  };
}
