export type CostMode = "none" | "daily_budget" | "monthly_budget" | "google_ads";
export type ChannelRule = { id: string; name: string; aliases: string[]; costMode: CostMode; contractorEnabled: boolean; color: string; icon: string; enabled: boolean };
export type MergeRule = { target: string; aliases: string[] };
export type SheetColumnRules = { date: string; weekday: string; source: string; route: string; expert: string; outcome: string; notes: string };
export type DashboardRules = {
  schemaVersion: 1;
  rulesVersion: string;
  channels: ChannelRule[];
  routes: MergeRule[];
  experts: MergeRule[];
  sheetColumns: SheetColumnRules;
  contractOutcomes: string[];
  formulas: { cpl: "cost_per_paid_lead"; cac: "cost_per_attributed_contract"; expertAllocation: "channel_lead_share"; includeContractorFees: boolean };
};

// Semantic colors are intentionally finite and stable so every channel remains
// recognizable across daily cards, range reports, budgets, contracts, and charts.
const CHANNEL_COLOR_PALETTE = ["gold", "teal", "coral", "green", "blue", "sand", "violet", "warning", "indigo", "magenta", "cyan", "orange", "lime", "plum", "sky", "rose"];
const PREFERRED_CHANNEL_COLORS: Record<string, string> = {
  sms: "gold",
  google_ads: "teal",
  instagram: "coral",
  whatsapp: "green",
  site_form: "blue",
  loyal: "sand",
  agency: "violet",
  novavaran: "indigo",
  other: "warning",
};
const normalizeChannelIdentity = (value: unknown) => String(value || "").normalize("NFKC").replace(/ي|ى/g, "ی").replace(/ك/g, "ک").replace(/[\s‌_-]/g, "").toLocaleLowerCase("fa");
const MERGED_PASSENGER_ALIASES = ["مسافر ثابت", "مسافر قدیمی", "آژانسی", "همکار", "حضوری"];

/** Assigns unique semantic palette slots while respecting stable built-in channel identities. */
function assignDistinctChannelColors(channels: ChannelRule[]) {
  const used = new Set<string>();
  return channels.map((channel, index) => {
    const requested = CHANNEL_COLOR_PALETTE.includes(channel.color) ? channel.color : "";
    const preferred = PREFERRED_CHANNEL_COLORS[channel.id] || "";
    const color = [preferred, requested, CHANNEL_COLOR_PALETTE[index % CHANNEL_COLOR_PALETTE.length], ...CHANNEL_COLOR_PALETTE]
      .find(candidate => candidate && !used.has(candidate)) || CHANNEL_COLOR_PALETTE[index % CHANNEL_COLOR_PALETTE.length];
    used.add(color);
    return color === channel.color ? channel : { ...channel, color };
  });
}

/** Merges repeat/referral/walk-in sources into the manager-approved passenger channel. */
function mergePassengerChannels(channels: ChannelRule[]) {
  const identitySet = new Set(MERGED_PASSENGER_ALIASES.map(normalizeChannelIdentity));
  const loyalIndex = channels.findIndex(channel => channel.id === "loyal" || identitySet.has(normalizeChannelIdentity(channel.name)) && normalizeChannelIdentity(channel.name) !== normalizeChannelIdentity("آژانسی") && normalizeChannelIdentity(channel.name) !== normalizeChannelIdentity("همکار") && normalizeChannelIdentity(channel.name) !== normalizeChannelIdentity("حضوری"));
  const mergeIndexes = channels.map((channel, index) => channel.id === "agency" || ["آژانسی", "همکار", "حضوری"].includes(normalizeChannelIdentity(channel.name)) ? index : -1).filter(index => index >= 0);
  if (loyalIndex < 0 && mergeIndexes.length === 0) return { channels, changed: false };
  const base = loyalIndex >= 0 ? channels[loyalIndex] : {
    id: "loyal", name: "مسافر ثابت", aliases: [], costMode: "none" as CostMode,
    contractorEnabled: false, color: "sand", icon: "♙", enabled: true,
  };
  const aliases = [...new Set([...base.aliases, ...MERGED_PASSENGER_ALIASES, ...mergeIndexes.flatMap(index => [channels[index].name, ...channels[index].aliases])])];
  const loyal = { ...base, id: "loyal", name: "مسافر ثابت", aliases, costMode: "none" as CostMode, contractorEnabled: false, enabled: true, color: "sand" };
  const next = channels
    .filter((_, index) => !mergeIndexes.includes(index) && index !== loyalIndex)
    .map(channel => ({ ...channel, aliases: channel.aliases.filter(alias => !identitySet.has(normalizeChannelIdentity(alias))) }));
  next.splice(Math.min(loyalIndex >= 0 ? loyalIndex : next.length, next.length), 0, loyal);
  return { channels: next, changed: JSON.stringify(next) !== JSON.stringify(channels) };
}

export const DEFAULT_DASHBOARD_RULES: DashboardRules = {
  schemaVersion: 1,
  rulesVersion: "1.0.0",
  channels: [
    { id: "sms", name: "پیامک", aliases: ["پیامک", "اس ام اس", "اس‌ام‌اس", "SMS"], costMode: "daily_budget", contractorEnabled: false, color: "gold", icon: "✉", enabled: true },
    { id: "google_ads", name: "گوگل ادز", aliases: ["تبلیغات گوگل", "گوگل ادز", "گوگل‌ادز"], costMode: "google_ads", contractorEnabled: true, color: "teal", icon: "G", enabled: true },
    { id: "instagram", name: "اینستاگرام", aliases: ["اینستاگرام"], costMode: "daily_budget", contractorEnabled: true, color: "coral", icon: "◎", enabled: true },
    { id: "whatsapp", name: "واتساپ", aliases: ["واتساپ", "واتس اپ", "واتس‌آپ"], costMode: "google_ads", contractorEnabled: false, color: "green", icon: "◉", enabled: true },
    { id: "site_form", name: "فرم سایت", aliases: ["فرم سایت"], costMode: "google_ads", contractorEnabled: false, color: "blue", icon: "▤", enabled: true },
    { id: "loyal", name: "مسافر ثابت", aliases: MERGED_PASSENGER_ALIASES, costMode: "none", contractorEnabled: false, color: "sand", icon: "♙", enabled: true },
    { id: "novavaran", name: "نوآوران", aliases: ["نوآوران", "تواوران"], costMode: "none", contractorEnabled: false, color: "violet", icon: "⌁", enabled: true },
    { id: "other", name: "سایر", aliases: ["سایر", "معرفی"], costMode: "none", contractorEnabled: false, color: "warning", icon: "…", enabled: true },
  ],
  routes: [{ target: "گرجستان", aliases: ["گرجستان", "باتومی", "تفلیس"] }],
  experts: [],
  sheetColumns: { date: "تاریخ", weekday: "روز هفته", source: "منبع فایل", route: "مسیر", expert: "کارشناس", outcome: "نتیجه", notes: "توضیحات" },
  contractOutcomes: ["قرارداد شد"],
  formulas: { cpl: "cost_per_paid_lead", cac: "cost_per_attributed_contract", expertAllocation: "channel_lead_share", includeContractorFees: true },
};

/**
 * Keeps persisted office rules compatible with the shared dashboard core.
 * Office-specific routes, experts, columns and entered costs are preserved;
 * only invariant feature capabilities are repaired here.
 */
export function normalizeCoreDashboardRules(value: unknown) {
  const rules = validateDashboardRules(value);
  let changed = false;
  const merged = mergePassengerChannels(rules.channels);
  changed ||= merged.changed;
  const colored = assignDistinctChannelColors(merged.channels);
  changed ||= JSON.stringify(colored) !== JSON.stringify(merged.channels);
  const channels = colored.map(channel => {
    if (channel.id === "google_ads" && channel.costMode === "google_ads" && !channel.contractorEnabled) {
      changed = true;
      return { ...channel, contractorEnabled: true };
    }
    return channel;
  });
  return { rules: changed ? { ...rules, channels } : { ...rules, channels }, changed };
}

const clean = (value: unknown) => String(value || "").trim();
const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))].slice(0, 40) : [];

/** Accepts only bounded declarative settings; executable formulas and arbitrary code are impossible. */
export function validateDashboardRules(value: unknown): DashboardRules {
  const input = value && typeof value === "object" ? value as Partial<DashboardRules> : {};
  const channels = Array.isArray(input.channels) ? input.channels.slice(0, 30).map((item, index) => {
    const channel = item as Partial<ChannelRule>;
    const name = clean(channel.name);
    if (!name) throw new Error(`نام کانال ردیف ${index + 1} خالی است.`);
    const costMode: CostMode = ["none", "daily_budget", "monthly_budget", "google_ads"].includes(String(channel.costMode)) ? channel.costMode as CostMode : "none";
    const aliases = [...new Set([name, ...strings(channel.aliases)])];
    const legacyContractorDefault = channel.contractorEnabled === undefined && ["instagram", "google_ads"].includes(clean(channel.id));
    return { id: clean(channel.id) || `channel-${index + 1}`, name, aliases, costMode, contractorEnabled: costMode !== "none" && (channel.contractorEnabled === true || legacyContractorDefault), color: clean(channel.color) || "warning", icon: clean(channel.icon).slice(0, 2) || "•", enabled: channel.enabled !== false };
  }) : DEFAULT_DASHBOARD_RULES.channels;
  const channelIds = new Set<string>();
  channels.forEach(channel => { if (channelIds.has(channel.id)) throw new Error(`شناسه کانال تکراری است: ${channel.id}`); channelIds.add(channel.id); });
  const seenAliases = new Map<string, string>();
  channels.filter(channel => channel.enabled).forEach(channel => channel.aliases.forEach(alias => {
    const key = alias.replace(/[\s‌_-]/g, "").toLowerCase();
    const owner = seenAliases.get(key);
    if (owner && owner !== channel.id) throw new Error(`نام جایگزین «${alias}» هم‌زمان در دو کانال استفاده شده است.`);
    seenAliases.set(key, channel.id);
  }));
  const mergeRules = (items: unknown, fallback: MergeRule[]) => Array.isArray(items) ? items.slice(0, 50).map(item => ({ target: clean((item as MergeRule).target), aliases: strings((item as MergeRule).aliases) })).filter(item => item.target && item.aliases.length) : fallback;
  const columns = input.sheetColumns || DEFAULT_DASHBOARD_RULES.sheetColumns;
  // Date and source define a usable lead row. Every other module is optional and may be deliberately disabled with an empty mapping.
  const sheetColumns = Object.fromEntries(Object.keys(DEFAULT_DASHBOARD_RULES.sheetColumns).map(key => [key, clean((columns as Record<string, string>)[key])])) as SheetColumnRules;
  if (!sheetColumns.date) throw new Error("ستون تاریخ الزامی است؛ آن را در راهنمای اتصال Google Sheets انتخاب کنید.");
  if (!sheetColumns.source) throw new Error("ستون کانال ورودی الزامی است؛ آن را در راهنمای اتصال Google Sheets انتخاب کنید.");
  const contractOutcomes = strings(input.contractOutcomes);
  if (!contractOutcomes.length) throw new Error("حداقل یک نتیجه قرارداد لازم است.");
  return {
    schemaVersion: 1,
    rulesVersion: (clean(input.rulesVersion) || "1.0.0").slice(0, 30),
    channels,
    routes: mergeRules(input.routes, DEFAULT_DASHBOARD_RULES.routes),
    experts: mergeRules(input.experts, []),
    sheetColumns,
    contractOutcomes,
    formulas: { ...DEFAULT_DASHBOARD_RULES.formulas, includeContractorFees: true },
  };
}
