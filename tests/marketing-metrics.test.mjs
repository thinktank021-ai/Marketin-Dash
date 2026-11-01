import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DASHBOARD_RULES, normalizeCoreDashboardRules, validateDashboardRules } from "../app/dashboard-rules.ts";
import { aggregateDisplayCosts, calculateOverallRangeMetric, rankContractRoutes } from "../app/marketing-metrics.ts";

test("aggregates Google Ads budget aliases into one display chip", () => {
  assert.deepEqual(aggregateDisplayCosts({ "گوگل ادز": 120, واتساپ: 30, "فرم سایت": 50, اینستاگرام: 90, پیامک: 0 }, ["گوگل ادز", "واتساپ", "فرم سایت"], "گوگل ادز"), [["اینستاگرام", 90], ["گوگل ادز", 200]]);
});

test("calculates brand-wide CPL and CAC only from matching paid channels", () => {
  const metric = calculateOverallRangeMetric({
    paidChannels: ["گوگل ادز", "اینستاگرام"],
    costsByChannel: { "گوگل ادز": 1_200_000, "اینستاگرام": 800_000 },
    leadsByChannel: { "گوگل ادز": 8, "اینستاگرام": 12, "مسافر ثابت": 100 },
    contractsByChannel: { "گوگل ادز": 2, "اینستاگرام": 3, "مسافر ثابت": 20 },
    totalContracts: 9,
    coverageIncomplete: false,
  });
  assert.equal(metric.totalCost, 2_000_000);
  assert.equal(metric.paidLeads, 20);
  assert.equal(metric.attributableContracts, 5);
  assert.equal(metric.cpl, 100_000);
  assert.equal(metric.cac, 400_000);
  assert.equal(metric.totalContracts, 9);
  assert.equal(metric.coverageComplete, true);
});

test("never presents a partial cost as complete brand-wide CPL or CAC", () => {
  const metric = calculateOverallRangeMetric({
    paidChannels: ["گوگل ادز", "اینستاگرام"],
    costsByChannel: { "گوگل ادز": 1_200_000, "اینستاگرام": null },
    leadsByChannel: { "گوگل ادز": 8, "اینستاگرام": 12 },
    contractsByChannel: { "گوگل ادز": 2, "اینستاگرام": 3 },
    totalContracts: 5,
    coverageIncomplete: true,
  });
  assert.equal(metric.totalCost, null);
  assert.equal(metric.cpl, null);
  assert.equal(metric.cac, null);
  assert.equal(metric.coverageComplete, false);
  assert.equal(metric.coveredCost, 1_200_000);
  assert.equal(metric.coveredLeads, 8);
  assert.equal(metric.coveredContracts, 2);
  assert.equal(metric.coveredCpl, 150_000);
  assert.equal(metric.coveredCac, 600_000);
  assert.deepEqual(metric.missingChannels, ["اینستاگرام"]);
});

test("unconnected Ads does not suppress manual-cost KPIs or enter their denominators", () => {
  const metric = calculateOverallRangeMetric({ paidChannels: ["پیامک", "گوگل ادز"], costsByChannel: { پیامک: 5_000_000, "گوگل ادز": null }, leadsByChannel: { پیامک: 100, "گوگل ادز": 117 }, contractsByChannel: { پیامک: 5, "گوگل ادز": 1 }, totalContracts: 6, coverageIncomplete: true });
  assert.equal(metric.cpl, null);
  assert.equal(metric.coveredCpl, 50_000);
  assert.equal(metric.coveredCac, 1_000_000);
  assert.equal(metric.coveredContracts, 5);
  assert.deepEqual(metric.missingChannels, ["گوگل ادز"]);
});

test("returns an explicit empty metric for zero paid leads and contracts", () => {
  const metric = calculateOverallRangeMetric({
    paidChannels: ["پیامک", "پیامک"],
    costsByChannel: { "پیامک": 0 },
    leadsByChannel: {},
    contractsByChannel: {},
    totalContracts: null,
    coverageIncomplete: false,
  });
  assert.equal(metric.totalCost, 0);
  assert.equal(metric.paidLeads, 0);
  assert.equal(metric.attributableContracts, 0);
  assert.equal(metric.cpl, null);
  assert.equal(metric.cac, null);
});

test("contractor fees remain a fixed rule for every brand configuration", () => {
  const rules = validateDashboardRules({
    ...DEFAULT_DASHBOARD_RULES,
    formulas: { ...DEFAULT_DASHBOARD_RULES.formulas, includeContractorFees: false },
  });
  assert.equal(rules.formulas.includeContractorFees, true);
});

test("normalizes the shared Google Ads contractor capability without replacing office rules", () => {
  const legacy = { ...DEFAULT_DASHBOARD_RULES, channels: DEFAULT_DASHBOARD_RULES.channels.map(channel => channel.id === "google_ads" ? { ...channel, contractorEnabled: false } : channel), routes: [{ target: "دفتر محلی", aliases: ["محلی"] }] };
  const result = normalizeCoreDashboardRules(legacy);
  assert.equal(result.changed, true);
  assert.equal(result.rules.channels.find(channel => channel.id === "google_ads")?.contractorEnabled, true);
  assert.deepEqual(result.rules.routes, legacy.routes);
});

test("merges agency, colleague, and walk-in sources into passenger and removes duplicate cards", () => {
  const legacy = {
    ...DEFAULT_DASHBOARD_RULES,
    channels: [
      { ...DEFAULT_DASHBOARD_RULES.channels.find(channel => channel.id === "loyal"), aliases: ["مسافر ثابت"] },
      { id: "agency", name: "آژانسی", aliases: ["آژانسی", "همکار"], costMode: "none", contractorEnabled: false, color: "blue", icon: "آ", enabled: true },
      { id: "walk-in", name: "حضوری", aliases: ["حضوری"], costMode: "none", contractorEnabled: false, color: "blue", icon: "ح", enabled: true },
    ],
  };
  const result = normalizeCoreDashboardRules(legacy);
  const loyal = result.rules.channels.find(channel => channel.id === "loyal");
  assert.equal(result.changed, true);
  assert.equal(result.rules.channels.filter(channel => channel.name === "مسافر ثابت").length, 1);
  assert.equal(result.rules.channels.some(channel => ["آژانسی", "حضوری"].includes(channel.name)), false);
  assert.deepEqual(new Set(["مسافر ثابت", "مسافر قدیمی", "آژانسی", "همکار", "حضوری"].map(alias => loyal?.aliases.includes(alias))), new Set([true]));
  assert.equal(loyal?.costMode, "none");
});

test("assigns distinct semantic colors when legacy channel settings repeat blue", () => {
  const result = normalizeCoreDashboardRules({
    ...DEFAULT_DASHBOARD_RULES,
    channels: DEFAULT_DASHBOARD_RULES.channels.map(channel => ({ ...channel, color: "blue" })),
  });
  const enabledColors = result.rules.channels.filter(channel => channel.enabled).map(channel => channel.color);
  assert.equal(new Set(enabledColors).size, enabledColors.length);
  assert.ok(enabledColors.some(color => color !== "blue"));
});

test("accepts a newly discovered paid channel without a code-specific allowlist", () => {
  const rules = validateDashboardRules({
    ...DEFAULT_DASHBOARD_RULES,
    channels: [...DEFAULT_DASHBOARD_RULES.channels, {
      id: "telegram", name: "تلگرام", aliases: ["تلگرام", "Telegram"], costMode: "daily_budget",
      contractorEnabled: true, color: "warning", icon: "•", enabled: true,
    }],
  });
  const telegram = rules.channels.find(channel => channel.id === "telegram");
  assert.equal(telegram?.costMode, "daily_budget");
  assert.equal(telegram?.contractorEnabled, true);
});

test("includes a newly added Telegram channel in brand CPL and CAC", () => {
  const metric = calculateOverallRangeMetric({
    paidChannels: ["تلگرام"], costsByChannel: { "تلگرام": 3_000_000 },
    leadsByChannel: { "تلگرام": 15, "مسافر ثابت": 20 }, contractsByChannel: { "تلگرام": 3 },
    totalContracts: 5, coverageIncomplete: false,
  });
  assert.equal(metric.cpl, 200_000);
  assert.equal(metric.cac, 1_000_000);
  assert.equal(metric.attributableContracts, 3);
});

test("ranks the top ten contract routes across experts and respects channel filters", () => {
  const matrix = {
    "کارشناس اول": {
      دبی: { "گوگل ادز": 4, اینستاگرام: 1 },
      استانبول: { "گوگل ادز": 2 },
      "بدون مسیر قابل انتساب": { "گوگل ادز": 8 },
    },
    "کارشناس دوم": {
      دبی: { "گوگل ادز": 2 },
      استانبول: { اینستاگرام: 5 },
      تفلیس: { پیامک: 3 },
    },
  };

  assert.deepEqual(rankContractRoutes(matrix), [
    { name: "استانبول", count: 7, channels: [{ name: "اینستاگرام", count: 5 }, { name: "گوگل ادز", count: 2 }] },
    { name: "دبی", count: 7, channels: [{ name: "گوگل ادز", count: 6 }, { name: "اینستاگرام", count: 1 }] },
    { name: "تفلیس", count: 3, channels: [{ name: "پیامک", count: 3 }] },
  ]);
  assert.deepEqual(rankContractRoutes(matrix, ["گوگل ادز"]), [
    { name: "دبی", count: 6, channels: [{ name: "گوگل ادز", count: 6 }] },
    { name: "استانبول", count: 2, channels: [{ name: "گوگل ادز", count: 2 }] },
  ]);
  const manyRoutes = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`مسیر ${index + 1}`, { پیامک: index + 1 }]));
  assert.equal(rankContractRoutes({ کارشناس: manyRoutes }).length, 10);
});
