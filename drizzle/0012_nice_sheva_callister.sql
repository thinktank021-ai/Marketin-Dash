CREATE TABLE `dashboard_monthly_sms_prices` (
	`month` text PRIMARY KEY NOT NULL,
	`price_toman` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
