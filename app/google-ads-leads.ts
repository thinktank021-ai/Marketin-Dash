import type { ChannelRule } from "./dashboard-rules";

// Product rule: these Sheet surfaces belong to Google Ads attribution even if a manager changes their cost selector.
export const GOOGLE_ADS_LEAD_CHANNEL_IDS = ["google_ads", "whatsapp", "site_form"] as const;

/** Resolves the fixed Google Ads attribution group through stable channel IDs, preserving manager-facing labels. */
export function resolveGoogleAdsLeadChannels(channels: ChannelRule[]) {
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  return GOOGLE_ADS_LEAD_CHANNEL_IDS
    .map(id => byId.get(id))
    .filter((channel): channel is ChannelRule => Boolean(channel?.enabled))
    .map(channel => channel.name);
}

export type SheetMonthRequest = { value: string; label: string; gid: string; sheetName?: string };

/** Covers every month in a requested range and falls back to its tab label when discovery metadata is stale. */
export function resolveSheetMonthRequests(
  requested: Array<{ value: string; label: string }>,
  discovered: SheetMonthRequest[],
) {
  const registry = new Map(discovered.map(month => [month.value, month]));
  return requested.map(month => registry.get(month.value) || { ...month, gid: "" });
}
