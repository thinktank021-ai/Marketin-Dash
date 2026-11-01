import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { authorizeTestEnv } from "./auth-support.mjs";

import { DEFAULT_DASHBOARD_RULES } from "../app/dashboard-rules.ts";

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) } }; }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
}

class D1Database {
  constructor() { this.database = new DatabaseSync(":memory:"); }
  prepare(sql) { return new D1Statement(this.database, sql); }
  async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}

test("stores a discovered Telegram budget and preserves zero versus not-entered", async () => {
  const DB = new D1Database();
  globalThis.__CLOUDFLARE_TEST_ENV = { DB, BUCKET: {} };
  const cookie = await authorizeTestEnv(globalThis.__CLOUDFLARE_TEST_ENV);
  const rules = { ...DEFAULT_DASHBOARD_RULES, channels: [...DEFAULT_DASHBOARD_RULES.channels, { id: "telegram", name: "تلگرام", aliases: ["تلگرام"], costMode: "daily_budget", contractorEnabled: true, color: "warning", icon: "•", enabled: true }] };
  await DB.prepare("INSERT INTO brand_dashboard_rules (brand_id,config_json,version) VALUES (?,?,1)").bind("test-brand", JSON.stringify(rules)).run();
  await DB.prepare("INSERT INTO brand_dashboard_rules (brand_id,config_json,version) VALUES (?,?,1)").bind("other-brand", JSON.stringify(rules)).run();

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("dynamic-budget-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const context = { waitUntil() {}, passThroughOnException() {} };
  const request = (path, init = {}) => worker.fetch(new Request(`http://localhost${path}`, { ...init, headers: { cookie, origin: "http://localhost", "content-type": "application/json", "x-dashboard-brand": "test-brand", ...(init.headers || {}) } }), globalThis.__CLOUDFLARE_TEST_ENV, context);
  const entries = Array.from({ length: 20 }, (_, index) => ({
    date: `1405/06/${String(index + 1).padStart(2, "0")}`,
    weekStart: "1405/06/01", weekday: "شنبه",
    amounts: { sms: null, instagram: null, telegram: index === 0 ? 0 : index === 1 ? null : 100_000 },
  }));
  const monthlyCosts = [{ month: "1405/06", channelId: "telegram", mediaToman: null, contractorToman: 500_000 }];

  let response = await request("/api/budgets", { method: "POST", body: JSON.stringify({ month: "1405/06", entries, monthlyCosts, smsUnitPriceToman: 480 }) });
  assert.equal(response.status, 200);
  response = await request("/api/budgets?from=1405%2F06%2F01&to=1405%2F06%2F20");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.entries[0].amounts.telegram, 0, "explicit zero must survive persistence");
  assert.equal(body.entries[1].amounts.telegram, undefined, "not-entered must remain absent/null, never become zero");
  assert.equal(body.entries[2].amounts.telegram, 100_000);
  assert.equal(body.monthlyCosts.find(item => item.channelId === "telegram").contractorToman, 500_000);
  assert.equal(body.smsPrices.find(item => item.month === "1405/06").priceToman, 480);
  assert.equal(DB.database.prepare("SELECT price_toman FROM brand_monthly_sms_prices WHERE brand_id = ? AND month = ?").get("test-brand", "1405/06").price_toman, 480, "SMS price must be isolated by office and month");

  response = await request("/api/budgets", { method: "POST", headers: { "x-dashboard-brand": "other-brand" }, body: JSON.stringify({ month: "1405/06", entries, monthlyCosts, smsUnitPriceToman: 750 }) });
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare("SELECT price_toman FROM brand_monthly_sms_prices WHERE brand_id = ? AND month = ?").get("test-brand", "1405/06").price_toman, 480);
  assert.equal(DB.database.prepare("SELECT price_toman FROM brand_monthly_sms_prices WHERE brand_id = ? AND month = ?").get("other-brand", "1405/06").price_toman, 750);

  response = await request("/api/budgets", { method: "POST", body: JSON.stringify({ month: "1405/06", entries, monthlyCosts, smsUnitPriceToman: 0 }) });
  assert.equal(response.status, 400, "zero must never be accepted as a divisor");
});
