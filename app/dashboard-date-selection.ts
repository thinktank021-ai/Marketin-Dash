export type DailyReportDateMode = "selected" | "today" | "latest" | "empty";

export type DailyReportDateResolution = {
  date: string;
  mode: DailyReportDateMode;
};

/**
 * Chooses the day used by the top-level dashboard cards.
 * A deliberate date selection must never fall back to yesterday/latest data.
 */
export function resolveDailyReportDate({
  selectedMonth,
  currentMonth,
  todayDate,
  manualDateOverride,
  availableDates,
}: {
  selectedMonth: string;
  currentMonth: string;
  todayDate: string;
  manualDateOverride: string | null;
  availableDates: string[];
}): DailyReportDateResolution {
  const dates = [...new Set(availableDates.filter(Boolean))].sort();
  const selectedDate = manualDateOverride?.startsWith(`${selectedMonth}/`)
    ? manualDateOverride
    : "";

  if (selectedDate) {
    return dates.includes(selectedDate)
      ? { date: selectedDate, mode: "selected" }
      : { date: "", mode: "empty" };
  }

  // The current day's zero is a real dashboard state. Do not replace it with yesterday's data.
  if (selectedMonth === currentMonth) {
    return { date: todayDate, mode: "today" };
  }

  return dates.at(-1)
    ? { date: dates.at(-1)!, mode: "latest" }
    : { date: "", mode: "empty" };
}
