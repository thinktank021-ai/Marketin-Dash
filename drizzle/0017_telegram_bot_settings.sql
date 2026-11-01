CREATE TABLE `telegram_bot_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`bot_token_encrypted` text,
	`chat_id` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`change_alerts_enabled` integer DEFAULT 1 NOT NULL,
	`health_updates_enabled` integer DEFAULT 1 NOT NULL,
	`interval_minutes` integer DEFAULT 10 NOT NULL,
	`last_bot_username` text,
	`last_checked_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
