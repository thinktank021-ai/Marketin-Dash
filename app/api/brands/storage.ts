import { getD1 } from "../../../db";
import { oncePerDatabase } from "./storage-initialization";
import { normalizeCoreDashboardRules } from "../../dashboard-rules";

// The original Donyagardi source remains the immutable migration fallback for the first brand.
export const DEFAULT_BRAND_ID = "donyagardi";
export const DEFAULT_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRduzbL7dxZ6Wauu8BGoEvq1wH75BV3Qv43Li9kttKrSkDO3yvSQPImduF2UKVwuy1NwzLv3nucNgQu/pub?output=csv";
export const DEFAULT_SHEET_INDEX_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRduzbL7dxZ6Wauu8BGoEvq1wH75BV3Qv43Li9kttKrSkDO3yvSQPImduF2UKVwuy1NwzLv3nucNgQu/pubhtml";

export type DashboardBrand = {
  id: string;
  name: string;
  shortName: string;
  logoUrl: string;
  sheetCsvUrl: string;
  sheetIndexUrl: string;
  sheetStatus: "pending" | "connected" | "warning" | "error";
  sheetMessage: string;
  googleAdsCustomerId: string;
  googleAdsLoginCustomerId: string;
  googleAdsStatus: "pending" | "connected" | "warning" | "error";
  googleAdsMessage: string;
  configStatus: "draft" | "active";
  isDefault: boolean;
  updatedAt: string;
};


/** Creates the brand registry and preserves the existing dashboard as the default active brand. */
async function initializeBrandStorage() {
  const d1 = getD1();
  // Tables and indexes are owned by the applied Drizzle migrations.
  await d1.prepare(`INSERT OR IGNORE INTO dashboard_brands
    (id, name, short_name, logo_path, sheet_csv_url, sheet_index_url, sheet_status, sheet_message,
     google_ads_status, google_ads_message, config_status, is_default)
    VALUES (?, 'دفتر دنیاگردی', 'دنیاگردی', '/assets/donyagardi-logo-transparent.png', ?, ?, 'connected',
      'منبع فعلی Google Sheets ثبت شده و فعال است.', 'pending',
      'Service Account این دفتر هنوز تنظیم و آزمایش نشده است.', 'active', 1)`)
    .bind(DEFAULT_BRAND_ID, DEFAULT_SHEET_CSV_URL, DEFAULT_SHEET_INDEX_URL).run();
  // Preserve the confirmed account identifier while replacing the legacy transport with Service Account.
  await d1.prepare("UPDATE dashboard_brands SET google_ads_customer_id = '6077217562' WHERE id = ? AND google_ads_customer_id = ''")
    .bind(DEFAULT_BRAND_ID).run();
  // One-time parity migration: repair invariant feature capabilities without
  // copying office-specific budgets, routes, credentials, or source settings.
  const storedRules = await d1.prepare("SELECT brand_id AS brandId, config_json AS configJson, version FROM brand_dashboard_rules").all<{ brandId: string; configJson: string; version: number }>();
  const repairs = storedRules.results.flatMap(row => {
    try {
      const normalized = normalizeCoreDashboardRules(JSON.parse(row.configJson));
      return normalized.changed
        ? [
          d1.prepare("UPDATE brand_dashboard_rules SET config_json = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE brand_id = ?").bind(JSON.stringify(normalized.rules), Number(row.version || 0) + 1, row.brandId),
          d1.prepare("INSERT INTO brand_dashboard_rule_versions (brand_id, version, config_json, action) VALUES (?, ?, ?, 'core_migration')").bind(row.brandId, Number(row.version || 0) + 1, JSON.stringify(normalized.rules)),
        ]
        : [];
    } catch {
      return [];
    }
  });
  if (repairs.length) await d1.batch(repairs);
  return d1;
}

/** Reads the selected brand from a same-origin cookie without trusting arbitrary identifiers. */
export function getRequestBrandId(request: Request) {
  // An explicit same-origin request context wins over cookies so duplicate or delayed cookies can never mix brands.
  const requestedBrand = request.headers.get("x-dashboard-brand") || "";
  if (/^[a-z][a-z0-9-]{2,40}$/.test(requestedBrand)) return requestedBrand;
  const cookie = request.headers.get("cookie") || "";
  const encoded = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("dashboard_brand="))?.slice("dashboard_brand=".length) || "";
  const value = decodeURIComponent(encoded);
  return /^[a-z][a-z0-9-]{2,40}$/.test(value) ? value : DEFAULT_BRAND_ID;
}

/** Converts one database row to the public, credential-free settings model. */
export function mapBrand(row: Record<string, unknown>): DashboardBrand {
  const id = String(row.id || DEFAULT_BRAND_ID);
  const logoKey = String(row.logoKey || "");
  return {
    id,
    name: String(row.name || ""),
    shortName: String(row.shortName || ""),
    logoUrl: logoKey ? `/api/brands/logo?id=${encodeURIComponent(id)}` : String(row.logoPath || "/assets/donyagardi-logo-transparent.png"),
    sheetCsvUrl: String(row.sheetCsvUrl || ""),
    sheetIndexUrl: String(row.sheetIndexUrl || ""),
    sheetStatus: String(row.sheetStatus || "pending") as DashboardBrand["sheetStatus"],
    sheetMessage: String(row.sheetMessage || ""),
    googleAdsCustomerId: String(row.googleAdsCustomerId || ""),
    googleAdsLoginCustomerId: String(row.googleAdsLoginCustomerId || ""),
    googleAdsStatus: String(row.googleAdsStatus || "pending") as DashboardBrand["googleAdsStatus"],
    googleAdsMessage: String(row.googleAdsMessage || ""),
    configStatus: String(row.configStatus || "draft") as DashboardBrand["configStatus"],
    isDefault: Number(row.isDefault || 0) === 1,
    updatedAt: String(row.updatedAt || ""),
  };
}

/** Returns a single brand or falls back to Donyagardi when an invalid cookie is supplied. */
export async function getBrand(brandId: string) {
  const d1 = await ensureBrandStorage();
  const select = `SELECT id, name, short_name AS shortName, logo_key AS logoKey, logo_path AS logoPath,
    sheet_csv_url AS sheetCsvUrl, sheet_index_url AS sheetIndexUrl, sheet_status AS sheetStatus,
    sheet_message AS sheetMessage,
    google_ads_customer_id AS googleAdsCustomerId, google_ads_login_customer_id AS googleAdsLoginCustomerId,
    google_ads_status AS googleAdsStatus, google_ads_message AS googleAdsMessage,
    config_status AS configStatus, is_default AS isDefault, updated_at AS updatedAt
    FROM dashboard_brands WHERE id = ?`;
  const row = await d1.prepare(select).bind(brandId).first<Record<string, unknown>>()
    || await d1.prepare(select).bind(DEFAULT_BRAND_ID).first<Record<string, unknown>>();
  if (!row) throw new Error("default_brand_missing");
  return mapBrand(row);
}

/** Generates a stable ASCII identifier while preventing accidental cross-brand key collisions. */
export function normalizeBrandId(value: string) {
  const base = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(base) ? base.slice(0, 40) : `brand-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Accepts every common "Publish to web" workbook URL shape and derives stable
 * index/CSV endpoints. Query strings, fragments, trailing slashes, copied HTML
 * entities, surrounding quotes, and the bare published ID URL are harmless.
 */
export function normalizePublishedSheetUrl(value: string) {
  const cleaned = value.trim()
    .replace(/^['"“”]+|['"“”]+$/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  let url: URL;
  try { url = new URL(cleaned); } catch { throw new Error("sheet_url_invalid"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "docs.google.com") throw new Error("sheet_url_invalid");
  if (/^\/spreadsheets\/d\/[^/]+\/(?:edit|view)(?:\/|$)/.test(url.pathname)) throw new Error("sheet_edit_url_not_published");
  const match = url.pathname.match(/^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)(?:\/(?:pubhtml|pub))?\/?$/);
  if (!match) throw new Error("sheet_must_be_published");
  const root = `https://docs.google.com/spreadsheets/d/e/${match[1]}`;
  return { csvUrl: `${root}/pub?output=csv`, indexUrl: `${root}/pubhtml` };
}
export function ensureBrandStorage() { return oncePerDatabase(getD1(), "brands", initializeBrandStorage); }
