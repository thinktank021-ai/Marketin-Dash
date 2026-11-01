ALTER TABLE `telegram_bot_settings` ADD `end_of_day_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_bot_settings` ADD `normal_report_time` text DEFAULT '18:30' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_bot_settings` ADD `thursday_report_time` text DEFAULT '14:40' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_bot_settings` ADD `iran_holiday_calendar` text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_bot_settings` ADD `suppress_empty_morning` integer DEFAULT 1 NOT NULL;