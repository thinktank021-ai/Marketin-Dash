import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticSafe, validateBackupPayload } from "../app/support-tools.ts";

const validBackup = () => ({
  format: "marketing-dashboard-backup", schemaVersion: 1, brand: { id: "brand-a" }, rules: { rules: { marker: true } },
  data: {
    budgets: [{ date: "1405/06/01", weekStart: "1405/06/01", weekday: "شنبه", smsToman: 0, instagramToman: 120000 }],
    contractorFees: [{ month: "1405/06", instagramToman: 0, googleAdsToman: 500000 }],
    rates: [{ month: "1405/06", tryToToman: 2500 }],
    contracts: [{ month: "1405/06", expert: "کارشناس تست", contractCount: 2 }],
    contractRecords: [{ month: "1405/06", expert: "کارشناس تست", leadRef: "1405/06:2", sheetRow: "2", firstContactDate: "1405/06/01", sourceChannel: "پیامک", rawSourceChannel: "SMS", route: "گرجستان" }],
  },
});

test("diagnostic package removes nested secrets and token-shaped values", () => {
  const safe = diagnosticSafe({ clientSecret: "secret", nested: { authorization: "Bearer abc", note: "safe" }, message: "refresh_token=abc" }) as Record<string, unknown>;
  assert.equal(safe.clientSecret, "[حذف‌شده]");
  assert.deepEqual(safe.nested, { authorization: "[حذف‌شده]", note: "safe" });
  assert.equal(safe.message, "[حذف‌شده]");
});

test("valid same-brand backup passes with exact row count", () => {
  const result = validateBackupPayload(validBackup(), "brand-a");
  assert.equal(result.data.rowCount, 5);
  assert.deepEqual(result.rulesInput, { marker: true });
});

test("wrong-brand backup is rejected before writes", () => {
  assert.throws(() => validateBackupPayload(validBackup(), "brand-b"), /متعلق به این برند نیست/);
});

test("unsupported schema is rejected before writes", () => {
  const backup = validBackup(); backup.schemaVersion = 99;
  assert.throws(() => validateBackupPayload(backup, "brand-a"), /نسخه فایل/);
});

test("negative money and malformed dates are rejected before writes", () => {
  const backup = validBackup(); backup.data.budgets[0].smsToman = -1; backup.data.budgets[0].date = "1405/13/45";
  assert.throws(() => validateBackupPayload(backup, "brand-a"), /تاریخ یا مقدار عددی نامعتبر/);
});

test("oversized restore is blocked before writes", () => {
  const backup = validBackup();
  backup.data.contracts = Array.from({ length: 1001 }, (_, index) => ({ month: "1405/06", expert: `کارشناس ${index}`, contractCount: 0 }));
  assert.throws(() => validateBackupPayload(backup, "brand-a"), /بیش از حد امن/);
});
