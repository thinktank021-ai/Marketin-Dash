import type { ChannelRule } from "./dashboard-rules";

export type FinancialChannel = { name: string; color: string; leads: number; contracts: number; conversionRate: number | null; costToman: number | null; cpl: number | null; cac: number | null };
export type MissingDailyCost = { date: string; channel: string };

/** Future days never create required costs; an explicitly saved zero is complete. */
export function findMissingDailyCosts(input: {
  dates: string[]; start: string; end: string; today: string;
  channels: ChannelRule[];
  entries: Array<{ date: string; amounts: Record<string, number | null> }>;
}): MissingDailyCost[] {
  const end = input.end < input.today ? input.end : input.today;
  const entries = new Map(input.entries.map(entry => [entry.date, entry.amounts]));
  const channels = input.channels.filter(channel => channel.enabled && channel.costMode === "daily_budget");
  return [...new Set(input.dates)].filter(date => date >= input.start && date <= end).sort().flatMap(date =>
    channels.filter(channel => entries.get(date)?.[channel.id] == null).map(channel => ({ date, channel: channel.name })));
}

/** Every enabled paid source gets a card; shared Google Ads costs are counted exactly once. */
export function buildFinancialChannels(channels: ChannelRule[], leads: Record<string, number>, contracts: Record<string, number>, costs: Record<string, number | null>): FinancialChannel[] {
  const enabled = channels.filter(channel => channel.enabled && channel.costMode !== "none");
  let adsAdded = false;
  return enabled.flatMap(channel => {
    if (channel.costMode === "google_ads" && adsAdded) return [];
    const group = channel.costMode === "google_ads" ? enabled.filter(item => item.costMode === "google_ads") : [channel];
    if (channel.costMode === "google_ads") adsAdded = true;
    const identity = group.find(item => item.id === "google_ads") || channel;
    const leadCount = group.reduce((sum, item) => sum + (leads[item.name] || 0), 0);
    const contractCount = group.reduce((sum, item) => sum + (contracts[item.name] || 0), 0);
    const values = group.map(item => costs[item.name]);
    const costToman = values.every(value => typeof value === "number" && Number.isFinite(value)) ? values.reduce<number>((sum, value) => sum + (value || 0), 0) : null;
    return [{ name: identity.name, color: identity.color, leads: leadCount, contracts: contractCount, conversionRate: leadCount > 0 ? (contractCount / leadCount) * 100 : null, costToman, cpl: costToman !== null && leadCount > 0 ? costToman / leadCount : null, cac: costToman !== null && contractCount > 0 ? costToman / contractCount : null }];
  });
}
