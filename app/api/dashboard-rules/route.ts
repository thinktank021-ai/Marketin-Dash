import { getD1 } from "../../../db";
import { DEFAULT_DASHBOARD_RULES, normalizeCoreDashboardRules } from "../../dashboard-rules";
import { getBrand, getRequestBrandId } from "../brands/storage";
import { diagnosticSafe, validateBackupPayload } from "../../support-tools";

const JSON_HEADERS = { "cache-control": "no-store" };
const safeJson = (value: unknown) => JSON.stringify(value).slice(0, 20000);
type DashboardD1 = ReturnType<typeof getD1>;
type EventRow = { id: number; severity: string; component: string; eventCode: string; message: string; safeContext: string; createdAt: string };

async function context(request: Request) {
  const brandId = getRequestBrandId(request);
  const brand = await getBrand(brandId);
  if (brand.id !== brandId) throw new Error("brand_not_found");
  return { brandId, brand, d1: getD1() };
}

async function event(d1: DashboardD1, brandId: string, severity: string, component: string, eventCode: string, message: string, safeContext: unknown = {}) {
  await d1.prepare(`INSERT INTO brand_system_events (brand_id, severity, component, event_code, message, safe_context)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(brandId, severity, component, eventCode, message, safeJson(safeContext)).run();
}

async function currentRules(d1: DashboardD1, brandId: string) {
  const row = await d1.prepare("SELECT config_json AS configJson, version, updated_at AS updatedAt FROM brand_dashboard_rules WHERE brand_id = ?")
    .bind(brandId).first<{ configJson: string; version: number; updatedAt: string }>();
  return row ? { rules: normalizeCoreDashboardRules(JSON.parse(row.configJson)).rules, version: Number(row.version), updatedAt: row.updatedAt } : { rules: normalizeCoreDashboardRules(DEFAULT_DASHBOARD_RULES).rules, version: 0, updatedAt: null };
}

export async function GET(request: Request) {
  try {
    const { brandId, brand, d1 } = await context(request);
    const action = new URL(request.url).searchParams.get("action") || "read";
    const current = await currentRules(d1, brandId);
    const versions = await d1.prepare(`SELECT version, action, created_at AS createdAt FROM brand_dashboard_rule_versions
      WHERE brand_id = ? ORDER BY version DESC LIMIT 20`).bind(brandId).all();
    if (action === "backup") {
      const [budgets, fees, channelDailyCosts, channelMonthlyCosts, smsPrices, rates, contracts, records] = await Promise.all([
        d1.prepare("SELECT date, week_start AS weekStart, weekday, sms_toman AS smsToman, instagram_toman AS instagramToman FROM brand_weekly_ad_budgets WHERE brand_id = ? ORDER BY date").bind(brandId).all(),
        d1.prepare("SELECT month, instagram_toman AS instagramToman, google_ads_toman AS googleAdsToman FROM brand_monthly_channel_contractor_fees WHERE brand_id = ? ORDER BY month").bind(brandId).all(),
        d1.prepare("SELECT date, channel_id AS channelId, amount_toman AS amountToman FROM brand_channel_daily_costs WHERE brand_id = ? ORDER BY date, channel_id").bind(brandId).all(),
        d1.prepare("SELECT month, channel_id AS channelId, media_toman AS mediaToman, contractor_toman AS contractorToman FROM brand_channel_monthly_costs WHERE brand_id = ? ORDER BY month, channel_id").bind(brandId).all(),
        d1.prepare("SELECT month, price_toman AS priceToman FROM brand_monthly_sms_prices WHERE brand_id = ? ORDER BY month").bind(brandId).all(),
        d1.prepare("SELECT month, try_to_toman AS tryToToman FROM brand_monthly_currency_rates WHERE brand_id = ? ORDER BY month").bind(brandId).all(),
        d1.prepare("SELECT month, expert, contract_count AS contractCount FROM brand_monthly_expert_contracts WHERE brand_id = ? ORDER BY month, expert").bind(brandId).all(),
        d1.prepare("SELECT month, expert, lead_ref AS leadRef, sheet_row AS sheetRow, first_contact_date AS firstContactDate, source_channel AS sourceChannel, raw_source_channel AS rawSourceChannel, route FROM brand_expert_contract_records WHERE brand_id = ? ORDER BY id").bind(brandId).all(),
      ]);
      await event(d1, brandId, "info", "backup", "BACKUP_EXPORTED", "نسخه پشتیبان امن تهیه شد.");
      const summary = { budgets: budgets.results.length + channelDailyCosts.results.length, contractorFees: fees.results.length + channelMonthlyCosts.results.length, smsPrices: smsPrices.results.length, rates: rates.results.length, contracts: contracts.results.length, contractRecords: records.results.length };
      return Response.json({ format: "marketing-dashboard-backup", schemaVersion: 3, exportedAt: new Date().toISOString(), brand: { id: brand.id, name: brand.name, shortName: brand.shortName }, rules: current, summary, data: { budgets: budgets.results, contractorFees: fees.results, channelDailyCosts: channelDailyCosts.results, channelMonthlyCosts: channelMonthlyCosts.results, smsPrices: smsPrices.results, rates: rates.results, contracts: contracts.results, contractRecords: records.results } }, { headers: { ...JSON_HEADERS, "content-disposition": `attachment; filename="dashboard-backup-${brandId}.json"` } });
    }
    const recentEvents = await d1.prepare(`SELECT id, severity, component, event_code AS eventCode, message, safe_context AS safeContext, created_at AS createdAt
      FROM brand_system_events WHERE brand_id = ? ORDER BY id DESC LIMIT 50`).bind(brandId).all<EventRow>();
    const health = {
      sheet: brand.sheetStatus, googleAds: brand.googleAdsStatus, brand: brand.configStatus,
      rulesValid: true, rulesVersion: current.version, recentErrorCount: recentEvents.results.filter((row: EventRow) => row.severity === "error").length,
    };
    const publicEvents = recentEvents.results.map((row: EventRow) => {
      let safeContext: Record<string, unknown> = {};
      try { safeContext = JSON.parse(String(row.safeContext || "{}")) as Record<string, unknown>; } catch { /* Ignore malformed historical context. */ }
      return { ...row, safeContext, solution: typeof safeContext.solution === "string" ? safeContext.solution : undefined };
    });
    if (action === "diagnostics") {
      await event(d1, brandId, "info", "diagnostics", "DIAGNOSTICS_EXPORTED", "بسته عیب‌یابی امن تهیه شد.");
      return Response.json(diagnosticSafe({ format: "marketing-dashboard-diagnostics", schemaVersion: 1, generatedAt: new Date().toISOString(), brand: { id: brand.id, name: brand.name, sheetStatus: brand.sheetStatus, googleAdsStatus: brand.googleAdsStatus, configStatus: brand.configStatus }, health, rules: { version: current.version, rulesVersion: current.rules.rulesVersion }, events: publicEvents }), { headers: { ...JSON_HEADERS, "content-disposition": `attachment; filename="dashboard-diagnostics-${brandId}.json"` } });
    }
    return Response.json({ ...current, versions: versions.results, events: publicEvents, health }, { headers: JSON_HEADERS });
  } catch (error) {
    return Response.json({ error: error instanceof Error && error.message === "brand_not_found" ? "برند معتبر نیست." : "تنظیمات قابل دریافت نیست." }, { status: 500, headers: JSON_HEADERS });
  }
}

export async function PUT(request: Request) {
  try {
    const { brandId, d1 } = await context(request);
    const body = await request.json() as { rules?: unknown };
    const rules = normalizeCoreDashboardRules(body.rules).rules;
    const current = await currentRules(d1, brandId);
    const version = current.version + 1;
    const configJson = JSON.stringify(rules);
    await d1.batch([
      d1.prepare(`INSERT INTO brand_dashboard_rules (brand_id, config_json, version, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(brand_id) DO UPDATE SET config_json = excluded.config_json, version = excluded.version, updated_at = CURRENT_TIMESTAMP`).bind(brandId, configJson, version),
      d1.prepare("INSERT INTO brand_dashboard_rule_versions (brand_id, version, config_json, action) VALUES (?, ?, ?, 'publish')").bind(brandId, version, configJson),
      d1.prepare("INSERT INTO brand_system_events (brand_id, severity, component, event_code, message, safe_context) VALUES (?, 'info', 'rules', 'RULES_PUBLISHED', ?, ?)").bind(brandId, `نسخه ${version} قواعد منتشر شد.`, safeJson({ rulesVersion: rules.rulesVersion })),
    ]);
    return Response.json({ saved: true, version, rules }, { headers: JSON_HEADERS });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "ذخیره قواعد انجام نشد." }, { status: 400, headers: JSON_HEADERS });
  }
}

export async function POST(request: Request) {
  try {
    const { brandId, d1 } = await context(request);
    const body = await request.json() as { action?: string; version?: number; backup?: Record<string, unknown> };
    if (body.action === "rollback") {
      const source = await d1.prepare("SELECT config_json AS configJson FROM brand_dashboard_rule_versions WHERE brand_id = ? AND version = ?").bind(brandId, Number(body.version)).first<{ configJson: string }>();
      if (!source) return Response.json({ error: "نسخه انتخاب‌شده پیدا نشد." }, { status: 404, headers: JSON_HEADERS });
      const rules = normalizeCoreDashboardRules(JSON.parse(source.configJson)).rules;
      const current = await currentRules(d1, brandId); const version = current.version + 1; const configJson = JSON.stringify(rules);
      await d1.batch([
        d1.prepare("UPDATE brand_dashboard_rules SET config_json = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE brand_id = ?").bind(configJson, version, brandId),
        d1.prepare("INSERT INTO brand_dashboard_rule_versions (brand_id, version, config_json, action) VALUES (?, ?, ?, 'rollback')").bind(brandId, version, configJson),
        d1.prepare("INSERT INTO brand_system_events (brand_id, severity, component, event_code, message, safe_context) VALUES (?, 'warning', 'rules', 'RULES_ROLLED_BACK', ?, ?)").bind(brandId, `قواعد به محتوای نسخه ${body.version} بازگردانده شد.`, safeJson({ sourceVersion: body.version, newVersion: version })),
      ]);
      return Response.json({ restored: true, version, rules }, { headers: JSON_HEADERS });
    }
    if (body.action === "restore") {
      const validated = validateBackupPayload(body.backup, brandId);
      const rules = normalizeCoreDashboardRules(validated.rulesInput).rules; const current = await currentRules(d1, brandId); const version = current.version + 1; const configJson = JSON.stringify(rules);
      const { budgets, contractorFees, channelDailyCosts, channelMonthlyCosts, smsPrices, rates, contracts, contractRecords, rowCount } = validated.data;
      const deleteStatements = [
        d1.prepare("DELETE FROM brand_weekly_ad_budgets WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_monthly_channel_contractor_fees WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_channel_daily_costs WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_channel_monthly_costs WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_monthly_sms_prices WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_monthly_currency_rates WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_monthly_expert_contracts WHERE brand_id = ?").bind(brandId),
        d1.prepare("DELETE FROM brand_expert_contract_records WHERE brand_id = ?").bind(brandId),
      ];
      const insertStatements = [
        ...budgets.map(row => d1.prepare("INSERT INTO brand_weekly_ad_budgets (brand_id,date,week_start,weekday,sms_toman,instagram_toman) VALUES (?,?,?,?,?,?)").bind(brandId,row.date,row.weekStart,row.weekday,row.smsToman ?? null,row.instagramToman ?? null)),
        ...contractorFees.map(row => d1.prepare("INSERT INTO brand_monthly_channel_contractor_fees (brand_id,month,instagram_toman,google_ads_toman) VALUES (?,?,?,?)").bind(brandId,row.month,row.instagramToman ?? null,row.googleAdsToman ?? null)),
        ...channelDailyCosts.map(row => d1.prepare("INSERT INTO brand_channel_daily_costs (brand_id,date,channel_id,amount_toman) VALUES (?,?,?,?)").bind(brandId,row.date,row.channelId,row.amountToman)),
        ...channelMonthlyCosts.map(row => d1.prepare("INSERT INTO brand_channel_monthly_costs (brand_id,month,channel_id,media_toman,contractor_toman) VALUES (?,?,?,?,?)").bind(brandId,row.month,row.channelId,row.mediaToman ?? null,row.contractorToman ?? null)),
        ...smsPrices.map(row => d1.prepare("INSERT INTO brand_monthly_sms_prices (brand_id,month,price_toman) VALUES (?,?,?)").bind(brandId,row.month,row.priceToman)),
        ...rates.map(row => d1.prepare("INSERT INTO brand_monthly_currency_rates (brand_id,month,try_to_toman) VALUES (?,?,?)").bind(brandId,row.month,row.tryToToman)),
        ...contracts.map(row => d1.prepare("INSERT INTO brand_monthly_expert_contracts (brand_id,month,expert,contract_count) VALUES (?,?,?,?)").bind(brandId,row.month,row.expert,row.contractCount)),
        ...contractRecords.map(row => d1.prepare("INSERT INTO brand_expert_contract_records (brand_id,month,expert,lead_ref,sheet_row,first_contact_date,source_channel,raw_source_channel,route) VALUES (?,?,?,?,?,?,?,?,?)").bind(brandId,row.month,row.expert,row.leadRef,row.sheetRow,row.firstContactDate,row.sourceChannel,row.rawSourceChannel,row.route ?? null)),
      ];
      // D1 batch is transactional: validation finishes first, then delete, insert, rules and audit event either all commit or all roll back.
      await d1.batch([
        ...deleteStatements,
        ...insertStatements,
        d1.prepare("UPDATE dashboard_brands SET config_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(brandId),
        d1.prepare(`INSERT INTO brand_dashboard_rules (brand_id,config_json,version,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(brand_id) DO UPDATE SET config_json=excluded.config_json,version=excluded.version,updated_at=CURRENT_TIMESTAMP`).bind(brandId,configJson,version),
        d1.prepare("INSERT INTO brand_dashboard_rule_versions (brand_id,version,config_json,action) VALUES (?,?,?,'restore')").bind(brandId,version,configJson),
        d1.prepare("INSERT INTO brand_system_events (brand_id,severity,component,event_code,message,safe_context) VALUES (?,'warning','backup','BACKUP_RESTORED','نسخه پشتیبان با موفقیت و به‌صورت کامل بازیابی شد.',?)").bind(brandId, safeJson({ version, rowCount })),
      ]);
      return Response.json({ restored: true, version }, { headers: JSON_HEADERS });
    }
    return Response.json({ error: "عملیات پشتیبانی نمی‌شود." }, { status: 400, headers: JSON_HEADERS });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "عملیات انجام نشد." }, { status: 400, headers: JSON_HEADERS });
  }
}
