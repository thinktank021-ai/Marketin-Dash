import assert from "node:assert/strict";
import test from "node:test";

import { resolveDailyReportDate } from "../app/dashboard-date-selection.ts";

const base = {
  selectedMonth: "1405/06",
  currentMonth: "1405/06",
  todayDate: "1405/06/28",
  availableDates: ["1405/06/26", "1405/06/27", "1405/06/28"],
};

test("default current month uses today when today has data", () => {
  assert.deepEqual(resolveDailyReportDate({ ...base, manualDateOverride: null }), {
    date: "1405/06/28",
    mode: "today",
  });
});

test("default current month keeps today visible when today has zero records", () => {
  assert.deepEqual(resolveDailyReportDate({
    ...base,
    availableDates: ["1405/06/27"],
    manualDateOverride: null,
  }), {
    date: "1405/06/28",
    mode: "today",
  });
});

test("explicit date selection overrides the today/latest fallback", () => {
  assert.deepEqual(resolveDailyReportDate({ ...base, manualDateOverride: "1405/06/26" }), {
    date: "1405/06/26",
    mode: "selected",
  });
});

test("explicit date with no records stays empty instead of showing another day", () => {
  assert.deepEqual(resolveDailyReportDate({ ...base, manualDateOverride: "1405/06/25" }), {
    date: "",
    mode: "empty",
  });
});

test("a non-current month still falls back to its latest recorded date without manual selection", () => {
  assert.deepEqual(resolveDailyReportDate({
    ...base,
    selectedMonth: "1405/05",
    availableDates: ["1405/05/20", "1405/05/22"],
    manualDateOverride: null,
  }), {
    date: "1405/05/22",
    mode: "latest",
  });
});
