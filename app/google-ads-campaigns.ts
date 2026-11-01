export type CampaignSortItem = {
  campaignId: string;
  name: string;
  status: string;
  cost: number;
  impressions: number;
  clicks: number;
  lastActivityDate?: string;
};

export type RoutePerformanceItem = {
  route: string;
  leads: number;
  campaignIds: string[];
  campaignNames: string[];
  cost: number;
  impressions: number;
  clicks: number;
  cpl: number | null;
  ctr: number;
  leadRate: number;
};

export type RoutePerformance = {
  routes: RoutePerformanceItem[];
  missingRouteLeads: number;
  unmatchedRoutes: Array<{ route: string; leads: number }>;
  unmatchedCampaigns: CampaignSortItem[];
  ambiguousCampaigns: Array<{ campaign: CampaignSortItem; routes: string[] }>;
};

/** Assigns one route-level metric only when that route maps to exactly one campaign. */
export function attributeRouteMetricToCampaigns(
  routes: RoutePerformanceItem[],
  metricByRoute: Record<string, number>,
) {
  const result: Record<string, number | null> = {};
  routes.forEach(route => {
    if (route.campaignIds.length === 1) result[route.campaignIds[0]] = metricByRoute[route.route] || 0;
    else route.campaignIds.forEach(campaignId => { result[campaignId] = null; });
  });
  return result;
}

type MergeRule = { target: string; aliases: string[] };

function comparableWords(value: string) {
  return value.normalize("NFKC").replace(/ي|ى/g, "ی").replace(/ك/g, "ک")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLocaleLowerCase("fa");
}

function containsWholePhrase(name: string, phrase: string) {
  return ` ${name} `.includes(` ${phrase} `);
}

const CAMPAIGN_ROUTE_LANGUAGE_ALIASES: Record<string, string[]> = {
  "استانبول": ["istanbul"],
  "گرجستان": ["georgia", "tbilisi", "batumi"],
  "ارمنستان": ["armenia", "yerevan"],
  "تایلند": ["thailand"],
  "مالزی": ["malaysia"],
  "کوالالامپور": ["kuala lumpur", "kualalumpur"],
  "بالی": ["bali"],
  "روسیه": ["russia", "moscow"],
  "آنتالیا": ["antalya"],
  "آلانیا": ["alanya"],
  "وان": ["van"],
  "کوش آداسی": ["kusadasi", "kuşadası"],
  "مسقط": ["muscat"],
  "هند": ["india"],
  "قونیه": ["konya"],
  "دبی": ["dubai"],
  "باکو": ["baku"],
};

/** Aggregates every campaign mapped to one route; no lead is split between campaigns. */
export function buildRoutePerformance(
  campaigns: CampaignSortItem[],
  dailyRouteLeads: Record<string, Record<string, number>>,
  mergeRules: MergeRule[],
): RoutePerformance {
  const leadTotals = new Map<string, number>();
  Object.values(dailyRouteLeads).forEach(day => Object.entries(day).forEach(([route, leads]) => leadTotals.set(route, (leadTotals.get(route) || 0) + leads)));
  const routeDefinitions = [...leadTotals.keys()].filter(route => route !== "مسیر ثبت نشده").map(route => {
    const canonical = comparableWords(route);
    const rule = mergeRules.find(item => comparableWords(item.target) === canonical);
    const builtInAliases = CAMPAIGN_ROUTE_LANGUAGE_ALIASES[route] || [];
    const terms = [...new Set([route, ...(rule?.aliases || []), ...builtInAliases].map(comparableWords).filter(Boolean))];
    return { route, terms };
  });
  const buckets = new Map(routeDefinitions.map(item => [item.route, {
    route: item.route,
    leads: leadTotals.get(item.route) || 0,
    campaignIds: [] as string[],
    campaignNames: [] as string[],
    cost: 0,
    impressions: 0,
    clicks: 0,
  }]));
  const unmatchedCampaigns: CampaignSortItem[] = [];
  const ambiguousCampaigns: RoutePerformance["ambiguousCampaigns"] = [];

  campaigns.filter(campaign => campaign.cost > 0 || campaign.clicks > 0 || campaign.impressions > 0).forEach(campaign => {
    const name = comparableWords(campaign.name);
    const matches = routeDefinitions.filter(route => route.terms.some(term => containsWholePhrase(name, term)));
    if (matches.length === 0) {
      unmatchedCampaigns.push(campaign);
      return;
    }
    if (matches.length > 1) {
      ambiguousCampaigns.push({ campaign, routes: matches.map(match => match.route) });
      return;
    }
    const bucket = buckets.get(matches[0].route)!;
    bucket.campaignIds.push(campaign.campaignId);
    bucket.campaignNames.push(campaign.name);
    bucket.cost += campaign.cost;
    bucket.impressions += campaign.impressions;
    bucket.clicks += campaign.clicks;
  });

  const routes = [...buckets.values()].map(bucket => ({
    ...bucket,
    cpl: bucket.campaignIds.length > 0 && bucket.leads > 0 ? bucket.cost / bucket.leads : null,
    ctr: bucket.impressions > 0 ? bucket.clicks / bucket.impressions * 100 : 0,
    leadRate: bucket.clicks > 0 ? bucket.leads / bucket.clicks * 100 : 0,
  })).sort((left, right) => right.leads - left.leads || right.cost - left.cost || left.route.localeCompare(right.route, "fa"));
  return {
    routes,
    missingRouteLeads: leadTotals.get("مسیر ثبت نشده") || 0,
    unmatchedRoutes: routes.filter(route => route.leads > 0 && route.campaignIds.length === 0).map(route => ({ route: route.route, leads: route.leads })),
    unmatchedCampaigns,
    ambiguousCampaigns,
  };
}

function statusRank(status: string) {
  if (status === "ENABLED") return 0;
  if (status === "PAUSED") return 1;
  return 2;
}

function hasDelivery(campaign: CampaignSortItem) {
  return campaign.cost > 0 || campaign.clicks > 0 || campaign.impressions > 0;
}

/** Keeps enabled campaigns first, then prioritizes paused campaigns by their latest delivery inside the selected range. */
export function sortGoogleAdsCampaigns(campaigns: CampaignSortItem[]) {
  return [...campaigns].sort((left, right) => {
    const byStatus = statusRank(left.status) - statusRank(right.status);
    if (byStatus) return byStatus;
    const byDelivery = Number(hasDelivery(right)) - Number(hasDelivery(left));
    if (byDelivery) return byDelivery;
    const byLastActivity = (right.lastActivityDate || "").localeCompare(left.lastActivityDate || "");
    if (byLastActivity) return byLastActivity;
    return right.cost - left.cost || right.clicks - left.clicks || right.impressions - left.impressions || left.name.localeCompare(right.name);
  });
}
