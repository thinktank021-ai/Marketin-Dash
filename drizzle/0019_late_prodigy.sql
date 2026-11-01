CREATE TABLE IF NOT EXISTS `telegram_report_dispatch_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`locked_until` integer NOT NULL
);
