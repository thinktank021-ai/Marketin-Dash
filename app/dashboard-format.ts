/** Keeps calculations precise while presenting every dashboard metric as a rounded whole number. */
export function formatDashboardNumber(value: number) {
  const finiteValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return Math.round(finiteValue).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** Formats a rounded whole-number financial value in toman. */
export function formatDashboardToman(value: number) {
  // Unit-first keeps «تومان» visually to the left of the number in RTL cards.
  return `تومان ${formatDashboardNumber(value)}`;
}
