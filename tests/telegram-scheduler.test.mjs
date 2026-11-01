import assert from "node:assert/strict";
import test from "node:test";
import { schedulerHealthError, schedulerSecretMatches } from "../app/telegram-scheduler.ts";

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
