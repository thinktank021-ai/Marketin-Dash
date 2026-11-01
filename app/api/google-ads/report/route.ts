import { getD1 } from "../../../../db";
import { getBrand, getRequestBrandId } from "../../brands/storage";
import { getPublicGoogleAdsSettings, queryGoogleAds } from "../service-account";
import { accountStatusAlert, campaignLimitedAlert, policyAlert, type GoogleAdsAlert } from "../../../google-ads-alerts";

const CREATE_CACHE_TABLE = `CREATE TABLE IF NOT EXISTS google_ads_report_cache (
  cache_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
const LIVE_REPORT_TTL_MS = 30000;

function isIsoDate(value: string | null): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function sqliteUtcToMs(value: string) { return Date.parse(`${value.replace(" ", "T")}Z`); }
function numeric(value: unknown) { const parsed = Number(value || 0); return Number.isFinite(parsed) ? parsed : 0; }

async function ensureReportCache() {
  const d1 = getD1();
  await d1.prepare(CREATE_CACHE_TABLE).run();
  return d1;
}

async function fetchServiceAccountReport(brandId: string, customerId: string, loginCustomerId: string, from: string, to: string) {
  const [accountRows, metricRows, campaignScan, policyScan] = await Promise.all([
    queryGoogleAds(brandId, customerId, loginCustomerId, "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 1"),
    queryGoogleAds(brandId, customerId, loginCustomerId, `SELECT segments.date, campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`),
    queryGoogleAds(brandId, customerId, loginCustomerId, "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.status != 'REMOVED' AND campaign.primary_status = 'LIMITED'")
      .then(rows => ({ complete: true, rows })).catch(() => ({ complete: false, rows: [] as Array<Record<string, unknown>> })),
    queryGoogleAds(brandId, customerId, loginCustomerId, "SELECT campaign.id, campaign.name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED','APPROVED_LIMITED')")
      .then(rows => ({ complete: true, rows })).catch(() => ({ complete: false, rows: [] as Array<Record<string, unknown>> })),
  ]);
  const customer = (accountRows[0] as { customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string; status?: string } } | undefined)?.customer;
  const alerts: GoogleAdsAlert[] = [];
  const customerAlert = accountStatusAlert(customer?.status, customer?.descriptiveName || customerId);
  if (customerAlert) alerts.push(customerAlert);
  campaignScan.rows.forEach(raw => {
    const campaign = (raw as { campaign?: { id?: string; name?: string; primaryStatus?: string; primaryStatusReasons?: string[] } }).campaign;
    const alert = campaign ? campaignLimitedAlert(campaign) : null;
    if (alert) alerts.push(alert);
  });
  policyScan.rows.forEach(raw => {
    const row = raw as { campaign?: { name?: string }; adGroupAd?: { ad?: { id?: string }; policySummary?: { approvalStatus?: string; policyTopicEntries?: Array<{ topic?: string }> } } };
    const alert = policyAlert({ adId: row.adGroupAd?.ad?.id, campaignName: row.campaign?.name, approvalStatus: row.adGroupAd?.policySummary?.approvalStatus, topics: row.adGroupAd?.policySummary?.policyTopicEntries?.map(entry => entry.topic || "").filter(Boolean) });
    if (alert) alerts.push(alert);
  });
  alerts.sort((left, right) => Number(right.severity === "critical") - Number(left.severity === "critical") || left.kind.localeCompare(right.kind));
  const campaigns = new Map<string, { id: string; name: string; status: string; impressions: number; clicks: number; cost: number; lastActivityDate?: string }>();
  const daily = new Map<string, { date: string; impressions: number; clicks: number; cost: number }>();
  const campaignDaily = new Map<string, { campaignId: string; date: string; impressions: number; clicks: number; cost: number }>();
  metricRows.forEach(raw => {
    const row = raw as { segments?: { date?: string }; campaign?: { id?: string; name?: string; status?: string }; metrics?: { impressions?: string | number; clicks?: string | number; costMicros?: string | number } };
    const date = row.segments?.date || "";
    const id = String(row.campaign?.id || "");
    const impressions = numeric(row.metrics?.impressions);
    const clicks = numeric(row.metrics?.clicks);
    const cost = numeric(row.metrics?.costMicros) / 1_000_000;
    if (date) {
      const value = daily.get(date) || { date, impressions: 0, clicks: 0, cost: 0 };
      value.impressions += impressions; value.clicks += clicks; value.cost += cost; daily.set(date, value);
    }
    if (id) {
      const value = campaigns.get(id) || { id, name: row.campaign?.name || id, status: row.campaign?.status || "UNKNOWN", impressions: 0, clicks: 0, cost: 0 };
      value.impressions += impressions; value.clicks += clicks; value.cost += cost; campaigns.set(id, value);
      if (date && (impressions > 0 || clicks > 0 || cost > 0) && date > (value.lastActivityDate || "")) value.lastActivityDate = date;
      if (date) campaignDaily.set(`${id}:${date}`, { campaignId: id, date, impressions, clicks, cost });
    }
  });
  const dailyRows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    connected: true,
    account: { customerId, name: customer?.descriptiveName || customerId, currencyCode: customer?.currencyCode || "TRY", timeZone: customer?.timeZone || "", status: customer?.status || "UNKNOWN" },
    alerts,
    alertScan: { campaignsComplete: campaignScan.complete, policiesComplete: policyScan.complete },
    totals: { impressions: dailyRows.reduce((sum, row) => sum + row.impressions, 0), clicks: dailyRows.reduce((sum, row) => sum + row.clicks, 0), cost: dailyRows.reduce((sum, row) => sum + row.cost, 0) },
    campaigns: [...campaigns.values()].map(({ id, ...campaign }) => ({ campaignId: id, ...campaign })),
    campaignDaily: [...campaignDaily.values()].sort((left, right) => left.date.localeCompare(right.date) || left.campaignId.localeCompare(right.campaignId)),
    daily: dailyRows,
  };
}

export async function GET(request: Request) {
  const brandId = await getRequestBrandId(request);
  const brand = await getBrand(brandId);
  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return Response.json({ error: "بازهٔ تاریخ معتبر نیست." }, { status: 400 });
  const settings = await getPublicGoogleAdsSettings(brandId);
  if (!brand.googleAdsCustomerId || !settings.hasServiceAccount || !settings.hasDeveloperToken) {
    return Response.json({ connected: false, pending: true, stale: false, reason: "service_account_not_configured", error: "اتصال Service Account این دفتر کامل نیست." }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  const cacheKey = `${brandId}:${from}:${to}`;
  let cached: { payload: string; savedAt: string } | null = null;
  try {
    const d1 = await ensureReportCache();
    cached = await d1.prepare("SELECT payload, saved_at AS savedAt FROM google_ads_report_cache WHERE cache_key = ?").bind(cacheKey).first<{ payload: string; savedAt: string }>();
    if (cached && Date.now() - sqliteUtcToMs(cached.savedAt) <= LIVE_REPORT_TTL_MS && request.headers.get("x-dashboard-refresh") !== "1") {
      return Response.json({ ...JSON.parse(cached.payload) as Record<string, unknown>, connected: true, stale: false, cached: true, lastSuccessfulAt: cached.savedAt }, { headers: { "cache-control": "no-store" } });
    }
  } catch { /* A cache failure must not block a live report. */ }

  try {
    const payload = await fetchServiceAccountReport(brandId, brand.googleAdsCustomerId, brand.googleAdsLoginCustomerId, from, to);
    try {
      const d1 = await ensureReportCache();
      await d1.prepare(`INSERT INTO google_ads_report_cache (cache_key, payload, saved_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, saved_at = CURRENT_TIMESTAMP`).bind(cacheKey, JSON.stringify(payload)).run();
    } catch { /* Cache persistence is optional. */ }
    return Response.json({ ...payload, stale: false }, { headers: { "cache-control": "no-store" } });
  } catch {
    if (cached) return Response.json({ ...JSON.parse(cached.payload) as Record<string, unknown>, connected: false, stale: true, lastSuccessfulAt: cached.savedAt }, { headers: { "cache-control": "no-store" } });
    return Response.json({ connected: false, stale: true, error: "داده‌ای از Google Ads دریافت نشد؛ تنظیمات Service Account همین دفتر را بررسی کنید." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
