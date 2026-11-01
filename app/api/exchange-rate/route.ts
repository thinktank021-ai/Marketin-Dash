import { getRequestBrandId } from "../brands/storage";
import { ensureScopedStorage } from "../brands/scoped-storage";

/** Ensures the monthly exchange-rate store exists before every read or write. */
async function ensureRateStorage() {
  return ensureScopedStorage();
}

/** Accepts only normalized Persian month keys in YYYY/MM format. */
function isPersianMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}\/\d{2}$/.test(value);
}

/** Returns one rate or all requested monthly rates without caching financial inputs. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const months = (params.get("months") || params.get("month") || "").split(",").filter(Boolean);
    if (!months.length || months.length > 24 || months.some(month => !isPersianMonth(month))) {
      return Response.json({ error: "ماه نرخ تبدیل معتبر نیست." }, { status: 400 });
    }
    const d1 = await ensureRateStorage();
    const brandId = await getRequestBrandId(request);
    const placeholders = months.map(() => "?").join(",");
    const result = await d1.prepare(`SELECT month, try_to_toman AS tryToToman, updated_at AS updatedAt
      FROM brand_monthly_currency_rates WHERE brand_id = ? AND month IN (${placeholders}) ORDER BY month`).bind(brandId, ...months).all();
    return Response.json({ rates: result.results }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "دریافت نرخ تبدیل انجام نشد." }, { status: 500 });
  }
}

/** Upserts one non-negative monthly rate; zero remains explicit and is never treated as missing. */
export async function POST(request: Request) {
  try {
    const payload = await request.json() as { month?: unknown; tryToToman?: unknown };
    if (!isPersianMonth(payload.month) || typeof payload.tryToToman !== "number"
      || !Number.isSafeInteger(payload.tryToToman) || payload.tryToToman < 0) {
      return Response.json({ error: "ماه یا نرخ تبدیل معتبر نیست." }, { status: 400 });
    }
    const d1 = await ensureRateStorage();
    const brandId = await getRequestBrandId(request);
    await d1.prepare(`INSERT INTO brand_monthly_currency_rates (brand_id, month, try_to_toman, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(brand_id, month) DO UPDATE SET try_to_toman = excluded.try_to_toman, updated_at = CURRENT_TIMESTAMP`)
      .bind(brandId, payload.month, payload.tryToToman).run();
    return Response.json({ saved: true });
  } catch {
    return Response.json({ error: "ذخیره نرخ تبدیل انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}
