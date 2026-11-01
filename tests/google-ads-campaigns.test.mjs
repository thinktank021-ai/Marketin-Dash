import assert from "node:assert/strict";
import test from "node:test";
import { attributeRouteMetricToCampaigns, buildRoutePerformance, sortGoogleAdsCampaigns } from "../app/google-ads-campaigns.ts";

const campaign = (campaignId, status, lastActivityDate, cost = 0, clicks = 0, impressions = 0) => ({
  campaignId, name: campaignId, status, lastActivityDate, cost, clicks, impressions,
});

test("enabled campaigns always appear before paused and removed campaigns", () => {
  const sorted = sortGoogleAdsCampaigns([
    campaign("paused-new", "PAUSED", "2026-09-05", 100),
    campaign("removed", "REMOVED", "2026-09-06", 200),
    campaign("enabled", "ENABLED", "2026-09-01", 1),
  ]);
  assert.deepEqual(sorted.map(item => item.campaignId), ["enabled", "paused-new", "removed"]);
});

test("when every campaign is paused, latest delivery inside the selected range appears first", () => {
  const sorted = sortGoogleAdsCampaigns([
    campaign("old", "PAUSED", "2026-08-20", 500),
    campaign("latest", "PAUSED", "2026-09-05", 20),
    campaign("middle", "PAUSED", "2026-09-01", 100),
  ]);
  assert.deepEqual(sorted.map(item => item.campaignId), ["latest", "middle", "old"]);
});

test("paused campaigns without delivery fall below campaigns that delivered in the selected range", () => {
  const sorted = sortGoogleAdsCampaigns([
    campaign("never-delivered", "PAUSED", undefined),
    campaign("delivered-without-date", "PAUSED", undefined, 0, 1, 1),
    campaign("dated", "PAUSED", "2026-09-02", 1),
  ]);
  assert.deepEqual(sorted.map(item => item.campaignId), ["dated", "delivered-without-date", "never-delivered"]);
});

test("sorting is deterministic when status and activity date are equal", () => {
  const sorted = sortGoogleAdsCampaigns([
    campaign("low", "PAUSED", "2026-09-02", 10, 10),
    campaign("high", "PAUSED", "2026-09-02", 20, 1),
  ]);
  assert.deepEqual(sorted.map(item => item.campaignId), ["high", "low"]);
});

test("route performance aggregates every campaign of the same route without splitting leads", () => {
  const campaigns = [campaign("istanbul-search", "ENABLED", "2026-09-02", 100, 5, 50), campaign("istanbul-pmax", "PAUSED", "2026-09-01", 40, 2, 20)];
  campaigns[0].name = "Istanbul Search"; campaigns[1].name = "Istanbul Performance";
  const result = buildRoutePerformance(campaigns, {
    "1405/06/10": { "استانبول": 3 }, "1405/06/11": { "استانبول": 4 },
  }, []);
  const istanbul = result.routes.find(route => route.route === "استانبول");
  assert.equal(istanbul.leads, 7);
  assert.equal(istanbul.cost, 140);
  assert.equal(istanbul.campaignIds.length, 2);
  assert.equal(istanbul.cpl, 20);
});

test("built-in bilingual aliases map English campaign names to Persian routes", () => {
  const campaigns = [campaign("georgia", "ENABLED", "2026-09-02", 100, 5, 50)]; campaigns[0].name = "Georgia";
  const result = buildRoutePerformance(campaigns, { "1405/06/10": { "گرجستان": 5 } }, [{ target: "گرجستان", aliases: ["تفلیس", "باتومی"] }]);
  assert.equal(result.routes[0].campaignIds[0], "georgia");
  assert.equal(result.routes[0].leads, 5);
});

test("manager-approved aliases extend route matching", () => {
  const campaigns = [campaign("custom", "ENABLED", "2026-09-02", 60, 3, 30)]; campaigns[0].name = "IST Sales";
  const result = buildRoutePerformance(campaigns, { "1405/06/10": { "استانبول": 2 } }, [{ target: "استانبول", aliases: ["IST"] }]);
  assert.equal(result.routes[0].campaignIds[0], "custom");
});

test("multi-route and unknown campaigns remain explicit and never allocate cost", () => {
  const campaigns = [campaign("mixed", "ENABLED", "2026-09-02", 100, 5, 50), campaign("brand", "ENABLED", "2026-09-02", 40, 2, 20)];
  campaigns[0].name = "Istanbul + Georgia"; campaigns[1].name = "Brand Search";
  const result = buildRoutePerformance(campaigns, { "1405/06/10": { "استانبول": 3, "گرجستان": 2, "تایلند": 1 } }, []);
  assert.equal(result.ambiguousCampaigns[0].campaign.campaignId, "mixed");
  assert.equal(result.unmatchedCampaigns[0].campaignId, "brand");
  assert.deepEqual(result.unmatchedRoutes.map(route => route.route).sort(), ["استانبول", "تایلند", "گرجستان"].sort());
  assert.equal(result.routes.reduce((sum, route) => sum + route.cost, 0), 0);
});

test("leads without a passenger route stay visible outside route calculations", () => {
  const result = buildRoutePerformance([], { "1405/06/10": { "مسیر ثبت نشده": 4 } }, []);
  assert.equal(result.missingRouteLeads, 4);
  assert.deepEqual(result.routes, []);
});

test("route contracts reach one campaign but are never guessed across shared campaigns", () => {
  const routes = [
    { route: "استانبول", campaignIds: ["istanbul"], campaignNames: [], leads: 8, cost: 0, impressions: 0, clicks: 0, cpl: null, ctr: 0, leadRate: 0 },
    { route: "گرجستان", campaignIds: ["georgia-search", "georgia-pmax"], campaignNames: [], leads: 5, cost: 0, impressions: 0, clicks: 0, cpl: null, ctr: 0, leadRate: 0 },
  ];
  assert.deepEqual(attributeRouteMetricToCampaigns(routes, { "استانبول": 3, "گرجستان": 2 }), {
    istanbul: 3,
    "georgia-search": null,
    "georgia-pmax": null,
  });
});
