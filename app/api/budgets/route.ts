import { DEFAULT_DASHBOARD_RULES, validateDashboardRules } from "../../dashboard-rules";
import { getRequestBrandId } from "../brands/storage";
import { ensureScopedStorage } from "../brands/scoped-storage";

type BudgetValue = number | null;
type BudgetEntry = { date: string; weekStart: string; weekday: string; amounts: Record<string, BudgetValue> };
type MonthlyChannelCost = { month: string; channelId: string; mediaToman: BudgetValue; contractorToman: BudgetValue };
type SmsUnitPrice = { month: string; priceToman: number; updatedAt?: string };

const isPersianDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}\/\d{2}\/\d{2}$/.test(value);
const validBudget = (value: unknown): value is BudgetValue => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

async function configuredRules(d1: Awaited<ReturnType<typeof ensureScopedStorage>>, brandId: string) {
  const row = await d1.prepare("SELECT config_json AS configJson FROM brand_dashboard_rules WHERE brand_id = ?").bind(brandId).first<{ configJson: string }>();
  return row ? validateDashboardRules(JSON.parse(row.configJson)) : DEFAULT_DASHBOARD_RULES;
}

/** Returns dynamic per-channel costs while falling back to untouched legacy values until they are next saved. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const weekStart = params.get("weekStart");
    const from = params.get("from");
    const to = params.get("to");
    const readsWeek = isPersianDate(weekStart);
    const readsRange = isPersianDate(from) && isPersianDate(to) && from <= to;
    if (!readsWeek && !readsRange) return Response.json({ error: "بازهٔ بودجه معتبر نیست." }, { status: 400 });
    const d1 = await ensureScopedStorage();
    const brandId = await getRequestBrandId(request);
    const rules = await configuredRules(d1, brandId);
    const start = readsWeek ? weekStart : from;
    const end = readsWeek ? `${weekStart.slice(0, 8)}31` : to;
    const base = await d1.prepare(`SELECT date, week_start AS weekStart, weekday, sms_toman AS smsToman,
      instagram_toman AS instagramToman, updated_at AS updatedAt FROM brand_weekly_ad_budgets
      WHERE brand_id = ? AND date BETWEEN ? AND ? ORDER BY date`).bind(brandId, start, end).all<Record<string, unknown>>();
    const daily = await d1.prepare(`SELECT date, channel_id AS channelId, amount_toman AS amountToman
      FROM brand_channel_daily_costs WHERE brand_id = ? AND date BETWEEN ? AND ? ORDER BY date, channel_id`).bind(brandId, start, end).all<{ date: string; channelId: string; amountToman: number }>();
    const dailyByDate = new Map<string, Record<string, number>>();
    daily.results.forEach(row => { const amounts = dailyByDate.get(row.date) || {}; amounts[row.channelId] = Number(row.amountToman); dailyByDate.set(row.date, amounts); });
    const entries = base.results.map(row => {
      const amounts: Record<string, BudgetValue> = { ...(dailyByDate.get(String(row.date)) || {}) };
      if (amounts.sms === undefined) amounts.sms = row.smsToman === null || row.smsToman === undefined ? null : Number(row.smsToman);
      if (amounts.instagram === undefined) amounts.instagram = row.instagramToman === null || row.instagramToman === undefined ? null : Number(row.instagramToman);
      return { date: row.date, weekStart: row.weekStart, weekday: row.weekday, amounts, updatedAt: row.updatedAt };
    });
    const months = [...new Set(entries.map(row => String(row.date).slice(0, 7)))];
    const monthFrom = months[0] || start.slice(0, 7), monthTo = months.at(-1) || end.slice(0, 7);
    const monthly = await d1.prepare(`SELECT month, channel_id AS channelId, media_toman AS mediaToman, contractor_toman AS contractorToman
      FROM brand_channel_monthly_costs WHERE brand_id = ? AND month BETWEEN ? AND ? ORDER BY month, channel_id`).bind(brandId, monthFrom, monthTo).all<MonthlyChannelCost>();
    const monthlyCosts = [...monthly.results];
    const legacyFees = await d1.prepare(`SELECT month, instagram_toman AS instagramToman, google_ads_toman AS googleAdsToman
      FROM brand_monthly_channel_contractor_fees WHERE brand_id = ? AND month BETWEEN ? AND ?`).bind(brandId, monthFrom, monthTo).all<Record<string, unknown>>();
    legacyFees.results.forEach(row => {
      const month = String(row.month);
      if (!monthlyCosts.some(item => item.month === month && item.channelId === "instagram")) monthlyCosts.push({ month, channelId: "instagram", mediaToman: null, contractorToman: row.instagramToman == null ? null : Number(row.instagramToman) });
      if (!monthlyCosts.some(item => item.month === month && item.channelId === "google_ads")) monthlyCosts.push({ month, channelId: "google_ads", mediaToman: null, contractorToman: row.googleAdsToman == null ? null : Number(row.googleAdsToman) });
    });
    const smsPrices = await d1.prepare(`SELECT month, price_toman AS priceToman, updated_at AS updatedAt
      FROM brand_monthly_sms_prices WHERE brand_id = ? AND month BETWEEN ? AND ? ORDER BY month`).bind(brandId, monthFrom, monthTo).all<SmsUnitPrice>();
    return Response.json({ entries, monthlyCosts, smsPrices: smsPrices.results, channels: rules.channels.filter(channel => channel.enabled) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "دریافت بودجه‌های ذخیره‌شده امکان‌پذیر نیست." }, { status: 500 });
  }
}

/** Atomically stores all dynamic daily/monthly channel costs for one Persian month. */
export async function POST(request: Request) {
  try {
    const payload = await request.json() as { month?: unknown; entries?: unknown; monthlyCosts?: unknown; smsUnitPriceToman?: unknown };
    const month = typeof payload.month === "string" ? payload.month : "";
    if (!/^\d{4}\/\d{2}$/.test(month) || !Array.isArray(payload.entries) || payload.entries.length < 20 || payload.entries.length > 27 || !Array.isArray(payload.monthlyCosts)) return Response.json({ error: "اطلاعات ماه کامل یا معتبر نیست." }, { status: 400 });
    const d1 = await ensureScopedStorage();
    const brandId = await getRequestBrandId(request);
    const rules = await configuredRules(d1, brandId);
    const dailyIds = new Set(rules.channels.filter(channel => channel.enabled && channel.costMode === "daily_budget").map(channel => channel.id));
    const monthlyIds = new Set(rules.channels.filter(channel => channel.enabled && channel.costMode !== "none").map(channel => channel.id));
    const entries = payload.entries as BudgetEntry[];
    const dates = new Set<string>();
    for (const entry of entries) {
      if (!isPersianDate(entry.date) || !entry.date.startsWith(`${month}/`) || !isPersianDate(entry.weekStart) || typeof entry.weekday !== "string" || !entry.weekday.trim() || entry.weekday.trim() === "جمعه" || dates.has(entry.date) || !entry.amounts || typeof entry.amounts !== "object") return Response.json({ error: "یکی از مبالغ یا تاریخ‌ها معتبر نیست." }, { status: 400 });
      if (Object.entries(entry.amounts).some(([id, value]) => !dailyIds.has(id) || !validBudget(value))) return Response.json({ error: "بودجه روزانه یک کانال ناشناخته یا نامعتبر است." }, { status: 400 });
      dates.add(entry.date);
    }
    const monthlyCosts = payload.monthlyCosts as MonthlyChannelCost[];
    if (monthlyCosts.some(item => item.month !== month || !monthlyIds.has(item.channelId) || !validBudget(item.mediaToman) || !validBudget(item.contractorToman))) return Response.json({ error: "هزینه ماهانه یا دستمزد پیمانکار معتبر نیست." }, { status: 400 });
    const hasSmsPrice = Object.prototype.hasOwnProperty.call(payload, "smsUnitPriceToman");
    const smsUnitPriceToman = payload.smsUnitPriceToman;
    if (hasSmsPrice && smsUnitPriceToman !== null && (typeof smsUnitPriceToman !== "number" || !Number.isSafeInteger(smsUnitPriceToman) || smsUnitPriceToman <= 0)) {
      return Response.json({ error: "قیمت هر پیامک باید یک عدد صحیح و بیشتر از صفر باشد؛ خانهٔ خالی یعنی قیمت هنوز ثبت نشده است." }, { status: 400 });
    }
    const statements = [
      d1.prepare("DELETE FROM brand_channel_daily_costs WHERE brand_id = ? AND date BETWEEN ? AND ?").bind(brandId, `${month}/01`, `${month}/31`),
      d1.prepare("DELETE FROM brand_channel_monthly_costs WHERE brand_id = ? AND month = ?").bind(brandId, month),
      ...entries.map(entry => d1.prepare(`INSERT INTO brand_weekly_ad_budgets
        (brand_id,date,week_start,weekday,sms_toman,instagram_toman,updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(brand_id,date) DO UPDATE SET week_start=excluded.week_start,weekday=excluded.weekday,sms_toman=excluded.sms_toman,instagram_toman=excluded.instagram_toman,updated_at=CURRENT_TIMESTAMP`)
        .bind(brandId, entry.date, entry.weekStart, entry.weekday.trim(), entry.amounts.sms ?? null, entry.amounts.instagram ?? null)),
      ...entries.flatMap(entry => Object.entries(entry.amounts).filter(([id, value]) => dailyIds.has(id) && value !== null).map(([id, value]) => d1.prepare("INSERT INTO brand_channel_daily_costs (brand_id,date,channel_id,amount_toman) VALUES (?,?,?,?)").bind(brandId, entry.date, id, value))),
      ...monthlyCosts.filter(item => item.mediaToman !== null || item.contractorToman !== null).map(item => d1.prepare("INSERT INTO brand_channel_monthly_costs (brand_id,month,channel_id,media_toman,contractor_toman) VALUES (?,?,?,?,?)").bind(brandId, month, item.channelId, item.mediaToman, item.contractorToman)),
    ];
    if (hasSmsPrice) {
      statements.push(d1.prepare("DELETE FROM brand_monthly_sms_prices WHERE brand_id = ? AND month = ?").bind(brandId, month));
      if (typeof smsUnitPriceToman === "number") statements.push(d1.prepare("INSERT INTO brand_monthly_sms_prices (brand_id,month,price_toman,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(brandId, month, smsUnitPriceToman));
    }
    const instagram = monthlyCosts.find(item => item.channelId === "instagram");
    const googleAds = monthlyCosts.find(item => item.channelId === "google_ads");
    statements.push(d1.prepare(`INSERT INTO brand_monthly_channel_contractor_fees (brand_id,month,instagram_toman,google_ads_toman,updated_at)
      VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(brand_id,month) DO UPDATE SET instagram_toman=excluded.instagram_toman,google_ads_toman=excluded.google_ads_toman,updated_at=CURRENT_TIMESTAMP`)
      .bind(brandId, month, instagram?.contractorToman ?? null, googleAds?.contractorToman ?? null));
    await d1.batch(statements);
    return Response.json({ saved: true, savedCount: entries.length, channelCount: monthlyIds.size }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "ذخیرهٔ بودجه‌ها انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}
