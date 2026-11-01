export type ReportPublishedMonth = { value: string; label: string; gid: string; sheetName: string };

/** Selects the exact Persian month tab by its canonical YYYY/MM value. */
export function selectCurrentReportMonth(months: ReportPublishedMonth[], reportDate: string) {
  const currentValue = reportDate.slice(0, 7);
  return months.find(month => month.value === currentValue && /^-?\d+$/.test(month.gid)) || null;
}
