import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { authorizeTestEnv } from "./auth-support.mjs";

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
}

class D1Database {
  constructor() { this.database = new DatabaseSync(":memory:"); }
  prepare(sql) { return new D1Statement(this.database, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

test("creates and safely deletes one brand-scoped detailed contract", async () => {
  globalThis.__CLOUDFLARE_TEST_ENV = { DB: new D1Database(), BUCKET: {} };
  const cookie = await authorizeTestEnv(globalThis.__CLOUDFLARE_TEST_ENV);
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("contract-delete-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const context = { waitUntil() {}, passThroughOnException() {} };
  const request = (path, brand, init = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    ...init,
    headers: { cookie, origin: "http://localhost", "content-type": "application/json", "x-dashboard-brand": brand, ...(init.headers || {}) },
  }), globalThis.__CLOUDFLARE_TEST_ENV, context);
  const record = {
    month: "1405/06", expert: "آزمون موقت حذف", leadRef: "1405/06:QA-DELETE-1", sheetRow: "QA-DELETE-1",
    firstContactDate: "1405/06/08", sourceChannel: "سایر", rawSourceChannel: "سایر", route: "تست موقت",
  };

  let response = await request("/api/expert-contract-records", "donyagardi", { method: "POST", body: JSON.stringify(record) });
  assert.equal(response.status, 201);
  let body = await response.json();
  assert.ok(body.record?.id, "create response must return the saved record for instant UI reconciliation");
  assert.equal(body.record.expert, record.expert);
  response = await request("/api/expert-contract-records", "donyagardi", { method: "POST", body: JSON.stringify(record) });
  assert.equal(response.status, 409, "duplicate lead must be rejected");
  response = await request("/api/expert-contract-records?month=1405%2F06", "donyagardi");
  body = await response.json();
  const created = body.records.find(item => item.leadRef === record.leadRef);
  assert.ok(created?.id, "created record must be listed");
  response = await request("/api/expert-contracts?month=1405%2F06", "donyagardi");
  body = await response.json();
  const upperTableEntry = body.entries.find(item => item.expert === record.expert);
  assert.equal(upperTableEntry?.detailedContractCount, 1, "upper-table aggregate must increase with the detailed list");

  response = await request("/api/expert-contract-records", "another-brand", { method: "DELETE", body: JSON.stringify({ id: created.id }) });
  assert.equal(response.status, 404, "another brand must never delete the record");
  response = await request("/api/expert-contract-records?month=1405%2F06", "donyagardi");
  body = await response.json();
  assert.ok(body.records.some(item => item.id === created.id), "cross-brand delete must preserve the record");

  response = await request("/api/expert-contract-records", "donyagardi", { method: "DELETE", body: JSON.stringify({ id: created.id }) });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.deleted, true);
  assert.equal(body.record.leadRef, record.leadRef);
  response = await request("/api/expert-contract-records?month=1405%2F06", "donyagardi");
  body = await response.json();
  assert.equal(body.records.some(item => item.id === created.id), false, "deleted record must disappear");
  response = await request("/api/expert-contracts?month=1405%2F06", "donyagardi");
  body = await response.json();
  assert.equal(body.entries.some(item => item.expert === record.expert), false, "upper-table aggregate must decrease after delete");
  response = await request("/api/expert-contract-records", "donyagardi", { method: "DELETE", body: JSON.stringify({ id: created.id }) });
  assert.equal(response.status, 404, "repeat delete must not report false success");
});
