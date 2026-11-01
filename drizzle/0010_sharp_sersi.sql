CREATE TABLE `brand_channel_daily_costs` (
	`brand_id` text NOT NULL,
	`date` text NOT NULL,
	`channel_id` text NOT NULL,
	`amount_toman` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `date`, `channel_id`)
);
--> statement-breakpoint
CREATE INDEX `brand_channel_daily_costs_lookup_idx` ON `brand_channel_daily_costs` (`brand_id`,`date`);--> statement-breakpoint
CREATE TABLE `brand_channel_monthly_costs` (
	`brand_id` text NOT NULL,
	`month` text NOT NULL,
	`channel_id` text NOT NULL,
	`media_toman` integer,
	`contractor_toman` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `month`, `channel_id`)
);
--> statement-breakpoint
CREATE INDEX `brand_channel_monthly_costs_lookup_idx` ON `brand_channel_monthly_costs` (`brand_id`,`month`);