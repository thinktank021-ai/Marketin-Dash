import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { authorizeTestEnv } from "./auth-support.mjs";

test("authenticated dashboard root renders without a server-side exception", async () => {
  const database = new DatabaseSync(":memory:");
  const DB = {
    database,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() { const result = database.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
        async first() { return database.prepare(sql).get(...values) || null; },
        async all() { return { results: database.prepare(sql).all(...values) }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
  const env = globalThis.__CLOUDFLARE_TEST_ENV = { DB, BUCKET: {}, GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };
  const cookie = await authorizeTestEnv(env);
  const worker = (await import(`../dist/server/index.js?ssr-smoke=${Date.now()}`)).default;
  const response = await worker.fetch(new Request("http://localhost/", { headers: { cookie, origin: "http://localhost" } }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Marketing Manager Dashboard|داشبورد/);
  database.close();
});
