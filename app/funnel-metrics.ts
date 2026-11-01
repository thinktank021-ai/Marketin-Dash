export type SmsEstimate = {
  total: number | null;
  missingBudgetDates: string[];
  missingPriceMonths: string[];
};

/** Estimates messages from actual daily SMS spend while preserving missing data as unknown. */
export function estimateSmsMessages(
  workdays: string[],
  amountByDate: ReadonlyMap<string, number | null | undefined>,
  priceByMonth: ReadonlyMap<string, number>,
): SmsEstimate {
  const missingBudgetDates = workdays.filter(date => amountByDate.get(date) == null);
  const missingPriceMonths = [...new Set(workdays
    .filter(date => {
      const price = priceByMonth.get(date.slice(0, 7));
      return !Number.isSafeInteger(price) || Number(price) <= 0;
    })
    .map(date => date.slice(0, 7)))];
  if (missingBudgetDates.length || missingPriceMonths.length) return { total: null, missingBudgetDates, missingPriceMonths };
  const total = workdays.reduce((sum, date) => {
    const amount = amountByDate.get(date) as number;
    const price = priceByMonth.get(date.slice(0, 7)) as number;
    return sum + Math.floor(amount / price);
  }, 0);
  return { total, missingBudgetDates, missingPriceMonths };
}

/** Uses every available exposure source while keeping the all-missing state unknown. */
export function combineInitialInteractions(smsSent: number | null, adsImpressions: number | null) {
  if (smsSent === null && adsImpressions === null) return null;
  return (smsSent ?? 0) + (adsImpressions ?? 0);
}

/** Calculates cumulative funnel percentages from the first known input and keeps step rates separate. */
export function calculateFunnelRates(
  awarenessTotal: number | null,
  leads: number,
  resolved: number,
  contracts: number,
) {
  const fromAwareness = (value: number) =>
    awarenessTotal !== null && awarenessTotal > 0
      ? (value / awarenessTotal) * 100
      : null;
  return {
    awarenessRate: awarenessTotal !== null && awarenessTotal > 0 ? 100 : null,
    leadsRate: fromAwareness(leads),
    resolvedRate: fromAwareness(resolved),
    contractsRate: fromAwareness(contracts),
    resolvedStepRate: leads > 0 ? (resolved / leads) * 100 : null,
    contractStepRate: resolved > 0 ? (contracts / resolved) * 100 : null,
    overallLeadToContractRate: leads > 0 ? (contracts / leads) * 100 : null,
  };
}
