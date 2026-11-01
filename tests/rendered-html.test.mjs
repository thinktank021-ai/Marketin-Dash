import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/login", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /login-password/);
  assert.doesNotMatch(html, /خروج خودکار پس از ۲۰ دقیقه بی‌فعالیتی/);
  assert.match(html, /هشدار دسترسی غیرمجاز/);
  assert.match(html, /دسترسی غیرمجاز قطعا پیامدهای قانونی در پی دارد\./);
  assert.match(html, /loginWarningPulse/);
  assert.doesNotMatch(html, /برای ادامه، وارد حساب کاربری شوید/);
  const protectedPage = await worker.fetch(new Request("http://localhost/"), {}, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.get("location"), "/login");
  const protectedApi = await worker.fetch(new Request("http://localhost/api/brands"), {}, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(protectedApi.status, 401);
});
