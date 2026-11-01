CREATE TABLE `weekly_ad_budgets` (
	`date` text PRIMARY KEY NOT NULL,
	`week_start` text NOT NULL,
	`weekday` text NOT NULL,
	`sms_toman` integer,
	`instagram_toman` integer,
	`google_ads_toman` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
