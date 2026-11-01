import { env } from "cloudflare:workers";
import { DEFAULT_BRAND_ID, ensureBrandStorage, getBrand, getRequestBrandId, mapBrand, normalizeBrandId, normalizePublishedSheetUrl } from "./storage";
import { ensureScopedStorage } from "./scoped-storage";
import { normalizeAdsId } from "../../google-ads-setup";

type BrandDeleteRuntime = { BUCKET?: R2Bucket };

const BRAND_SELECT = `SELECT id, name, short_name AS shortName, logo_key AS logoKey, logo_path AS logoPath,
  sheet_csv_url AS sheetCsvUrl, sheet_index_url AS sheetIndexUrl, sheet_status AS sheetStatus,
  sheet_message AS sheetMessage,
  google_ads_customer_id AS googleAdsCustomerId, google_ads_login_customer_id AS googleAdsLoginCustomerId,
  google_ads_status AS googleAdsStatus, google_ads_message AS googleAdsMessage,
  config_status AS configStatus, is_default AS isDefault, updated_at AS updatedAt FROM dashboard_brands`;

/** Returns every saved brand plus the cookie-selected current brand. */
export async function GET(request: Request) {
  try {
    const d1 = await ensureBrandStorage();
    const result = await d1.prepare(`${BRAND_SELECT} ORDER BY is_default DESC, name`).all<Record<string, unknown>>();
    const activeBrand = await getBrand(getRequestBrandId(request));
    return Response.json({ brands: result.results.map(mapBrand), activeBrand }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "دریافت تنظیمات برندها انجام نشد." }, { status: 500 });
  }
}

/** Creates or updates one draft brand without activating an untested source. */
export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const shortName = typeof payload.shortName === "string" ? payload.shortName.trim() : "";
    if (name.length < 2 || name.length > 100 || shortName.length < 2 || shortName.length > 40) {
      return Response.json({ error: "نام کامل یا نام کوتاه برند معتبر نیست." }, { status: 400 });
    }
    const requestedId = typeof payload.id === "string" ? payload.id : "";
    const id = requestedId && /^[a-z][a-z0-9-]{2,40}$/.test(requestedId) ? requestedId : normalizeBrandId(String(payload.slug || name));
    const sheet = typeof payload.sheetUrl === "string" && payload.sheetUrl.trim() ? normalizePublishedSheetUrl(payload.sheetUrl) : { csvUrl: "", indexUrl: "" };
    const customerId = typeof payload.googleAdsCustomerId === "string" ? normalizeAdsId(payload.googleAdsCustomerId) : "";
    const loginCustomerId = typeof payload.googleAdsLoginCustomerId === "string" ? normalizeAdsId(payload.googleAdsLoginCustomerId) : "";
    if ((customerId && !/^\d{10}$/.test(customerId)) || (loginCustomerId && !/^\d{10}$/.test(loginCustomerId))) return Response.json({ error: "شناسه‌های Google Ads باید دقیقاً ۱۰ رقم باشند؛ MCC را در دسترسی مستقیم خالی بگذارید." }, { status: 400 });
    const d1 = await ensureBrandStorage();
    await d1.prepare(`INSERT INTO dashboard_brands
      (id, name, short_name, sheet_csv_url, sheet_index_url, sheet_status, sheet_message,
       google_ads_customer_id, google_ads_login_customer_id, google_ads_status,
       google_ads_message, config_status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'برای تأیید منبع، آزمایش Google Sheets را اجرا کنید.',
        ?, ?, 'pending', 'Service Account این دفتر هنوز تنظیم و آزمایش نشده است.', 'draft', CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, short_name = excluded.short_name,
        sheet_csv_url = excluded.sheet_csv_url, sheet_index_url = excluded.sheet_index_url,
        sheet_status = CASE
          WHEN dashboard_brands.sheet_csv_url != excluded.sheet_csv_url THEN 'pending'
          ELSE dashboard_brands.sheet_status END,
        sheet_message = CASE
          WHEN dashboard_brands.sheet_csv_url != excluded.sheet_csv_url THEN 'لینک تغییر کرده است؛ اتصال را دوباره آزمایش کنید.'
          ELSE dashboard_brands.sheet_message END,
        config_status = CASE
          WHEN dashboard_brands.sheet_csv_url != excluded.sheet_csv_url THEN 'draft'
          ELSE dashboard_brands.config_status END,
        google_ads_customer_id = excluded.google_ads_customer_id,
        google_ads_login_customer_id = excluded.google_ads_login_customer_id,
        updated_at = CURRENT_TIMESTAMP`)
      .bind(id, name, shortName, sheet.csvUrl, sheet.indexUrl, customerId, loginCustomerId).run();
    return Response.json({ saved: true, brand: await getBrand(id) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const message = code === "sheet_edit_url_not_published" ? "این لینک معمولیِ ویرایش Google Sheets است و برای داشبورد قابل خواندن نیست. راه‌حل: File ← Share ← Publish to web را بزنید، Entire document را انتخاب کنید و لینک منتشرشده را وارد کنید."
      : code === "sheet_must_be_published" ? "لینک قابل استفاده نیست. راه‌حل: لینک Publish to web را وارد کنید؛ لینک می‌تواند به ID منتشرشده ختم شود یا دارای /pubhtml و /pub باشد."
      : code === "sheet_url_invalid" ? "لینک Google Sheets معتبر نیست. راه‌حل: لینک کامل HTTPS از دامنه docs.google.com را بدون متن اضافه وارد کنید."
      : "ذخیره تنظیمات برند انجام نشد. راه‌حل: اتصال را بررسی و دوباره تلاش کنید؛ اطلاعات برند فعلی تغییر نکرده است.";
    return Response.json({ error: message }, { status: code.startsWith("sheet_") ? 400 : 500 });
  }
}

/** Activates a brand after its required Google Sheets source passes validation. */
export async function PATCH(request: Request) {
  try {
    const payload = await request.json() as { id?: unknown };
    const id = typeof payload.id === "string" ? payload.id : "";
    const d1 = await ensureBrandStorage();
    const brand = await getBrand(id);
    if (brand.id !== id) {
      return Response.json({ error: "برند مورد نظر پیدا نشد." }, { status: 404 });
    }
    await d1.prepare("UPDATE dashboard_brands SET config_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return Response.json({ activated: true, brand: await getBrand(id) });
  } catch {
    return Response.json({ error: "فعال‌سازی برند انجام نشد." }, { status: 500 });
  }
}

/** Permanently removes one non-default brand and every dashboard-owned record scoped to it. */
export async function DELETE(request: Request) {
  try {
    const payload = await request.json() as { id?: unknown; confirmation?: unknown };
    const id = typeof payload.id === "string" ? payload.id : "";
    const confirmation = typeof payload.confirmation === "string" ? payload.confirmation.trim() : "";
    if (!/^[a-z][a-z0-9-]{2,40}$/.test(id)) return Response.json({ error: "شناسه برند معتبر نیست." }, { status: 400 });
    const d1 = await ensureScopedStorage();
    const row = await d1.prepare("SELECT name, short_name AS shortName, logo_key AS logoKey, is_default AS isDefault FROM dashboard_brands WHERE id = ?")
      .bind(id).first<{ name: string; shortName: string; logoKey: string | null; isDefault: number }>();
    if (!row) return Response.json({ error: "این برند دیگر وجود ندارد." }, { status: 404 });
    if (row.isDefault === 1) return Response.json({ error: "برند پیش‌فرض قابل حذف نیست؛ ابتدا یک برند دیگر را به‌عنوان برند اصلی تعیین کنید." }, { status: 409 });
    if (confirmation !== row.name && confirmation !== row.shortName) {
      return Response.json({ error: `برای تأیید حذف، نام «${row.name}» را دقیق وارد کنید.` }, { status: 400 });
    }

    // Remove the uploaded logo first so deletion never leaves an orphaned dashboard asset.
    if (row.logoKey) {
      const bucket = (env as unknown as BrandDeleteRuntime).BUCKET;
      if (!bucket) return Response.json({ error: "ذخیره‌سازی لوگو در دسترس نیست؛ هیچ داده‌ای حذف نشد." }, { status: 503 });
      await bucket.delete(row.logoKey);
    }

    // Optional Google Ads cache tables are created before cleanup so a never-connected brand remains deletable.
    await d1.batch([
      d1.prepare("CREATE TABLE IF NOT EXISTS google_ads_report_cache (cache_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
      d1.prepare("CREATE TABLE IF NOT EXISTS google_ads_runtime_state (state_key TEXT PRIMARY KEY NOT NULL, state_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
      d1.prepare("CREATE TABLE IF NOT EXISTS search_console_report_cache (cache_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
      d1.prepare("CREATE TABLE IF NOT EXISTS telegram_bot_settings (id INTEGER PRIMARY KEY NOT NULL, bot_token_encrypted TEXT, chat_id TEXT, enabled INTEGER NOT NULL DEFAULT 0, activation_requested INTEGER NOT NULL DEFAULT 0, change_alerts_enabled INTEGER NOT NULL DEFAULT 1, health_updates_enabled INTEGER NOT NULL DEFAULT 1, interval_minutes INTEGER NOT NULL DEFAULT 10, end_of_day_enabled INTEGER NOT NULL DEFAULT 1, normal_report_time TEXT NOT NULL DEFAULT '18:30', thursday_report_time TEXT NOT NULL DEFAULT '14:40', iran_holiday_calendar TEXT NOT NULL DEFAULT 'fixed', suppress_empty_morning INTEGER NOT NULL DEFAULT 1, last_bot_username TEXT, last_checked_at TEXT, last_report_status TEXT NOT NULL DEFAULT 'never', last_report_at TEXT, last_report_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
      d1.prepare("CREATE TABLE IF NOT EXISTS brand_search_console_service_accounts (brand_id TEXT PRIMARY KEY NOT NULL, property_url TEXT NOT NULL, service_account_email TEXT NOT NULL, project_id TEXT, private_key_encrypted TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    ]);
    // D1 batch keeps all dashboard-owned structured data deletion together.
    await d1.batch([
      d1.prepare("DELETE FROM brand_weekly_ad_budgets WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_monthly_channel_contractor_fees WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_channel_daily_costs WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_channel_monthly_costs WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_monthly_sms_prices WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_monthly_currency_rates WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_monthly_expert_contracts WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_expert_contract_records WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM google_ads_report_cache WHERE cache_key LIKE ?").bind(`${id}:%`),
      d1.prepare("DELETE FROM google_ads_runtime_state WHERE state_key LIKE ?").bind(`${id}:%`),
      d1.prepare("DELETE FROM brand_google_ads_service_accounts WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM search_console_report_cache WHERE cache_key LIKE ?").bind(`${id}:%`),
      d1.prepare("DELETE FROM brand_search_console_service_accounts WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM sheet_csv_cache WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM sheet_month_registry_cache WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_system_events WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_dashboard_rule_versions WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM brand_dashboard_rules WHERE brand_id = ?").bind(id),
      d1.prepare("DELETE FROM dashboard_brands WHERE id = ? AND is_default = 0").bind(id),
    ]);
    const selectedBrandWasDeleted = getRequestBrandId(request) === id;
    return Response.json({ deleted: true }, {
      headers: {
        "cache-control": "no-store",
        ...(selectedBrandWasDeleted ? { "set-cookie": `dashboard_brand=${DEFAULT_BRAND_ID}; Path=/; Max-Age=31536000; SameSite=Lax; Secure` } : {}),
      },
    });
  } catch {
    return Response.json({ error: "حذف کامل برند انجام نشد؛ هیچ حذف دیگری را تکرار نکنید و دوباره تلاش کنید." }, { status: 500 });
  }
}
