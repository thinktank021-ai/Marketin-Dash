import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { repairTelegramSchema } from "../app/telegram-schema.ts";

function legacyDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE telegram_bot_settings (
      id INTEGER PRIMARY KEY NOT NULL,
      bot_token_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 10
    );
    CREATE TABLE telegram_bot_users (
      user_id TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    INSERT INTO telegram_bot_settings (id, bot_token_encrypted, enabled) VALUES (1, 'encrypted-existing-token', 1);
    INSERT INTO telegram_bot_users (user_id, chat_id, status) VALUES ('user-1', 'private-chat', 'approved');
  `);
  const d1 = {
    prepare(sql) {
      return {
        async all() { return { results: sqlite.prepare(sql).all() }; },
        async run() { return sqlite.prepare(sql).run(); },
      };
    },
  };
  return { sqlite, d1 };
}

test("cPanel legacy Telegram tables are upgraded without losing token or approved recipient", async () => {
  const { sqlite, d1 } = legacyDatabase();
  try {
    const changes = await repairTelegramSchema(d1);
    assert.ok(changes.includes("telegram_bot_users.display_name"));
    assert.ok(changes.includes("telegram_bot_users.approved_at"));
    assert.ok(changes.includes("telegram_bot_settings.last_scheduler_status"));
    assert.ok(changes.includes("telegram_bot_settings.telegram_update_offset"));
    const user = sqlite.prepare("SELECT status, display_name, approved_at FROM telegram_bot_users WHERE user_id='user-1'").get();
    assert.equal(user.status, "approved");
    assert.ok(user.display_name);
    assert.equal(user.approved_at, null);
    const saved = sqlite.prepare("SELECT bot_token_encrypted, enabled FROM telegram_bot_settings WHERE id=1").get();
    assert.equal(saved.bot_token_encrypted, "encrypted-existing-token");
    assert.equal(saved.enabled, 1);
    assert.deepEqual(await repairTelegramSchema(d1), []);
  } finally {
    sqlite.close();
  }
});

test("legacy schema migration refuses absent tables without creating guessed data", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const d1 = { prepare(sql) { return {
      async all() { return { results: sqlite.prepare(sql).all() }; },
      async run() { return sqlite.prepare(sql).run(); },
    }; } };
    await assert.rejects(repairTelegramSchema(d1), /telegram_schema_missing_table/);
  } finally {
    sqlite.close();
  }
});
