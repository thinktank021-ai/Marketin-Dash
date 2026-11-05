import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("Telegram API GET exposes a non-secret release marker even on settings failure", () => {
  const api = readFileSync(new URL("../app/api/telegram-bot/route.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/telegram-bot-settings-card.tsx", import.meta.url), "utf8");
  assert.match(api, /TELEGRAM_API_RELEASE\s*=\s*"telegram-cpanel-diagnostic-2026-11-05"/);
  assert.match(api, /apiRelease:\s*TELEGRAM_API_RELEASE/g);
  assert.match(ui, /setApiRelease\(payload\.apiRelease/);
  assert.match(ui, /Telegram API:/);
});
