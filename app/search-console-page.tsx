"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { manualRefresh } from "./manual-refresh";
import { analyzeSeoOpportunities, type SeoOpportunity } from "./seo-opportunity-engine";

type Metric = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};
type MetricKey = keyof Metric;
type Row = { key: string; current: Metric; previous: Metric };
type Report = {
  connected: boolean;
  stale?: boolean;
  propertyUrl: string;
  dimension: string;
  type: string;
  dateRange: { from: string; to: string };
  previousDateRange: { from: string; to: string };
  totals: Metric;
  previousTotals: Metric;
  daily: Array<Metric & { date: string }>;
  previousDaily: Array<Metric & { date: string }>;
  rows: Row[];
  incompleteFrom?: string;
  lastSuccessfulAt?: string;
};
type SortMode = "current" | "previous" | "difference";
type SortKey = "key" | `${MetricKey}:${SortMode}`;
type ChartHover = {
  series: "current" | "previous";
  date: string;
  value: number;
  x: number;
  y: number;
};

const dimensionLabels: Record<string, string> = {
  query: "عبارت‌های جست‌وجو",
  page: "صفحات ورودی",
  country: "کشورها",
  device: "دستگاه‌ها",
};
const typeLabels: Record<string, string> = {
  web: "وب",
  image: "تصویر",
  video: "ویدئو",
  news: "اخبار",
  discover: "Discover",
  googleNews: "Google News",
};
const metricMeta: Record<
  MetricKey,
  { label: string; short: string; className: string }
> = {
  clicks: { label: "کلیک ارگانیک", short: "کلیک", className: "clicks" },
  impressions: {
    label: "نمایش در جست‌وجو",
    short: "نمایش",
    className: "impressions",
  },
  ctr: { label: "میانگین CTR", short: "CTR", className: "ctr" },
  position: { label: "میانگین رتبه", short: "رتبه", className: "position" },
};
const persianWeekdays = ["ش", "ی", "د", "س", "چ", "پ", "ج"];
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function shiftIso(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function persianDate(value: string) {
  return value
    ? new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${value}T00:00:00Z`))
    : "—";
}
function persianKey(value: string) {
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(`${value}T12:00:00Z`));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")}`;
}
function persianToGregorian(dateKey: string) {
  const [targetYear, targetMonth, targetDay] = dateKey.split("/").map(Number);
  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  for (
    let time = Date.UTC(targetYear + 620, 0, 1, 12);
    time < Date.UTC(targetYear + 623, 0, 1, 12);
    time += 86400000
  ) {
    const date = new Date(time);
    const parts = formatter.formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value || 0);
    if (
      value("year") === targetYear &&
      value("month") === targetMonth &&
      value("day") === targetDay
    )
      return date.toISOString().slice(0, 10);
  }
  throw new Error("persian_date_conversion_failed");
}
function shiftPersianDate(dateKey: string, offsetDays: number) {
  const anchor = new Date(`${persianToGregorian(dateKey)}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return persianKey(anchor.toISOString().slice(0, 10));
}
function getPersianMonthCalendar(monthKey: string) {
  const [targetYear, targetMonth] = monthKey.split("/").map(Number);
  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  let firstWeekday = 0;
  let dayCount = 0;
  for (
    let time = Date.UTC(targetYear + 620, 0, 1, 12);
    time < Date.UTC(targetYear + 623, 0, 1, 12);
    time += 86400000
  ) {
    const date = new Date(time);
    const parts = formatter.formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value || 0);
    if (value("year") !== targetYear || value("month") !== targetMonth)
      continue;
    const day = value("day");
    if (day === 1) firstWeekday = (date.getUTCDay() + 1) % 7;
    dayCount = Math.max(dayCount, day);
  }
  return {
    firstWeekday,
    days: Array.from({ length: dayCount }, (_, index) => index + 1),
  };
}
function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split("/").map(Number);
  const iso = persianToGregorian(
    `${year}/${String(month).padStart(2, "0")}/01`,
  );
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${iso}T12:00:00Z`));
}
function number(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function percent(value: number) {
  return `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}
function position(value: number) {
  return value
    ? value.toLocaleString("en-US", { maximumFractionDigits: 1 })
    : "—";
}
function metricValue(value: number, metric: MetricKey) {
  return metric === "ctr"
    ? percent(value)
    : metric === "position"
      ? position(value)
      : number(value);
}
function delta(current: number, previous: number) {
  if (!previous) return current ? "+100%" : "0%";
  return `${current >= previous ? "+" : ""}${(((current - previous) / previous) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

/** Uses the same combined Persian range picker as the main-page report. */
function PersianDatePicker({
  start,
  end,
  max,
  onChange,
}: {
  start: string;
  end: string;
  max: string;
  onChange: (start: string, end: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => persianKey(end).slice(0, 7));
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const monthKey = month || persianKey(end).slice(0, 7);
  const [year, monthNumber] = monthKey.split("/").map(Number);
  const calendar = getPersianMonthCalendar(monthKey);
  const choose = (day: number) => {
    const dateKey = `${year}/${String(monthNumber).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
    const iso = persianToGregorian(dateKey);
    if (iso > max) return;
    if (!rangeAnchor) {
      setRangeAnchor(dateKey);
      return;
    }
    if (dateKey < rangeAnchor) {
      setRangeAnchor(dateKey);
      setMonth(dateKey.slice(0, 7));
      return;
    }
    onChange(persianToGregorian(rangeAnchor), iso);
    setRangeAnchor(null);
    setOpen(false);
  };
  return (
    <div className="datePicker">
      <button
        type="button"
        className="datePickerButton active"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setMonth(persianKey(end).slice(0, 7));
          setRangeAnchor(null);
          setOpen((current) => !current);
        }}
      >
        ▦ {persianDate(start)} تا {persianDate(end)}
      </button>
      {open && (
        <div
          className="persianCalendar glass"
          role="dialog"
          aria-label="انتخاب بازه تاریخ شمسی Search Console"
        >
          <div className="calendarHeader">
            <button
              type="button"
              onClick={() =>
                setMonth(
                  shiftPersianDate(
                    `${year}/${String(monthNumber).padStart(2, "0")}/01`,
                    -1,
                  ).slice(0, 7),
                )
              }
              aria-label="ماه قبل"
            >
              ‹
            </button>
            <strong>{monthLabel(monthKey)}</strong>
            <button
              type="button"
              onClick={() =>
                setMonth(
                  shiftPersianDate(
                    `${year}/${String(monthNumber).padStart(2, "0")}/01`,
                    32,
                  ).slice(0, 7),
                )
              }
              aria-label="ماه بعد"
            >
              ›
            </button>
          </div>
          <div className="calendarWeekdays" aria-hidden="true">
            {persianWeekdays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendarDays">
            {Array.from({ length: calendar.firstWeekday }).map((_, index) => (
              <i key={`empty-${index}`} />
            ))}
            {calendar.days.map((day) => {
              const dateKey = `${monthKey}/${String(day).padStart(2, "0")}`;
              const disabled = dateKey > persianKey(max);
              const isEdge =
                dateKey === persianKey(start) ||
                dateKey === persianKey(end) ||
                dateKey === rangeAnchor;
              const isInRange =
                dateKey >= persianKey(start) && dateKey <= persianKey(end);
              return (
                <button
                  type="button"
                  key={day}
                  disabled={disabled}
                  className={`${isEdge ? "selected" : ""} ${isInRange ? "inRange" : ""}`}
                  onClick={() => choose(day)}
                >
                  {day.toLocaleString("en-US", { useGrouping: false })}
                </button>
              );
            })}
          </div>
          <div className="calendarFooter">
            <small>
              {rangeAnchor
                ? "روز پایان را انتخاب کنید"
                : "ابتدا شروع، سپس پایان"}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}

type SeoActionStatus = "new" | "in_progress" | "done" | "snoozed";
type SeoFilter = "all" | "quick" | "near" | "decline" | "potential" | "highEasy" | "highHard" | "lowEasy" | "lowHard";
type SeoSortKey = "key" | "score" | "priority" | "clicks" | "impressions" | "ctr" | "position" | "potentialClicks" | "category" | "workType";
function SeoPrioritySection({
  report,
  dimension,
  brandId,
  from,
  to,
}: {
  report: Report;
  dimension: string;
  brandId: string;
  from: string;
  to: string;
}) {
  const seoAnalysis = useMemo(() => analyzeSeoOpportunities(report.rows || []), [report.rows]);
  const opportunities = seoAnalysis.opportunities;
  const storageKey = `seo-action-queue:v1:${brandId}:${dimension}`;
  const [statuses, setStatuses] = useState<Record<string, SeoActionStatus>>({});
  const hydratedQueueKey = useRef("");
  /* eslint-disable react-hooks/set-state-in-effect -- hydrate the local action queue when its report scope changes. */
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      setStatuses(saved ? (JSON.parse(saved) as Record<string, SeoActionStatus>) : {});
    } catch {
      setStatuses({});
    }
    hydratedQueueKey.current = storageKey;
  }, [storageKey]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (hydratedQueueKey.current === storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(statuses));
      } catch {
        // Local persistence is optional and must never break the report.
      }
    }
  }, [statuses, storageKey]);
  const statusLabel: Record<SeoActionStatus, string> = {
    new: "جدید",
    in_progress: "در حال انجام",
    done: "انجام شد",
    snoozed: "بعداً بررسی شود",
  };
  const counts = {
    quick: opportunities.filter((row) => row.category === "افزایش سریع CTR" || row.category === "Impression بالا / CTR پایین").length,
    near: opportunities.filter((row) => row.category === "نزدیک صفحهٔ اول").length,
    decline: opportunities.filter((row) => row.category === "هشدار افت عملکرد").length,
  };
  const workTypeCounts = {
    content: opportunities.filter((row) => row.workType === "content").length,
    contentAndLinks: opportunities.filter((row) => row.workType === "content_and_links").length,
  };
  const alerts = [
    ...opportunities.filter((row) => row.category === "Impression بالا / CTR پایین").slice(0, 2).map((row) => ({ label: "فرصت فوری CTR", text: `${row.key} · ${number(row.potentialClicks)} کلیک بالقوه`, tone: "warning" })),
    ...opportunities.filter((row) => row.category === "هشدار افت عملکرد").slice(0, 2).map((row) => ({ label: "افت نیازمند بررسی", text: `${row.key} · ${row.reason}`, tone: "danger" })),
    ...opportunities.filter((row) => row.current.clicks > row.previous.clicks && row.current.clicks >= 3).slice(0, 1).map((row) => ({ label: "رشد مثبت", text: `${row.key} · ${delta(row.current.clicks, row.previous.clicks)} کلیک`, tone: "success" })),
  ].slice(0, 4);
  const [radarFilter, setRadarFilter] = useState<SeoFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [seoSort, setSeoSort] = useState<{ key: SeoSortKey; direction: "asc" | "desc" }>({ key: "score", direction: "desc" });
  const radarFilterLabels: Record<SeoFilter, string> = {
    all: "همه فرصت‌ها",
    quick: "فرصت افزایش CTR",
    near: "نزدیک صفحهٔ اول",
    decline: "افت عملکرد",
    potential: "کلیک قابل دستیابی",
    highEasy: "اثرگذاری زیاد · اجرای آسان",
    highHard: "اثرگذاری زیاد · اجرای سخت",
    lowEasy: "اثرگذاری کم/متوسط · اجرای آسان",
    lowHard: "اثرگذاری کم/متوسط · اجرای سخت",
  };
  const matchesSeoFilter = (row: SeoOpportunity, filter: SeoFilter) => {
    if (filter === "all") return true;
    if (filter === "quick") return row.category === "افزایش سریع CTR" || row.category === "Impression بالا / CTR پایین";
    if (filter === "near") return row.category === "نزدیک صفحهٔ اول";
    if (filter === "decline") return row.category === "هشدار افت عملکرد";
    if (filter === "potential") return row.potentialClicks > 0;
    if (filter === "highEasy") return row.priority === "زیاد" && row.effort === "آسان";
    if (filter === "highHard") return row.priority === "زیاد" && row.effort !== "آسان";
    if (filter === "lowEasy") return row.priority !== "زیاد" && row.effort === "آسان";
    return row.priority !== "زیاد" && row.effort !== "آسان";
  };
  const visibleOpportunities = opportunities.filter((row) => matchesSeoFilter(row, radarFilter));
  const sortedVisibleOpportunities = useMemo(() => {
    const value = (row: SeoOpportunity): string | number => {
      if (seoSort.key === "key") return row.key;
      if (seoSort.key === "score") return row.score;
      if (seoSort.key === "priority") return row.priority === "زیاد" ? 3 : row.priority === "متوسط" ? 2 : 1;
      if (seoSort.key === "clicks") return row.current.clicks;
      if (seoSort.key === "impressions") return row.current.impressions;
      if (seoSort.key === "ctr") return row.current.ctr;
      if (seoSort.key === "position") return row.current.position;
      if (seoSort.key === "potentialClicks") return row.potentialClicks;
      if (seoSort.key === "category") return row.category;
      return row.workTypeLabel;
    };
    return [...visibleOpportunities].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      const compared = typeof a === "string" ? a.localeCompare(String(b), "fa", { numeric: true }) : Number(a) - Number(b);
      return (seoSort.direction === "asc" ? compared : -compared) || right.score - left.score;
    });
  }, [seoSort, visibleOpportunities]);
  const changeSeoSort = (key: SeoSortKey) => setSeoSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: key === "key" || key === "category" || key === "workType" ? "asc" : "desc" });
  const seoSortMark = (key: SeoSortKey) => seoSort.key === key ? (seoSort.direction === "asc" ? " ↑" : " ↓") : "";
  const selectRadarFilter = (filter: SeoFilter) => {
    setRadarFilter(filter);
    setShowAll(filter === "all");
    if (filter === "potential" || filter === "quick" || filter === "highEasy") {
      setSeoSort({ key: "potentialClicks", direction: "desc" });
    } else if (filter === "near") {
      setSeoSort({ key: "position", direction: "asc" });
    } else if (filter === "decline") {
      setSeoSort({ key: "clicks", direction: "asc" });
    }
  };
  const radarCells = (["highEasy", "highHard", "lowEasy", "lowHard"] as const).map((filter) => {
    const rows = opportunities.filter((row) => matchesSeoFilter(row, filter));
    return {
      filter,
      rows,
      count: rows.length,
      potentialClicks: rows.reduce((sum, row) => sum + row.potentialClicks, 0),
      topKey: rows[0]?.key || "داده‌ای در این دسته نیست",
    };
  });
  const exportActions = () => {
    const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const lines = [
      ["مورد", "دسته", "اولویت", "وضعیت", "کلیک فعلی", "نمایش", "CTR", "رتبه", "کلیک بالقوه", "دلیل", "اقدام"].map(escape).join(","),
      ...sortedVisibleOpportunities.map((row) => [row.key, row.category, row.priority, statusLabel[statuses[row.key] || "new"], row.current.clicks, row.current.impressions, percent(row.current.ctr), position(row.current.position), row.potentialClicks, row.reason, row.action].map(escape).join(",")),
    ];
    const url = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `seo-action-queue-${dimension}-${radarFilter}-${from}-${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="seoPrioritySection" aria-label="اولویت‌های SEO">
      <header>
        <div>
          <span>SEO Action Center</span>
          <h3>اولویت‌های پیشنهادی برای کار روی SEO</h3>
          <p>امتیاز بر اساس کلیک بالقوه، فاصله CTR از خط مبنای رتبه، جایگاه و تغییرات بازه قبل محاسبه شده است؛ این گزارش با مدل پویا روی {seoAnalysis.profileLabel} ({seoAnalysis.rowCount.toLocaleString("en-US")} ردیف) تحلیل شده.</p>
        </div>
        <div className="seoPriorityHeaderActions">
          <b>{visibleOpportunities.length.toLocaleString("en-US")} فرصت در فیلتر فعلی</b>
          <button type="button" className={radarFilter === "all" && showAll ? "active" : ""} onClick={() => selectRadarFilter("all")}>نمایش همه فرصت‌ها ({opportunities.length.toLocaleString("en-US")})</button>
          <button type="button" onClick={exportActions} disabled={!visibleOpportunities.length}>↓ خروجی صف اقدام</button>
        </div>
      </header>
      <div className="seoOpportunityCards" aria-label="فیلترهای فرصت SEO">
        <button type="button" className={`seoOpportunityMetricCard quick ${radarFilter === "quick" ? "active" : ""}`} aria-pressed={radarFilter === "quick"} onClick={() => selectRadarFilter("quick")}><strong>{counts.quick.toLocaleString("en-US")}</strong><span>فرصت افزایش CTR</span><small>نمایش کافی و CTR معناداراً پایین‌تر از انتظار</small></button>
        <button type="button" className={`seoOpportunityMetricCard near ${radarFilter === "near" ? "active" : ""}`} aria-pressed={radarFilter === "near"} onClick={() => selectRadarFilter("near")}><strong>{counts.near.toLocaleString("en-US")}</strong><span>نزدیک صفحهٔ اول</span><small>رتبهٔ ۱۱ تا ۲۰ با نمایش کافی برای اقدام</small></button>
        <button type="button" className={`seoOpportunityMetricCard decline ${radarFilter === "decline" ? "active" : ""}`} aria-pressed={radarFilter === "decline"} onClick={() => selectRadarFilter("decline")}><strong>{counts.decline.toLocaleString("en-US")}</strong><span>افت عملکرد</span><small>افت حداقل ۲۰٪ با دادهٔ قبلی معتبر</small></button>
        <button type="button" className={`seoOpportunityMetricCard potential ${radarFilter === "potential" ? "active" : ""}`} aria-pressed={radarFilter === "potential"} onClick={() => selectRadarFilter("potential")}><strong>{opportunities.reduce((sum, row) => sum + row.potentialClicks, 0).toLocaleString("en-US")}</strong><span>کلیک قابل دستیابی</span><small>با مرتب‌سازی فرصت‌ها بر اساس پتانسیل کلیک</small></button>
      </div>
      <div className="seoOpportunityGuide">
        <strong>این اعداد چه تصمیمی می‌سازند؟</strong>
        <span><b>بهینه‌سازی محتوا ({workTypeCounts.content.toLocaleString("en-US")}):</b> فرصت‌هایی با نمایش بالا و CTR پایین یا فاصله زیاد از CTR مورد انتظار؛ اولویت با Title، Meta و محتوای همان صفحه است.</span>
        <span><b>محتوا + لینک‌سازی داخلی ({workTypeCounts.contentAndLinks.toLocaleString("en-US")}):</b> صفحاتی که رتبهٔ ۱۱ تا ۲۰ دارند؛ با تقویت محتوا و لینک از صفحات مرتبط می‌توانند به صفحهٔ اول نزدیک شوند.</span>
        <small>روش امتیازدهی ۰ تا ۱۰: پتانسیل کلیک ۴ امتیاز، فاصله CTR از خط مبنا ۲٫۵ امتیاز، جایگاه ۲ امتیاز، حجم نمایش ۱ امتیاز و تغییرات کلیک ۰٫۵ امتیاز. امتیاز ۷ تا ۱۰ اولویت زیاد، ۴ تا کمتر از ۷ اولویت متوسط و کمتر از ۴ اولویت کم است. حداقل امتیاز نمایش این گزارش {seoAnalysis.scoreThreshold.toLocaleString("en-US", { maximumFractionDigits: 1 })} از ۱۰ است؛ این حد و آستانهٔ نمایش {seoAnalysis.impressionThreshold.toLocaleString("en-US")} با حجم و توزیع داده‌ها به‌صورت پویا تنظیم می‌شوند. CTR مرجع در بازه‌های رتبهٔ ۱–۳، ۴–۱۰، ۱۱–۲۰ و ۲۱–۵۰ محاسبه می‌شود و با دادهٔ کافی از عملکرد واقعی همان بازه تعدیل می‌شود. سطح اطمینان هر ردیف کنار دلیل نمایش داده می‌شود؛ این تحلیل کیفیت بک‌لینک خارجی را اندازه‌گیری نمی‌کند.</small>
      </div>
      <div className="seoRadarGrid">
        <article className="seoRadarCard"><header><div><strong>Opportunity Radar</strong><small>اثرگذاری و سختی اجرا را هم‌زمان می‌بینید</small></div><b>{opportunities.length.toLocaleString("en-US")} فرصت قابل اتکا</b></header><div className="seoRadarLegend"><span>اثرگذاری زیاد</span><span>اثرگذاری کم/متوسط</span></div><div className="seoRadarMatrix">{radarCells.map((cell) => <button type="button" key={cell.filter} className={`${cell.filter} ${radarFilter === cell.filter ? "active" : ""}`} aria-pressed={radarFilter === cell.filter} onClick={() => selectRadarFilter(cell.filter)}><span>{cell.filter.endsWith("Easy") ? "اجرای آسان" : "اجرای سخت"}</span><strong>{cell.count.toLocaleString("en-US")} فرصت</strong><small>{cell.potentialClicks.toLocaleString("en-US")} کلیک بالقوه</small><em>{cell.topKey}</em></button>)}</div><small className="seoRadarSelection">فیلتر فعال: {radarFilterLabels[radarFilter]} · {visibleOpportunities.length.toLocaleString("en-US")} مورد در جدول</small></article>
        <article className="seoAlertsCard"><header><strong>هشدارهای مهم این بازه</strong><small>بر اساس داده واقعی همین گزارش</small></header>{alerts.length ? alerts.map((alert, index) => <div className={`seoAlert ${alert.tone}`} key={`${alert.label}-${index}`}><b>{alert.label}</b><span>{alert.text}</span></div>) : <p>هشدار مهمی با این بازه پیدا نشد.</p>}</article>
      </div>
      <div className="seoPriorityTableWrap">
        <table>
          <thead><tr><th><button type="button" onClick={() => changeSeoSort("key")}>{dimensionLabels[dimension] || "عبارت یا صفحه"}{seoSortMark("key")}</button></th><th><button type="button" onClick={() => changeSeoSort("score")}>امتیاز{seoSortMark("score")}</button></th><th><button type="button" onClick={() => changeSeoSort("priority")}>اولویت{seoSortMark("priority")}</button></th><th><button type="button" onClick={() => changeSeoSort("clicks")}>کلیک فعلی{seoSortMark("clicks")}</button></th><th><button type="button" onClick={() => changeSeoSort("impressions")}>نمایش{seoSortMark("impressions")}</button></th><th><button type="button" onClick={() => changeSeoSort("ctr")}>CTR{seoSortMark("ctr")}</button></th><th><button type="button" onClick={() => changeSeoSort("position")}>رتبه{seoSortMark("position")}</button></th><th><button type="button" onClick={() => changeSeoSort("potentialClicks")}>کلیک قابل دستیابی{seoSortMark("potentialClicks")}</button></th><th>دلیل</th><th>اطمینان</th><th><button type="button" onClick={() => changeSeoSort("category")}>فرصت{seoSortMark("category")}</button></th><th>صف اقدام</th></tr></thead>
          <tbody>{sortedVisibleOpportunities.length ? sortedVisibleOpportunities.slice(0, showAll ? undefined : 12).map((row) => <tr key={row.key}>
            <td dir={dimension === "page" ? "ltr" : undefined}>{row.key}</td>
            <td><strong className="seoScore" title="امتیاز نهایی از ۱۰">{row.score.toLocaleString("en-US", { maximumFractionDigits: 1 })}<small>/10</small></strong></td>
            <td><span className={`seoPriorityBadge ${row.priority === "زیاد" ? "high" : row.priority === "متوسط" ? "medium" : "low"}`}>{row.priority}</span></td>
            <td>{number(row.current.clicks)}</td><td>{number(row.current.impressions)}</td><td>{percent(row.current.ctr)}</td><td>{position(row.current.position)}</td><td>{number(row.potentialClicks)}</td><td>{row.reason}</td><td><span className={`seoConfidence ${row.confidence === "بالا" ? "high" : row.confidence === "متوسط" ? "medium" : "low"}`}>{row.confidence}</span></td><td><b className="seoWorkType">{row.workTypeLabel}</b><small className="seoActionText">{row.action}</small></td>
            <td><select value={statuses[row.key] || "new"} onChange={(event) => setStatuses((current) => ({ ...current, [row.key]: event.target.value as SeoActionStatus }))} aria-label={`وضعیت اقدام ${row.key}`}>{Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></td>
          </tr>) : <tr><td colSpan={12}>با این بازه و دادهٔ فعلی فرصت قابل اتکایی پیدا نشد.</td></tr>}</tbody>
        </table>
      </div>
      {sortedVisibleOpportunities.length > 12 && <button type="button" className="seoShowAllButton" onClick={() => setShowAll((current) => !current)}>{showAll ? "نمایش ۱۲ فرصت اول" : `نمایش همه ${sortedVisibleOpportunities.length.toLocaleString("en-US")} فرصت این فیلتر`}</button>}
    </section>
  );
}

export function SearchConsolePage({
  brandId,
  onSetup,
}: {
  brandId: string;
  onSetup: () => void;
}) {
  const today = isoToday();
  const latestCompleteDate = shiftIso(today, -1);
  const [from, setFrom] = useState(latestCompleteDate);
  const [to, setTo] = useState(latestCompleteDate);
  const [dimension, setDimension] = useState("query");
  const [searchType, setSearchType] = useState("web");
  const [query, setQuery] = useState("");
  const [activeMetric, setActiveMetric] = useState<MetricKey>("clicks");
  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>([
    "clicks",
  ]);
  const [chartHover, setChartHover] = useState<ChartHover | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>(
    { key: "clicks:current", direction: "desc" },
  );
  const [page, setPage] = useState(1);
  const invalidRange = from > to;
  const load = useCallback(async () => {
    if (invalidRange) {
      setError("تاریخ شروع نباید بعد از تاریخ پایان باشد.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const headers = new Headers({ "x-dashboard-brand": brandId });
      if (manualRefresh.active) headers.set("x-dashboard-refresh", "1");
      const response = await fetch(
        `/api/search-console/report?from=${from}&to=${to}&dimension=${dimension}&type=${searchType}&cachebust=${Date.now()}`,
        {
          cache: "no-store",
          headers,
          signal: manualRefresh.active ? manualRefresh.signal : undefined,
        },
      );
      const payload = (await response.json()) as Report & { error?: string };
      if (!response.ok || !payload.totals || !Array.isArray(payload.rows))
        throw new Error(payload.error || "گزارش Search Console دریافت نشد.");
      setReport(payload);
    } catch (requestError) {
      if (
        requestError instanceof DOMException &&
        requestError.name === "AbortError"
      )
        return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "گزارش Search Console دریافت نشد.",
      );
    } finally {
      setLoading(false);
    }
  }, [brandId, dimension, from, invalidRange, searchType, to]);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- report loading synchronizes with the external Search Console API. */
    void load();
    const unregister = manualRefresh.register("گزارش Search Console", load);
    return unregister;
  }, [load]);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- pagination must reset when report filters change. */
    setPage(1);
  }, [dimension, query, searchType, from, to, activeMetric]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("fa");
    const filtered = (report?.rows || []).filter(
      (row) => !needle || row.key.toLocaleLowerCase("fa").includes(needle),
    );
    const value = (row: Row): string | number => {
      if (sort.key === "key") return row.key;
      const [metric, mode] = sort.key.split(":") as [MetricKey, SortMode];
      if (mode === "current") return row.current[metric];
      if (mode === "previous") return row.previous[metric];
      return row.current[metric] - row.previous[metric];
    };
    return [...filtered].sort((left, right) => {
      const a = value(left),
        b = value(right);
      const compared =
        typeof a === "string"
          ? a.localeCompare(String(b), "fa", { numeric: true })
          : Number(a) - Number(b);
      return (
        (sort.direction === "asc" ? compared : -compared) ||
        left.key.localeCompare(right.key, "fa")
      );
    });
  }, [query, report, sort]);
  const pageSize = 50,
    pageCount = Math.max(1, Math.ceil(rows.length / pageSize)),
    visibleRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const changeSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "key" ? "asc" : "desc" },
    );
  const sortMark = (key: SortKey) =>
    sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
  const metricSortKey = (metric: MetricKey, mode: SortMode): SortKey =>
    `${metric}:${mode}`;
  const exportCsv = () => {
    const escape = (value: string | number) =>
      `"${String(value).replace(/"/g, '""')}"`;
    const meta = metricMeta[activeMetric];
    const lines = [
      [
        dimensionLabels[dimension],
        meta.short,
        `${meta.short} بازه قبل`,
        `تفاوت ${meta.short}`,
      ]
        .map(escape)
        .join(","),
      ...rows.map((row) =>
        [
          row.key,
          metricValue(row.current[activeMetric], activeMetric),
          metricValue(row.previous[activeMetric], activeMetric),
          metricValue(
            row.current[activeMetric] - row.previous[activeMetric],
            activeMetric,
          ),
        ]
          .map(escape)
          .join(","),
      ),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `search-console-${dimension}-${activeMetric}-${from}-${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const chartDays = Math.max(
    1,
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() -
        new Date(`${from}T00:00:00Z`).getTime()) /
        86400000,
    ) + 1,
  );
  const maxValue = Math.max(
    1,
    ...(report?.daily || []).map((day) => day[activeMetric]),
    ...(report?.previousDaily || []).map((day) => day[activeMetric]),
  );
  const chartWidth = Math.max(680, chartDays * 28);
  const chartStep = chartDays > 1 ? (chartWidth - 80) / (chartDays - 1) : 0;
  const point = (value: number, index: number) =>
    `${40 + index * chartStep},${160 - (value / maxValue) * 112}`;
  const pointY = (value: number) => 160 - (value / maxValue) * 112;
  const meta = metricMeta[activeMetric];
  const showChartHover = (pointData: ChartHover) => setChartHover(pointData);
  const toggleMetric = (metric: MetricKey) => {
    setActiveMetric(metric);
    setSelectedMetrics((current) => {
      if (current.includes(metric))
        return current.length === 1
          ? current
          : current.filter((item) => item !== metric);
      return current.length < 4 ? [...current, metric] : current;
    });
  };
  return (
    <section
      className={`searchConsoleWorkspace glass ${open ? "calendarOpen" : ""}`}
      aria-label="گزارش Google Search Console"
    >
      <header className="searchConsoleHeader">
        <div>
          <span>عملکرد جست‌وجوی ارگانیک</span>
          <h2>Google Search Console</h2>
          <p>
            {report?.propertyUrl || "داده‌های SEO و ورودی ارگانیک همین دفتر"}
          </p>
          <small className="searchConsoleMetricNote">
            کلیک‌های این بخش، کلیک ارگانیک Search Console هستند و با تعداد
            لیدهای داشبورد یکی محسوب نمی‌شوند.
          </small>
        </div>
        <button type="button" onClick={exportCsv} disabled={!rows.length}>
          ↓ خروجی CSV
        </button>
      </header>
      <div className="searchConsoleControls">
        <PersianDatePicker
          start={from}
          end={to}
          max={latestCompleteDate}
          onChange={(start, end) => {
            setFrom(start);
            setTo(end);
          }}
        />
        <label>
          <span>نوع جست‌وجو</span>
          <select
            value={searchType}
            onChange={(event) => setSearchType(event.target.value)}
          >
            {Object.entries(typeLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="searchConsoleRange">
          {persianDate(from)} تا {persianDate(to)} · فقط تا آخرین روز کامل ·
          مقایسه با بازهٔ هم‌طول قبل
        </span>
      </div>
      {(error || report?.stale || report?.connected === false) && (
        <div className="adsConnectionEntry">
          <div>
            <strong>اتصال Search Console نیازمند بررسی است</strong>
            <p>{error || "آخرین دادهٔ سالم ذخیره‌شده نمایش داده می‌شود."}</p>
          </div>
          <button
            type="button"
            className="secondarySetupAction"
            onClick={onSetup}
          >
            تنظیم و آزمایش اتصال
          </button>
        </div>
      )}
      {loading && (
        <div className="selectedDateEmpty loading">
          <i>↻</i>
          <span>در حال دریافت داده‌های Search Console…</span>
        </div>
      )}
      {report && !loading && (
        <>
          <div className="searchConsoleKpis">
            {(Object.keys(metricMeta) as MetricKey[]).map((metric) => (
              <button
                type="button"
                key={metric}
                className={`searchConsoleKpiCard ${metricMeta[metric].className}${selectedMetrics.includes(metric) ? " active" : ""}`}
                aria-pressed={selectedMetrics.includes(metric)}
                onClick={() => toggleMetric(metric)}
              >
                <span>{metricMeta[metric].label}</span>
                <strong>{metricValue(report.totals[metric], metric)}</strong>
                <small>
                  {metricValue(report.previousTotals[metric], metric)} بازه قبل
                  ·{" "}
                  <b>
                    {delta(
                      report.totals[metric],
                      report.previousTotals[metric],
                    )}
                  </b>
                </small>
              </button>
            ))}
          </div>
          <div className="searchConsoleSelectionHint">
            {selectedMetrics.length.toLocaleString("en-US")} از ۴ معیار انتخاب
            شده · برای نمودار، معیار فعال را انتخاب کنید؛ جدول همهٔ معیارهای
            انتخاب‌شده را نشان می‌دهد.
          </div>
          {report.stale && (
            <div className="dataWarning" role="status">
              <strong>⚠ نمایش آخرین گزارش سالم</strong>
              <span>
                اتصال لحظه‌ای پاسخ نداد و دادهٔ ذخیره‌شده نمایش داده می‌شود.
              </span>
            </div>
          )}
          {report.incompleteFrom && (
            <div className="dataWarning" role="status">
              <strong>داده‌های تازه هنوز نهایی نشده‌اند</strong>
              <span>
                اطلاعات از {persianDate(report.incompleteFrom)} به بعد ممکن است
                توسط Google اصلاح شود.
              </span>
            </div>
          )}
          <article className={`searchConsoleChart ${meta.className}`}>
            <header>
              <strong>روند روزانه {meta.label}</strong>
              <small>
                <i className="current" />
                بازه فعلی <i className="previous" />
                بازه قبل
              </small>
            </header>
            <div className="searchConsoleChartViewport" tabIndex={0}>
              <svg
                viewBox={`0 0 ${chartWidth} 205`}
                style={{ width: `${chartWidth}px`, minWidth: "100%" }}
                role="img"
                aria-label={`نمودار مقایسه ${meta.label} روزانه`}
              >
                {[0, 1, 2, 3].map((line) => (
                  <line
                    x1="30"
                    x2={chartWidth - 25}
                    y1={48 + line * 37}
                    y2={48 + line * 37}
                    key={line}
                  />
                ))}
                <polyline
                  className="previous"
                  points={(report.previousDaily || [])
                    .map((day, index) => point(day[activeMetric], index))
                    .join(" ")}
                />
                <polyline
                  className="current"
                  points={(report.daily || [])
                    .map((day, index) => point(day[activeMetric], index))
                    .join(" ")}
                />
                {(report.previousDaily || []).map((day, index) => (
                  <g
                    className="searchConsolePreviousPoint"
                    key={`previous-${day.date}`}
                  >
                    <circle
                      className="previousPoint"
                      cx={40 + index * chartStep}
                      cy={pointY(day[activeMetric])}
                      r="3.5"
                      onMouseEnter={() =>
                        showChartHover({
                          series: "previous",
                          date: day.date,
                          value: day[activeMetric],
                          x: 40 + index * chartStep,
                          y: pointY(day[activeMetric]),
                        })
                      }
                      onMouseLeave={() => setChartHover(null)}
                    >
                      <title>
                        {persianDate(day.date)} · بازه قبل ·{" "}
                        {metricValue(day[activeMetric], activeMetric)}
                      </title>
                    </circle>
                  </g>
                ))}
                {(report.daily || []).map((day, index) => (
                  <g className="searchConsoleCurrentPoint" key={day.date}>
                    <circle
                      className="currentPoint"
                      cx={40 + index * chartStep}
                      cy={pointY(day[activeMetric])}
                      r="3"
                      onMouseEnter={() =>
                        showChartHover({
                          series: "current",
                          date: day.date,
                          value: day[activeMetric],
                          x: 40 + index * chartStep,
                          y: pointY(day[activeMetric]),
                        })
                      }
                      onMouseLeave={() => setChartHover(null)}
                    >
                      <title>
                        {persianDate(day.date)} ·{" "}
                        {metricValue(day[activeMetric], activeMetric)}
                      </title>
                    </circle>
                    <text
                      className="currentValueLabel"
                      x={40 + index * chartStep}
                      y={Math.max(16, pointY(day[activeMetric]) - 9)}
                    >
                      {metricValue(day[activeMetric], activeMetric)}
                    </text>
                    <text x={40 + index * chartStep} y="190">
                      {new Date(`${day.date}T00:00:00Z`)
                        .getUTCDate()
                        .toLocaleString("en-US")}
                    </text>
                  </g>
                ))}
              </svg>
              {chartHover && (
                <div
                  className="searchConsoleChartTooltip"
                  style={{
                    left:
                      Math.min(Math.max(chartHover.x, 90), chartWidth - 90) -
                      84,
                    top: Math.max(8, chartHover.y - 44),
                  }}
                  role="status"
                >
                  <strong>{persianDate(chartHover.date)}</strong>
                  <span>
                    {chartHover.series === "current" ? "بازه فعلی" : "بازه قبل"}{" "}
                    · {metricValue(chartHover.value, activeMetric)}
                  </span>
                </div>
              )}
            </div>
          </article>
          <section className={`searchConsoleTableSection ${meta.className}`}>
            <header>
              <div className="dimensionTabs" role="tablist">
                {Object.entries(dimensionLabels).map(([value, label]) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={dimension === value}
                    className={dimension === value ? "active" : ""}
                    onClick={() => setDimension(value)}
                    key={value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="searchConsoleFilter">
                <span>فیلتر جدول</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`جست‌وجو در ${dimensionLabels[dimension]}`}
                />
              </label>
            </header>
            <div className="activeMetricHint">
              نمایش دادهٔ انتخاب‌شده: <b>{meta.label}</b> · با کلیک روی کارت
              بالا معیار را تغییر دهید.
            </div>
            <div className="searchConsoleTableWrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <button type="button" onClick={() => changeSort("key")}>
                        {dimensionLabels[dimension]}
                        {sortMark("key")}
                      </button>
                    </th>
                    {selectedMetrics.map((metric) => (
                      <th colSpan={3} key={metric}>
                        <button
                          type="button"
                          onClick={() => setActiveMetric(metric)}
                        >
                          {metricMeta[metric].short} · معیار فعال
                        </button>
                      </th>
                    ))}
                  </tr>
                  <tr className="searchConsoleMetricSubhead">
                    <th />
                    {selectedMetrics.map((metric) => {
                      const currentKey = metricSortKey(metric, "current");
                      const previousKey = metricSortKey(metric, "previous");
                      const differenceKey = metricSortKey(metric, "difference");
                      return (
                        <Fragment key={metric}>
                          <th
                            aria-sort={
                              sort.key === currentKey
                                ? sort.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                          >
                            <button
                              type="button"
                              className={
                                sort.key === currentKey ? "active" : ""
                              }
                              onClick={() => changeSort(currentKey)}
                            >
                              فعلی{sortMark(currentKey)}
                            </button>
                          </th>
                          <th
                            aria-sort={
                              sort.key === previousKey
                                ? sort.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                          >
                            <button
                              type="button"
                              className={
                                sort.key === previousKey ? "active" : ""
                              }
                              onClick={() => changeSort(previousKey)}
                            >
                              بازه قبل{sortMark(previousKey)}
                            </button>
                          </th>
                          <th
                            aria-sort={
                              sort.key === differenceKey
                                ? sort.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                          >
                            <button
                              type="button"
                              className={
                                sort.key === differenceKey ? "active" : ""
                              }
                              onClick={() => changeSort(differenceKey)}
                            >
                              تفاوت{sortMark(differenceKey)}
                            </button>
                          </th>
                        </Fragment>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    return (
                      <tr key={row.key}>
                        <td dir={dimension === "page" ? "ltr" : undefined}>
                          {row.key}
                        </td>
                        {selectedMetrics.map((metric) => {
                          const difference =
                            row.current[metric] - row.previous[metric];
                          return (
                            <Fragment key={metric}>
                              <td>
                                {metricValue(row.current[metric], metric)}
                              </td>
                              <td>
                                {metricValue(row.previous[metric], metric)}
                              </td>
                              <td
                                className={
                                  difference > 0
                                    ? "positive"
                                    : difference < 0
                                      ? "negative"
                                      : ""
                                }
                              >
                                {difference > 0 ? "+" : ""}
                                {metricValue(difference, metric)}
                              </td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    );
                  })}
          </tbody>
        </table>
            </div>
            <footer>
              <span>
                {number(rows.length)} ردیف · صفحه {page.toLocaleString("en-US")}{" "}
                از {pageCount.toLocaleString("en-US")}
              </span>
              <div>
                <button
                  type="button"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={page === 1}
                >
                  قبلی
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPage((value) => Math.min(pageCount, value + 1))
                  }
                  disabled={page === pageCount}
                >
                  بعدی
                </button>
              </div>
            </footer>
          </section>
          <SeoPrioritySection
            report={report}
            dimension={dimension}
            brandId={brandId}
            from={from}
            to={to}
          />
        </>
      )}
    </section>
  );
}
