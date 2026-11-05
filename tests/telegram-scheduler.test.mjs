import assert from "node:assert/strict";
import test from "node:test";
import { dispatchFailureMessage, dispatchResponseStatus, schedulerHealthError, telegramOperationError, schedulerSecretMatches } from "../app/telegram-scheduler.ts";

test("scheduler accepts the current secret and a short rotation grace secret", () => {
  const now = Date.parse("2026-09-22T10:00:00.000Z");
  assert.equal(schedulerSecretMatches("current", "current", "previous", "2026-09-29T10:00:00.000Z", now), "current");
  assert.equal(schedulerSecretMatches("previous", "current", "previous", "2026-09-29T10:00:00.000Z", now), "grace");
  assert.equal(schedulerSecretMatches("previous", "current", "previous", "2026-09-21T10:00:00.000Z", now), null);
  assert.equal(schedulerSecretMatches("wrong", "current", "previous", "2026-09-29T10:00:00.000Z", now), null);
});

test("scheduler diagnostics explain a secret mismatch without exposing a secret", () => {
  const message = schedulerHealthError("secret_mismatch");
  assert.match(message, /Code\.gs/);
  assert.doesNotMatch(message, /current|previous/);
});

test("scheduler differentiates expected skips from missing sources and configuration", () => {
  assert.equal(dispatchResponseStatus({ sent: false, reason: "not_due" }), 200);
  assert.equal(dispatchResponseStatus({ sent: false, reason: "already_running" }), 200);
  assert.equal(dispatchResponseStatus({ sent: false, reason: "source_unavailable" }), 503);
  assert.equal(dispatchResponseStatus({ sent: false, reason: "no_enabled_brands" }), 409);
  assert.equal(dispatchResponseStatus({ sent: false, reason: "no_recipients" }), 409);
  assert.equal(dispatchResponseStatus({ sent: false, reason: "disabled" }), 409);
  assert.equal(dispatchResponseStatus({ sent: true }), 200);
});

test("Telegram errors are actionable without leaking upstream secrets", () => {
  assert.match(dispatchFailureMessage("source_unavailable"), /داده معتبر/);
  assert.match(dispatchFailureMessage("no_enabled_brands"), /دفتر فعال/);
  assert.equal(dispatchFailureMessage("not_due"), undefined);
});

test("manual Telegram errors expose safe diagnostic codes only", () => {
  assert.equal(telegramOperationError(new Error("telegram_token_missing")).code, "telegram_token_missing");
  assert.equal(telegramOperationError(new Error("google_ads_encryption_not_configured")).code, "encryption_configuration");
  assert.equal(telegramOperationError(new Error("SQLITE_ERROR: no such table: telegram_bot_settings")).code, "database_unavailable");
  assert.equal(telegramOperationError(new Error("telegram_403")).code, "telegram_recipient_forbidden");
  const sensitive = telegramOperationError(new Error("https://private-source.example/bot123:SECRET"));
  assert.equal(sensitive.code, "telegram_dispatch_failed");
  assert.doesNotMatch(JSON.stringify(sensitive), /private-source|SECRET/);
});
