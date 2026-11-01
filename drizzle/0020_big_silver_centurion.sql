CREATE TABLE `telegram_brand_settings` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_official_holidays` (
	`date` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'official_iran_calendar' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_report_brand_state` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`last_total_today` integer DEFAULT 0 NOT NULL,
	`last_report_day` text,
	`last_report_at` text,
	`last_sheet_at` text
);
--> statement-breakpoint
ALTER TABLE `telegram_bot_settings` ADD `automatic_suppressed_day` text;