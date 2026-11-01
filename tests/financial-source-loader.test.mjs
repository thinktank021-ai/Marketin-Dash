import assert from "node:assert/strict";
import test from "node:test";
import { readFinancialSource } from "../app/financial-source-loader.ts";

test("unconnected Google Ads cannot discard successfully loaded manual budgets", async () => {
  const saved = { entries: [{ date: "1405/05/01", amounts: { sms: 5000000, instagram: 0 } }], monthlyCosts: [] };
  const [budget, ads] = await Promise.all([
    readFinancialSource(async () => Response.json(saved), data => Array.isArray(data.entries)),
    readFinancialSource(async () => Response.json({ pending: true, reason: "service_account_not_configured" }, { status: 503 }), data => Boolean(data.totals)),
  ]);
  assert.deepEqual(budget.data, saved);
  assert.equal(ads.data, null);
  assert.equal(ads.pending, true);
  assert.equal(budget.data.entries[0].amounts.instagram, 0);
});
test("transport errors and invalid payloads affect only their source, never masquerading as zero costs", async () => {
  assert.deepEqual(await readFinancialSource(async () => { throw new TypeError("network"); }, () => true), { data: null, pending: false });
  assert.deepEqual(await readFinancialSource(async () => Response.json({}), value => Array.isArray(value.rates)), { data: null, pending: false });
  assert.deepEqual(await readFinancialSource(async () => Response.json({ totals: { cost: 0 }, daily: [] }), value => Boolean(value.totals)), { data: { totals: { cost: 0 }, daily: [] }, pending: false });
});
test("abort remains an abort so an old brand request cannot update the new brand", async () => {
  await assert.rejects(readFinancialSource(async () => { throw new DOMException("aborted", "AbortError"); }, () => true), { name: "AbortError" });
});
