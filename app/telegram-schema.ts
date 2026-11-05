/**
 * Repairs legacy Telegram tables created by older dashboard releases.
 * D1 and local SQLite both support PRAGMA table_info and ALTER TABLE ADD COLUMN.
 * Never drops or recreates a table: approved recipients and encrypted tokens survive.
 */
type SqlDb = {
  prepare(sql: string): {
    all<T = { name: string }>(): Promise<{ results?: T[] }>;
    run(): Promise<unknown>;
  };
};

const REQUIRED_COLUMNS: Record<string, Record<string, string>> = {
  telegram_bot_settings: {
    chat_id: "TEXT",
    activation_requested: "INTEGER NOT NULL DEFAULT 0",
    change_alerts_enabled: "INTEGER NOT NULL DEFAULT 1",
    health_updates_enabled: "INTEGER NOT NULL DEFAULT 1",
    interval_minutes: "INTEGER NOT NULL DEFAULT 10",
    end_of_day_enabled: "INTEGER NOT NULL DEFAULT 1",
    normal_report_time: "TEXT NOT NULL DEFAULT '18:30'",
    thursday_report_time: "TEXT NOT NULL DEFAULT '14:40'",
    iran_holiday_calendar: "TEXT NOT NULL DEFAULT 'fixed'",
    suppress_empty_morning: "INTEGER NOT NULL DEFAULT 1",
    last_bot_username: "TEXT",
    last_checked_at: "TEXT",
    last_report_status: "TEXT NOT NULL DEFAULT 'never'",
    last_report_at: "TEXT",
    last_report_error: "TEXT",
    scheduler_secret_encrypted: "TEXT",
    scheduler_secret_previous_encrypted: "TEXT",
    scheduler_secret_previous_expires_at: "TEXT",
    last_scheduler_at: "TEXT",
    last_scheduler_status: "TEXT NOT NULL DEFAULT 'never'",
    last_scheduler_error: "TEXT",
    automatic_suppressed_day: "TEXT",
    telegram_update_offset: "INTEGER NOT NULL DEFAULT 0",
    updated_at: "TEXT",
  },
  telegram_bot_users: {
    username: "TEXT",
    display_name: "TEXT NOT NULL DEFAULT 'کاربر Telegram'",
    discovered_at: "TEXT",
    approved_at: "TEXT",
    last_seen_at: "TEXT",
  },
};

/** Only predefined table/column identifiers enter SQL; existing columns are never changed. */
export async function repairTelegramSchema(db: SqlDb): Promise<string[]> {
  const applied: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const data = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const present = new Set((data.results || []).map(column => column.name));
    if (present.size === 0) throw new Error("telegram_schema_missing_table");
    for (const [name, definition] of Object.entries(required)) {
      if (present.has(name)) continue;
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
        applied.push(`${table}.${name}`);
      } catch (error) {
        // A simultaneous cron or admin request may have added the column.
        const latest = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
        if (!(latest.results || []).some(column => column.name === name)) throw error;
      }
    }
  }
  return applied;
}
