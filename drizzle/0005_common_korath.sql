CREATE TABLE `monthly_currency_rates` (
	`month` text PRIMARY KEY NOT NULL,
	`try_to_toman` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
