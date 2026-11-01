import { getRequestBrandId } from "../brands/storage";
import { ensureScopedStorage } from "../brands/scoped-storage";

type ContractRecordInput = {
  month?: unknown;
  expert?: unknown;
  leadRef?: unknown;
  sheetRow?: unknown;
  firstContactDate?: unknown;
  sourceChannel?: unknown;
  rawSourceChannel?: unknown;
  route?: unknown;
};

/** Ensures both the durable detail table and its reporting index exist. */
async function ensureRecordStorage() {
  return ensureScopedStorage();
}

/** Accepts only normalized Persian month keys used throughout the dashboard. */
function isPersianMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}\/\d{2}$/.test(value);
}

/** Accepts only complete normalized Persian dates so a contract cannot lose its attribution day. */
function isPersianDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}\/\d{2}\/\d{2}$/.test(value);
}

/** Normalizes and bounds required text fields before they reach a prepared statement. */
function readText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxLength ? text : "";
}

/** Returns every detailed contract for one month in newest-first order. */
export async function GET(request: Request) {
  try {
    const month = new URL(request.url).searchParams.get("month");
    if (!isPersianMonth(month)) return Response.json({ error: "ماه انتخاب‌شده معتبر نیست." }, { status: 400 });
    const d1 = await ensureRecordStorage();
    const brandId = await getRequestBrandId(request);
    const result = await d1.prepare(`SELECT id, month, expert, lead_ref AS leadRef, sheet_row AS sheetRow,
      first_contact_date AS firstContactDate, source_channel AS sourceChannel,
      raw_source_channel AS rawSourceChannel, route, created_at AS createdAt
      FROM brand_expert_contract_records WHERE brand_id = ? AND month = ? ORDER BY first_contact_date DESC, id DESC`).bind(brandId, month).all();
    return Response.json({ records: result.results }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "دریافت قراردادهای ردیفی امکان‌پذیر نیست." }, { status: 500 });
  }
}

/** Creates exactly one contract for one Sheet lead; the unique lead reference prevents double counting. */
export async function POST(request: Request) {
  try {
    const payload = await request.json() as ContractRecordInput;
    const month = payload.month;
    const expert = readText(payload.expert, 120);
    const leadRef = readText(payload.leadRef, 180);
    const sheetRow = readText(payload.sheetRow, 80);
    const firstContactDate = payload.firstContactDate;
    const sourceChannel = readText(payload.sourceChannel, 120);
    const rawSourceChannel = readText(payload.rawSourceChannel, 160);
    const route = readText(payload.route, 160);
    if (!isPersianMonth(month) || !isPersianDate(firstContactDate) || !firstContactDate.startsWith(`${month}/`)
      || !expert || !leadRef || !sheetRow || !sourceChannel || !rawSourceChannel) {
      return Response.json({ error: "اطلاعات لید انتخاب‌شده کامل یا معتبر نیست." }, { status: 400 });
    }
    const d1 = await ensureRecordStorage();
    const brandId = await getRequestBrandId(request);
    const insertResult = await d1.prepare(`INSERT INTO brand_expert_contract_records
      (brand_id, month, expert, lead_ref, sheet_row, first_contact_date, source_channel, raw_source_channel, route)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(brandId, month, expert, leadRef, sheetRow, firstContactDate, sourceChannel, rawSourceChannel, route || null).run();
    const insertedId = Number(insertResult.meta?.last_row_id || 0);
    const record = insertedId > 0 ? await d1.prepare(`SELECT id, month, expert, lead_ref AS leadRef, sheet_row AS sheetRow,
      first_contact_date AS firstContactDate, source_channel AS sourceChannel,
      raw_source_channel AS rawSourceChannel, route, created_at AS createdAt
      FROM brand_expert_contract_records WHERE brand_id = ? AND id = ? LIMIT 1`).bind(brandId, insertedId).first() : null;
    if (!record) return Response.json({ error: "قرارداد ذخیره شد اما بازخوانی آن کامل نبود؛ فهرست را تازه‌سازی کنید." }, { status: 500 });
    return Response.json({ saved: true, record }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/UNIQUE|constraint/i.test(message)) {
      return Response.json({ error: "این لید قبلاً به‌عنوان قرارداد ثبت شده است." }, { status: 409 });
    }
    return Response.json({ error: "ثبت قرارداد انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}

/** Removes only a detailed record; legacy aggregate totals are intentionally unreachable here. */
export async function DELETE(request: Request) {
  try {
    const payload = await request.json() as { id?: unknown };
    if (!Number.isSafeInteger(payload.id) || Number(payload.id) <= 0) {
      return Response.json({ error: "شناسه قرارداد معتبر نیست." }, { status: 400 });
    }
    const d1 = await ensureRecordStorage();
    const brandId = await getRequestBrandId(request);
    const record = await d1.prepare(`SELECT id, month, expert, lead_ref AS leadRef, sheet_row AS sheetRow,
      first_contact_date AS firstContactDate, source_channel AS sourceChannel, route
      FROM brand_expert_contract_records WHERE brand_id = ? AND id = ? LIMIT 1`)
      .bind(brandId, payload.id).first();
    if (!record) {
      return Response.json({ error: "این قرارداد وجود ندارد یا قبلاً حذف شده است." }, { status: 404 });
    }
    const result = await d1.prepare("DELETE FROM brand_expert_contract_records WHERE brand_id = ? AND id = ?")
      .bind(brandId, payload.id).run();
    if (Number(result.meta?.changes || 0) !== 1) {
      return Response.json({ error: "قرارداد حذف نشد؛ فهرست را تازه‌سازی و دوباره تلاش کنید." }, { status: 409 });
    }
    return Response.json({ deleted: true, record }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "حذف قرارداد انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}
