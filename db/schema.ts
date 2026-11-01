import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Temporary app-login sessions are revocable, hashed, and independent of office data.
export const dashboardLoginSessions = sqliteTable("dashboard_login_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  credentialVersion: text("credential_version").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [index("dashboard_login_sessions_expiry_idx").on(table.expiresAt)]);
export const dashboardLoginAttempts = sqliteTable("dashboard_login_attempts", {
  bucket: text("bucket").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

// Stores one durable advertising-budget record per Persian calendar date.
// Channel amounts are nullable so an unfinished operator entry is never misreported as zero.
export const weeklyAdBudgets = sqliteTable("weekly_ad_budgets", {
  date: text("date").primaryKey(),
  weekStart: text("week_start").notNull(),
  weekday: text("weekday").notNull(),
  smsToman: integer("sms_toman"),
  instagramToman: integer("instagram_toman"),
  googleAdsToman: integer("google_ads_toman"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Stores monthly contractor fees only for channels that can have an external contractor.
// Nullable values mean "not entered" while an explicit zero confirms that no contractor exists.
export const monthlyChannelContractorFees = sqliteTable("monthly_channel_contractor_fees", {
  month: text("month").primaryKey(),
  instagramToman: integer("instagram_toman"),
  googleAdsToman: integer("google_ads_toman"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Stores one manager-approved TRY-to-toman conversion rate for each Persian month.
// Monthly rates make historical CPL and CAC reproducible instead of changing with today's market rate.
export const monthlyCurrencyRates = sqliteTable("monthly_currency_rates", {
  month: text("month").primaryKey(),
  tryToToman: integer("try_to_toman").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Stores the last successful Google Ads payload for each requested reporting range.
export const googleAdsReportCache = sqliteTable("google_ads_report_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payload: text("payload").notNull(),
  savedAt: text("saved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Every office owns one isolated Service Account; both private key and Developer Token stay encrypted.
export const brandGoogleAdsServiceAccounts = sqliteTable("brand_google_ads_service_accounts", {
  brandId: text("brand_id").primaryKey(),
  serviceAccountEmail: text("service_account_email").notNull(),
  projectId: text("project_id"),
  privateKeyEncrypted: text("private_key_encrypted").notNull(),
  developerTokenEncrypted: text("developer_token_encrypted"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Search Console access is optional and fully isolated per office.
export const brandSearchConsoleServiceAccounts = sqliteTable("brand_search_console_service_accounts", {
  brandId: text("brand_id").primaryKey(),
  propertyUrl: text("property_url").notNull(),
  serviceAccountEmail: text("service_account_email").notNull(),
  projectId: text("project_id"),
  privateKeyEncrypted: text("private_key_encrypted").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const searchConsoleReportCache = sqliteTable("search_console_report_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payload: text("payload").notNull(),
  savedAt: text("saved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// One dashboard-level Telegram destination receives a combined report for every active office.
// The bot token is encrypted; only safe connection metadata is returned to the UI.
export const telegramBotSettings = sqliteTable("telegram_bot_settings", {
  id: integer("id").primaryKey(),
  botTokenEncrypted: text("bot_token_encrypted"),
  chatId: text("chat_id"),
  enabled: integer("enabled").notNull().default(0),
  activationRequested: integer("activation_requested").notNull().default(0),
  changeAlertsEnabled: integer("change_alerts_enabled").notNull().default(1),
  healthUpdatesEnabled: integer("health_updates_enabled").notNull().default(1),
  intervalMinutes: integer("interval_minutes").notNull().default(10),
  endOfDayEnabled: integer("end_of_day_enabled").notNull().default(1),
  normalReportTime: text("normal_report_time").notNull().default("18:30"),
  thursdayReportTime: text("thursday_report_time").notNull().default("14:40"),
  iranHolidayCalendar: text("iran_holiday_calendar").notNull().default("fixed"),
  suppressEmptyMorning: integer("suppress_empty_morning").notNull().default(1),
  lastBotUsername: text("last_bot_username"),
  lastCheckedAt: text("last_checked_at"),
  lastReportStatus: text("last_report_status").notNull().default("never"),
  lastReportAt: text("last_report_at"),
  lastReportError: text("last_report_error"),
  automaticSuppressedDay: text("automatic_suppressed_day"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// A short-lived lease prevents overlapping cron invocations from duplicating a Telegram report.
export const telegramReportDispatchLock = sqliteTable("telegram_report_dispatch_lock", {
  id: integer("id").primaryKey(),
  lockedUntil: integer("locked_until").notNull(),
});

// Each office must explicitly opt in before its data can enter any Telegram report.
export const telegramBrandSettings = sqliteTable("telegram_brand_settings", {
  brandId: text("brand_id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Keeps the last sent lead total per office so each report can show a reliable delta.
export const telegramReportBrandState = sqliteTable("telegram_report_brand_state", {
  brandId: text("brand_id").primaryKey(),
  lastTotalToday: integer("last_total_today").notNull().default(0),
  lastReportDay: text("last_report_day"),
  lastReportAt: text("last_report_at"),
  lastSheetAt: text("last_sheet_at"),
});

// Official Iranian public holidays are cached by Persian date for deterministic scheduling.
export const telegramOfficialHolidays = sqliteTable("telegram_official_holidays", {
  date: text("date").primaryKey(),
  title: text("title").notNull().default(""),
  source: text("source").notNull().default("official_iran_calendar"),
});

// Same-source Sheet caches make historical months fast while preventing cross-brand or changed-link fallback.
export const sheetMonthRegistryCache = sqliteTable("sheet_month_registry_cache", {
  brandId: text("brand_id").primaryKey(), sourceUrl: text("source_url").notNull(), payload: text("payload").notNull(),
  fetchedAt: text("fetched_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sheetCsvCache = sqliteTable("sheet_csv_cache", {
  cacheKey: text("cache_key").primaryKey(), brandId: text("brand_id").notNull(), sourceUrl: text("source_url").notNull(),
  selector: text("selector").notNull(), payload: text("payload").notNull(), fetchedAt: text("fetched_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("sheet_csv_cache_brand_idx").on(table.brandId, table.fetchedAt)]);

// Stores an optional explicit monthly contract override for each Sheet expert.
// A stored zero is meaningful; the absence of a row means the UI must fall back to Google Sheets.
export const monthlyExpertContracts = sqliteTable("monthly_expert_contracts", {
  month: text("month").notNull(),
  expert: text("expert").notNull(),
  contractCount: integer("contract_count").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  // The month/expert pair is the durable identity of one manual override.
  primaryKey({ columns: [table.month, table.expert] }),
]);

// Stores each newly confirmed contract as one immutable lead-linked record.
// The legacy aggregate table stays intact so previously entered monthly totals are never lost.
export const expertContractRecords = sqliteTable("expert_contract_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  month: text("month").notNull(),
  expert: text("expert").notNull(),
  leadRef: text("lead_ref").notNull().unique(),
  sheetRow: text("sheet_row").notNull(),
  firstContactDate: text("first_contact_date").notNull(),
  sourceChannel: text("source_channel").notNull(),
  rawSourceChannel: text("raw_source_channel").notNull(),
  route: text("route"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  // Month/expert lookups power both the contract tab and selected-range rankings.
  index("expert_contract_records_month_idx").on(table.month, table.expert),
]);

// Stores every configurable dashboard brand and its independently tested data sources.
export const dashboardBrands = sqliteTable("dashboard_brands", {
  id: text("id").primaryKey(), name: text("name").notNull(), shortName: text("short_name").notNull(),
  logoKey: text("logo_key"), logoPath: text("logo_path"), sheetCsvUrl: text("sheet_csv_url").notNull().default(""), sheetIndexUrl: text("sheet_index_url").notNull().default(""),
  sheetStatus: text("sheet_status").notNull().default("pending"), sheetMessage: text("sheet_message").notNull().default("آزمایش نشده"),
  googleAdsCustomerId: text("google_ads_customer_id").notNull().default(""),
  googleAdsLoginCustomerId: text("google_ads_login_customer_id").notNull().default(""), googleAdsStatus: text("google_ads_status").notNull().default("pending"),
  googleAdsMessage: text("google_ads_message").notNull().default("اتصال انجام نشده"), configStatus: text("config_status").notNull().default("draft"),
  isDefault: integer("is_default").notNull().default(0), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Brand-scoped versions prevent budgets and contracts from leaking between offices.
export const brandWeeklyAdBudgets = sqliteTable("brand_weekly_ad_budgets", {
  brandId: text("brand_id").notNull(), date: text("date").notNull(), weekStart: text("week_start").notNull(), weekday: text("weekday").notNull(),
  smsToman: integer("sms_toman"), instagramToman: integer("instagram_toman"), googleAdsToman: integer("google_ads_toman"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [primaryKey({ columns: [table.brandId, table.date] }), index("brand_budgets_lookup_idx").on(table.brandId, table.weekStart, table.date)]);

export const brandMonthlyChannelContractorFees = sqliteTable("brand_monthly_channel_contractor_fees", {
  brandId: text("brand_id").notNull(), month: text("month").notNull(), instagramToman: integer("instagram_toman"),
  googleAdsToman: integer("google_ads_toman"), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [primaryKey({ columns: [table.brandId, table.month] })]);

// Dynamic channel costs remove the need for a schema or code release when a manager adds Telegram or any future source.
// A missing row means "not entered"; an explicit zero is stored as a valid confirmed amount.
export const brandChannelDailyCosts = sqliteTable("brand_channel_daily_costs", {
  brandId: text("brand_id").notNull(), date: text("date").notNull(), channelId: text("channel_id").notNull(),
  amountToman: integer("amount_toman").notNull(), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  primaryKey({ columns: [table.brandId, table.date, table.channelId] }),
  index("brand_channel_daily_costs_lookup_idx").on(table.brandId, table.date),
]);

export const brandChannelMonthlyCosts = sqliteTable("brand_channel_monthly_costs", {
  brandId: text("brand_id").notNull(), month: text("month").notNull(), channelId: text("channel_id").notNull(),
  mediaToman: integer("media_toman"), contractorToman: integer("contractor_toman"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  primaryKey({ columns: [table.brandId, table.month, table.channelId] }),
  index("brand_channel_monthly_costs_lookup_idx").on(table.brandId, table.month),
]);

export const brandMonthlyCurrencyRates = sqliteTable("brand_monthly_currency_rates", {
  brandId: text("brand_id").notNull(), month: text("month").notNull(), tryToToman: integer("try_to_toman").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [primaryKey({ columns: [table.brandId, table.month] })]);

// Every office approves its own monthly SMS unit price; no financial rule crosses brand boundaries.
export const brandMonthlySmsPrices = sqliteTable("brand_monthly_sms_prices", {
  brandId: text("brand_id").notNull(),
  month: text("month").notNull(),
  priceToman: integer("price_toman").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [primaryKey({ columns: [table.brandId, table.month] })]);

export const brandMonthlyExpertContracts = sqliteTable("brand_monthly_expert_contracts", {
  brandId: text("brand_id").notNull(), month: text("month").notNull(), expert: text("expert").notNull(), contractCount: integer("contract_count").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [primaryKey({ columns: [table.brandId, table.month, table.expert] })]);

export const brandExpertContractRecords = sqliteTable("brand_expert_contract_records", {
  id: integer("id").primaryKey({ autoIncrement: true }), brandId: text("brand_id").notNull(), month: text("month").notNull(), expert: text("expert").notNull(),
  leadRef: text("lead_ref").notNull(), sheetRow: text("sheet_row").notNull(), firstContactDate: text("first_contact_date").notNull(),
  sourceChannel: text("source_channel").notNull(), rawSourceChannel: text("raw_source_channel").notNull(), route: text("route"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  index("brand_contract_records_lookup_idx").on(table.brandId, table.month, table.expert),
  uniqueIndex("brand_contract_records_lead_idx").on(table.brandId, table.leadRef),
]);

// Stores the currently published no-code rules for each isolated brand.
export const brandDashboardRules = sqliteTable("brand_dashboard_rules", {
  brandId: text("brand_id").primaryKey(), configJson: text("config_json").notNull(), version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Every publish and restore is immutable so a manager can safely roll back a broken configuration.
export const brandDashboardRuleVersions = sqliteTable("brand_dashboard_rule_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }), brandId: text("brand_id").notNull(), version: integer("version").notNull(),
  configJson: text("config_json").notNull(), action: text("action").notNull().default("publish"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("brand_rule_versions_lookup_idx").on(table.brandId, table.version)]);

// Safe structured events power the health center and downloadable diagnostic bundle without storing passenger PII or secrets.
export const brandSystemEvents = sqliteTable("brand_system_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), brandId: text("brand_id").notNull(), severity: text("severity").notNull(),
  component: text("component").notNull(), eventCode: text("event_code").notNull(), message: text("message").notNull(), safeContext: text("safe_context").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("brand_system_events_lookup_idx").on(table.brandId, table.createdAt)]);
