CREATE TABLE `brand_monthly_sms_prices` (
	`brand_id` text NOT NULL,
	`month` text NOT NULL,
	`price_toman` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `month`)
);
