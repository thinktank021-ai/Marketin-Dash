CREATE TABLE `google_ads_report_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`saved_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
