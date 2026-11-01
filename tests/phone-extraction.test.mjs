import assert from "node:assert/strict";
import test from "node:test";

import { buildCsv, extractPhoneNumbers, findPhoneCellValue, matchesPhoneFilters, normalizePhoneNumber, resolveExtractionDateRange, toEnglishPhoneDigits } from "../app/phone-extraction.ts";

test("normalizes Persian digits and Iranian mobile formats", () => {
  assert.equal(toEnglishPhoneDigits("۰۹۱۲٣٤٥٦٧٨۹"), "09123456789");
  assert.deepEqual(normalizePhoneNumber("0912 345 6789"), { valid: true, normalized: "+989123456789", kind: "iran" });
  assert.equal(normalizePhoneNumber("0098-912-345-6789").normalized, "+989123456789");
  assert.equal(normalizePhoneNumber("+98 (912) 345 6789").normalized, "+989123456789");
  assert.equal(normalizePhoneNumber("9123456789").normalized, "+989123456789");
  assert.equal(normalizePhoneNumber("9.123456789E+9").normalized, "+989123456789");
});

test("accepts international numbers with a country prefix only", () => {
  assert.deepEqual(normalizePhoneNumber("+44 7700 900123"), { valid: true, normalized: "+447700900123", kind: "international" });
  assert.equal(normalizePhoneNumber("0049 151 23456789").normalized, "+4915123456789");
  assert.equal(normalizePhoneNumber("7700900123").reason, "missing_country_code");
  assert.equal(normalizePhoneNumber("0912345").reason, "invalid_iran");
});

test("extracts every Iranian and foreign phone stored in one cell", () => {
  assert.deepEqual(
    extractPhoneNumbers("۰۹۱۲۳۴۵۶۷۸۹ / +44 7700 900123\n0098-935-111-2233").map(phone => phone.normalized),
    ["+989123456789", "+447700900123", "+989351112233"],
  );
  assert.deepEqual(extractPhoneNumbers("شماره اول: 0912 345 6789، شماره دوم: 0935-111-2233").map(phone => phone.normalized), ["+989123456789", "+989351112233"]);
});

test("finds phone data under unexpected Sheet column titles", () => {
  assert.equal(findPhoneCellValue({ "تاریخ": "1405/06/08", "شماره مسافر جهت تماس": "9123456789", "مسیر": "دبی" }), "9123456789");
  assert.equal(findPhoneCellValue({ "تاریخ": "1405/06/08", "ستون ناشناس": "09123456789", "نتیجه": "پیگیری" }), "09123456789");
});

test("multi-select filters accept several channels, experts, and outcomes together", () => {
  const row = { channel: "اینستاگرام", route: "دبی", expert: "سارا", outcome: "پیگیری", contractStatus: "قرارداد نشده", phoneKind: "iran" };
  assert.equal(matchesPhoneFilters(row, {
    channels: ["اینستاگرام", "گوگل ادز"], routes: ["دبی", "استانبول"], experts: ["سارا", "علی"],
    outcomes: ["پیگیری", "قرارداد شد"], contract: "not-contracted", phoneKind: "all",
  }), true);
  assert.equal(matchesPhoneFilters(row, {
    channels: ["واتس‌اپ"], routes: [], experts: [], outcomes: [], contract: "all", phoneKind: "all",
  }), false);
});

test("default extraction end date never exceeds today", () => {
  assert.deepEqual(resolveExtractionDateRange("1405/6/01", "1405/06/31", "1405/06/08", ["1405/06", "1405/05"]), {
    startDate: "1405/06/01", endDate: "1405/06/08",
  });
  assert.deepEqual(resolveExtractionDateRange("1405/05/01", "1405/06/31", "1405/06/08", ["1405/06", "1405/05"]), {
    startDate: "1405/05/01", endDate: "1405/06/08",
  });
});

test("CSV export preserves Persian text and neutralizes spreadsheet formulas", () => {
  const csv = buildCsv(["شماره", "نام"], [{ "شماره": "+989123456789", "نام": "=cmd" }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("\"'+989123456789\""));
  assert.ok(csv.includes("\"'=cmd\""));
});
