CREATE TABLE `monthly_channel_contractor_fees` (
	`month` text PRIMARY KEY NOT NULL,
	`instagram_toman` integer,
	`google_ads_toman` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
