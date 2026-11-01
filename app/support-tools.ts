export type BackupRow = Record<string, unknown>;
export type ValidatedBackupData = {
  budgets: BackupRow[];
  contractorFees: BackupRow[];
  channelDailyCosts: BackupRow[];
  channelMonthlyCosts: BackupRow[];
  smsPrices: BackupRow[];
  rates: BackupRow[];
  contracts: BackupRow[];
  contractRecords: BackupRow[];
  rowCount: number;
};

const backupRows = (value: unknown) => Array.isArray(value) ? value.filter((row): row is BackupRow => Boolean(row) && typeof row === "object") : [];
const monthPattern = /^1\d{3}\/(0[1-9]|1[0-2])$/;
const datePattern = /^1\d{3}\/(0[1-9]|1[0-2])\/([0-2]\d|3[01])$/;
const validOptionalMoney = (value: unknown) => value === null || value === undefined || (Number.isFinite(Number(value)) && Number(value) >= 0);

/** Recursively removes secrets from diagnostic output, including unknown future event shapes. */
export function diagnosticSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(diagnosticSafe);
  if (!value || typeof value !== "object") {
    const text = String(value ?? "");
    return /(?:bearer\s+|ya29\.|client_secret|refresh_token|developer[_ -]?token)/i.test(text) ? "[حذف‌شده]" : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /secret|token|password|authorization|credential/i.test(key) ? "[حذف‌شده]" : diagnosticSafe(item)]));
}

/** Validates the entire backup before the first database write and returns bounded normalized row sets. */
export function validateBackupPayload(backup: unknown, brandId: string): { rulesInput: unknown; data: ValidatedBackupData } {
  const input = backup as { format?: string; schemaVersion?: number; brand?: { id?: string }; rules?: { rules?: unknown }; data?: Record<string, unknown> };
  if (input?.format !== "marketing-dashboard-backup" || ![1, 2, 3].includes(Number(input.schemaVersion))) throw new Error("فرمت یا نسخه فایل پشتیبان پشتیبانی نمی‌شود؛ هیچ داده‌ای تغییر نکرد.");
  if (input.brand?.id !== brandId) throw new Error("فایل پشتیبان متعلق به این برند نیست؛ هیچ داده‌ای تغییر نکرد.");
  const source = input.data || {};
  const budgets = backupRows(source.budgets); const contractorFees = backupRows(source.contractorFees); const rates = backupRows(source.rates);
  const channelDailyCosts = backupRows(source.channelDailyCosts); const channelMonthlyCosts = backupRows(source.channelMonthlyCosts);
  const smsPrices = backupRows(source.smsPrices);
  const contracts = backupRows(source.contracts); const contractRecords = backupRows(source.contractRecords);
  const rowCount = budgets.length + contractorFees.length + channelDailyCosts.length + channelMonthlyCosts.length + smsPrices.length + rates.length + contracts.length + contractRecords.length;
  if (rowCount > 1000) throw new Error("تعداد ردیف‌های فایل پشتیبان بیش از حد امن بازیابی خودکار است؛ فایل را برای بررسی فنی ارسال کنید.");
  const valid = (rows: BackupRow[], required: string[]) => rows.every(row => required.every(key => row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== ""));
  if (!valid(budgets, ["date", "weekStart", "weekday"]) || !valid(contractorFees, ["month"]) || !valid(channelDailyCosts, ["date", "channelId", "amountToman"]) || !valid(channelMonthlyCosts, ["month", "channelId"]) || !valid(smsPrices, ["month", "priceToman"]) || !valid(rates, ["month", "tryToToman"]) || !valid(contracts, ["month", "expert", "contractCount"]) || !valid(contractRecords, ["month", "expert", "leadRef", "sheetRow", "firstContactDate", "sourceChannel", "rawSourceChannel"])) {
    throw new Error("ساختار یکی از ردیف‌های فایل پشتیبان معتبر نیست؛ هیچ داده‌ای تغییر نکرد.");
  }
  const valuesValid = budgets.every(row => datePattern.test(String(row.date)) && datePattern.test(String(row.weekStart)) && validOptionalMoney(row.smsToman) && validOptionalMoney(row.instagramToman))
    && contractorFees.every(row => monthPattern.test(String(row.month)) && validOptionalMoney(row.instagramToman) && validOptionalMoney(row.googleAdsToman))
    && channelDailyCosts.every(row => datePattern.test(String(row.date)) && Boolean(String(row.channelId).trim()) && validOptionalMoney(row.amountToman))
    && channelMonthlyCosts.every(row => monthPattern.test(String(row.month)) && Boolean(String(row.channelId).trim()) && validOptionalMoney(row.mediaToman) && validOptionalMoney(row.contractorToman))
    && smsPrices.every(row => monthPattern.test(String(row.month)) && Number.isSafeInteger(Number(row.priceToman)) && Number(row.priceToman) > 0)
    && rates.every(row => monthPattern.test(String(row.month)) && Number.isFinite(Number(row.tryToToman)) && Number(row.tryToToman) > 0)
    && contracts.every(row => monthPattern.test(String(row.month)) && Number.isInteger(Number(row.contractCount)) && Number(row.contractCount) >= 0)
    && contractRecords.every(row => monthPattern.test(String(row.month)) && datePattern.test(String(row.firstContactDate)));
  if (!valuesValid) throw new Error("تاریخ یا مقدار عددی نامعتبر در فایل پشتیبان پیدا شد؛ هیچ داده‌ای تغییر نکرد.");
  return { rulesInput: input.rules?.rules, data: { budgets, contractorFees, channelDailyCosts, channelMonthlyCosts, smsPrices, rates, contracts, contractRecords, rowCount } };
}
