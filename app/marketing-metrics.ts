export type OverallRangeMetricInput = {
  paidChannels: string[];
  costsByChannel: Record<string, number | null | undefined>;
  leadsByChannel: Record<string, number>;
  contractsByChannel: Record<string, number>;
  totalContracts: number | null;
  coverageIncomplete: boolean;
};

export type OverallRangeMetric = {
  totalCost: number | null;
  paidLeads: number;
  attributableContracts: number;
  totalContracts: number;
  cpl: number | null;
  cac: number | null;
  coverageComplete: boolean;
  coveredCost: number | null;
  coveredLeads: number;
  coveredContracts: number;
  coveredCpl: number | null;
  coveredCac: number | null;
  missingChannels: string[];
};

export type ContractRouteChannelMatrix = Record<string, Record<string, Record<string, number>>>;
export type RankedContractRoute = { name: string; count: number; channels: Array<{ name: string; count: number }> };

/** Combines approved source aliases into one manager-facing budget chip without mutating stored costs. */
export function aggregateDisplayCosts(
  costsByChannel: Record<string, number | null | undefined>,
  groupedChannels: string[],
  groupLabel: string,
) {
  const grouped = new Set(groupedChannels);
  const totals = new Map<string, number>();
  Object.entries(costsByChannel).forEach(([channel, cost]) => {
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return;
    const label = grouped.has(channel) ? groupLabel : channel;
    totals.set(label, (totals.get(label) || 0) + cost);
  });
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b, "fa", { sensitivity: "base" }));
}

/** Ranks real destinations by attributable contracts across all experts in the selected range. */
export function rankContractRoutes(
  matrix: ContractRouteChannelMatrix,
  selectedChannels: string[] = [],
  limit = 10,
): RankedContractRoute[] {
  const channelFilter = new Set(selectedChannels);
  const totals: Record<string, { count: number; channels: Record<string, number> }> = {};
  Object.values(matrix).forEach(routeMap => {
    Object.entries(routeMap).forEach(([route, channels]) => {
      if (route === "بدون مسیر قابل انتساب" || route === "مسیر ثبت نشده") return;
      Object.entries(channels).forEach(([channel, rawValue]) => {
        if (channelFilter.size > 0 && !channelFilter.has(channel)) return;
        const count = Math.max(0, rawValue || 0);
        if (count === 0) return;
        totals[route] ||= { count: 0, channels: {} };
        totals[route].count += count;
        totals[route].channels[channel] = (totals[route].channels[channel] || 0) + count;
      });
    });
  });
  return Object.entries(totals)
    .map(([name, data]) => ({
      name,
      count: data.count,
      channels: Object.entries(data.channels)
        .map(([channel, count]) => ({ name: channel, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fa")),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fa"))
    .slice(0, Math.max(0, limit));
}

/** Calculates strict brand-wide CPL/CAC from the exact same paid-channel set. */
export function calculateOverallRangeMetric(input: OverallRangeMetricInput): OverallRangeMetric {
  const paidChannels = [...new Set(input.paidChannels)];
  const costs = paidChannels.map(channel => input.costsByChannel[channel]);
  const coverageComplete = paidChannels.length > 0
    && !input.coverageIncomplete
    && costs.every((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost >= 0);
  const totalCost = coverageComplete ? (costs as number[]).reduce((sum, cost) => sum + cost, 0) : null;
  const paidLeads = paidChannels.reduce((sum, channel) => sum + Math.max(0, input.leadsByChannel[channel] || 0), 0);
  const attributableContracts = paidChannels.reduce((sum, channel) => sum + Math.max(0, input.contractsByChannel[channel] || 0), 0);
  const totalContracts = Math.max(attributableContracts, input.totalContracts || 0);
  const coveredChannels = paidChannels.filter(channel => typeof input.costsByChannel[channel] === "number" && Number.isFinite(input.costsByChannel[channel]) && input.costsByChannel[channel]! >= 0);
  const coveredCost = coveredChannels.length ? coveredChannels.reduce((sum, channel) => sum + input.costsByChannel[channel]!, 0) : null;
  const coveredLeads = coveredChannels.reduce((sum, channel) => sum + Math.max(0, input.leadsByChannel[channel] || 0), 0);
  const coveredContracts = coveredChannels.reduce((sum, channel) => sum + Math.max(0, input.contractsByChannel[channel] || 0), 0);
  return {
    coveredCost, coveredLeads, coveredContracts,
    coveredCpl: coveredCost !== null && coveredLeads > 0 ? coveredCost / coveredLeads : null,
    coveredCac: coveredCost !== null && coveredContracts > 0 ? coveredCost / coveredContracts : null,
    missingChannels: paidChannels.filter(channel => !coveredChannels.includes(channel)),
    totalCost,
    paidLeads,
    attributableContracts,
    totalContracts,
    cpl: totalCost !== null && paidLeads > 0 ? totalCost / paidLeads : null,
    cac: totalCost !== null && attributableContracts > 0 ? totalCost / attributableContracts : null,
    coverageComplete,
  };
}
