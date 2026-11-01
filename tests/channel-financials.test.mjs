import assert from "node:assert/strict";
import test from "node:test";
import { buildFinancialChannels, findMissingDailyCosts } from "../app/channel-financials.ts";

const channel = (id, costMode = "daily_budget", enabled = true) => ({ id, name: id, aliases: [id], costMode, enabled, color: "teal", icon: "•", contractorEnabled: false });
test("current day and past missing costs are reported; future, outside range, organic and disabled are excluded", () => {
  const missing = findMissingDailyCosts({
    dates: ["1405/06/07", "1405/06/08", "1405/06/09", "1405/06/10"], start: "1405/06/08", end: "1405/06/31", today: "1405/06/09",
    channels: [channel("paid"), channel("organic", "none"), channel("disabled", "daily_budget", false)],
    entries: [{ date: "1405/06/08", amounts: { paid: 0 } }],
  });
  assert.deepEqual(missing, [{ date: "1405/06/09", channel: "paid" }]);
});
test("historical ranges stop at their selected end and a saved zero clears the warning", () => {
  const input = { dates: ["1405/05/30", "1405/05/31", "1405/06/01"], start: "1405/05/30", end: "1405/05/31", today: "1405/06/09", channels: [channel("new-channel")], entries: [] };
  assert.equal(findMissingDailyCosts(input).length, 2);
  input.entries = input.dates.map(date => ({ date, amounts: { "new-channel": 0 } }));
  assert.deepEqual(findMissingDailyCosts(input), []);
});
test("30 configured channels produce every paid card and never financial cards for organic sources", () => {
  const channels = Array.from({ length: 30 }, (_, i) => channel(`channel-${i}`, i % 2 ? "none" : "monthly_budget"));
  const costs = Object.fromEntries(channels.map(item => [item.name, 1000]));
  const leads = Object.fromEntries(channels.map(item => [item.name, 10]));
  const contracts = Object.fromEntries(channels.map(item => [item.name, 2]));
  const cards = buildFinancialChannels(channels, leads, contracts, costs);
  assert.equal(cards.length, 15);
  assert.ok(cards.every(item => item.cpl === 100 && item.cac === 500));
  assert.ok(cards.every(item => item.contracts === 2 && item.conversionRate === 20));
});
test("shared Google Ads surfaces aggregate once; custom paid sources preserve missing and zero costs", () => {
  const channels = [channel("google_ads", "google_ads"), channel("whatsapp", "google_ads"), channel("telegram"), channel("zero")];
  const cards = buildFinancialChannels(channels, { google_ads: 10, whatsapp: 5, telegram: 3, zero: 2 }, { google_ads: 2, whatsapp: 1, zero: 1 }, { google_ads: 1000, whatsapp: 500, telegram: null, zero: 0 });
  assert.equal(cards.length, 3);
  assert.equal(cards[0].costToman, 1500);
  assert.equal(cards[0].leads, 15);
  assert.equal(cards[0].contracts, 3);
  assert.equal(cards[0].conversionRate, 20);
  assert.equal(cards[0].cac, 500);
  assert.equal(cards[1].costToman, null);
  assert.equal(cards[2].cpl, 0);
});
