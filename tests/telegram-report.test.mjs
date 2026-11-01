import assert from "node:assert/strict";
import test from "node:test";
import { formatReport } from "../app/telegram-report-format.ts";
import { selectCurrentReportMonth } from "../app/telegram-report-source.ts";

const now = { date: "1405/06/31", time: "13:33", weekday: "دوشنبه" };

function summary(overrides = {}) {
  return {
    totalToday: 0,
    totalMonth: 0,
    contractsToday: 0,
    contractsMonth: 0,
    channels: {},
    routes: {},
    experts: {},
    budgetToday: 0,
    clicksToday: 0,
    sheetReceivedAt: "13:33",
    previousTotal: 0,
    deltaToday: 0,
    stale: false,
    ...overrides,
  };
}

test("manual Telegram report keeps the complete zero state visible", () => {
  const report = formatReport([
    { brand: { name: "دفتر دنیاگردی" }, summary: summary() },
    { brand: { name: "نوآوران سپید" }, summary: summary() },
  ], now, "manual");

  assert.match(report, /گزارش دستی/);
  assert.match(report, /دفتر دنیاگردی/);
  assert.match(report, /نوآوران سپید/);
  assert.match(report, /تعداد کلیک امروز: 0/);
  assert.match(report, /بودجه مصرف‌شده امروز: 0\.0 لیر/);
  assert.match(report, /مجموع خط گزارش قبل: 0/);
  assert.match(report, /تغییر نسبت به گزارش قبل: \+0 خط/);
  assert.match(report, /کانال‌های ورودی امروز: بدون ورودی ثبت‌شده/);
  assert.match(report, /تعداد قرارداد امروز: 0/);
  assert.equal((report.match(/مجموع تعداد خط: 0/g) || []).length, 2);
});

test("Telegram report preserves positive channels and distinguishes unavailable Ads data", () => {
  const report = formatReport([{ brand: { name: "دفتر دنیاگردی" }, summary: summary({
    totalToday: 7,
    contractsToday: 2,
    channels: { "اینستاگرام": 4, "مسافر ثابت": 3, "پیامک": 0 },
    budgetToday: null,
    clicksToday: null,
    previousTotal: null,
    deltaToday: null,
  }) }], now, "manual");

  assert.match(report, /تعداد خط اینستا: 4/);
  assert.match(report, /تعداد خط مسافر ثابت: 3/);
  assert.doesNotMatch(report, /تعداد خط اس ام اس/);
  assert.match(report, /تعداد کلیک امروز: ثبت نشده/);
  assert.match(report, /بودجه مصرف‌شده امروز: ثبت نشده/);
  assert.match(report, /گزارش قبل: اولین گزارش امروز/);
  assert.match(report, /مجموع تعداد خط: 7/);
});

test("current Telegram report tab is selected by canonical Persian month value and gid", () => {
  const months = [
    { value: "1405/07", label: "مهر 1405", gid: "101", sheetName: "مهر 1405" },
    { value: "1405/06", label: "شهریور 1405", gid: "957380023", sheetName: "شهریور1405" },
  ];
  assert.equal(selectCurrentReportMonth(months, "1405/06/31")?.gid, "957380023");
  assert.equal(selectCurrentReportMonth(months, "1405/05/31"), null);
});
