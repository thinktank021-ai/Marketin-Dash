import { getRequestBrandId } from "../brands/storage";
import { ensureScopedStorage } from "../brands/scoped-storage";

// A missing database row is different from an explicitly stored zero contract count.
type ContractValue = number | null;
type ContractEntry = { expert: string; contractCount: ContractValue };

/** Ensures the durable monthly override store exists before every read or write. */
async function ensureContractStorage() {
  return ensureScopedStorage();
}

/** Accepts only normalized Persian month keys in YYYY/MM format. */
function isPersianMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}\/\d{2}$/.test(value);
}

/** Distinguishes a deliberate zero from a null value that removes the manual override. */
function isContractValue(value: unknown): value is ContractValue {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/** Returns every explicit manual contract override saved for one Persian month. */
export async function GET(request: Request) {
  try {
    const month = new URL(request.url).searchParams.get("month");
    if (!isPersianMonth(month)) return Response.json({ error: "ماه انتخاب‌شده معتبر نیست." }, { status: 400 });
    const d1 = await ensureContractStorage();
    const brandId = await getRequestBrandId(request);
    const [legacyResult, detailedResult] = await Promise.all([
      d1.prepare(`SELECT expert, contract_count AS legacyContractCount, updated_at AS updatedAt
        FROM brand_monthly_expert_contracts WHERE brand_id = ? AND month = ? ORDER BY expert`).bind(brandId, month).all(),
      d1.prepare(`SELECT expert, COUNT(*) AS detailedContractCount
        FROM brand_expert_contract_records WHERE brand_id = ? AND month = ? GROUP BY expert ORDER BY expert`).bind(brandId, month).all(),
    ]);
    const byExpert = new Map<string, { expert: string; hasLegacyAggregate: boolean; legacyContractCount: number; detailedContractCount: number; updatedAt?: string }>();
    legacyResult.results.forEach(row => {
      const value = row as { expert: string; legacyContractCount: number; updatedAt?: string };
      byExpert.set(value.expert, { ...value, hasLegacyAggregate: true, detailedContractCount: 0 });
    });
    detailedResult.results.forEach(row => {
      const value = row as { expert: string; detailedContractCount: number };
      const current = byExpert.get(value.expert) || { expert: value.expert, hasLegacyAggregate: false, legacyContractCount: 0, detailedContractCount: 0 };
      current.detailedContractCount = Number(value.detailedContractCount || 0);
      byExpert.set(value.expert, current);
    });
    const entries = [...byExpert.values()].map(entry => ({
      ...entry,
      contractCount: entry.legacyContractCount + entry.detailedContractCount,
    }));
    return Response.json({ entries }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "دریافت قراردادهای کارشناسان امکان‌پذیر نیست." }, { status: 500 });
  }
}

/** Atomically upserts numeric entries and deletes null entries so Sheet fallback remains explicit. */
export async function POST(request: Request) {
  try {
    const payload = await request.json() as { month?: unknown; entries?: unknown };
    if (!isPersianMonth(payload.month) || !Array.isArray(payload.entries) || payload.entries.length > 200) {
      return Response.json({ error: "اطلاعات ماه یا کارشناسان معتبر نیست." }, { status: 400 });
    }

    const entries = payload.entries as ContractEntry[];
    const seenExperts = new Set<string>();
    for (const entry of entries) {
      const expert = typeof entry.expert === "string" ? entry.expert.trim() : "";
      if (!expert || expert.length > 120 || !isContractValue(entry.contractCount) || seenExperts.has(expert)) {
        return Response.json({ error: "یکی از نام‌ها یا تعداد قراردادها معتبر نیست." }, { status: 400 });
      }
      entry.expert = expert;
      seenExperts.add(expert);
    }

    const d1 = await ensureContractStorage();
    const brandId = await getRequestBrandId(request);
    if (entries.length) {
      await d1.batch(entries.map(entry => entry.contractCount === null
        ? d1.prepare("DELETE FROM brand_monthly_expert_contracts WHERE brand_id = ? AND month = ? AND expert = ?").bind(brandId, payload.month, entry.expert)
        : d1.prepare(`INSERT INTO brand_monthly_expert_contracts (brand_id, month, expert, contract_count, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(brand_id, month, expert) DO UPDATE SET contract_count = excluded.contract_count, updated_at = CURRENT_TIMESTAMP`)
          .bind(brandId, payload.month, entry.expert, entry.contractCount)));
    }
    return Response.json({ saved: true, savedCount: entries.length });
  } catch {
    return Response.json({ error: "ذخیرهٔ قراردادهای کارشناسان انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}
