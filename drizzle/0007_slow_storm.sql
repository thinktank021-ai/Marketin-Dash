CREATE TABLE `brand_expert_contract_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brand_id` text NOT NULL,
	`month` text NOT NULL,
	`expert` text NOT NULL,
	`lead_ref` text NOT NULL,
	`sheet_row` text NOT NULL,
	`first_contact_date` text NOT NULL,
	`source_channel` text NOT NULL,
	`raw_source_channel` text NOT NULL,
	`route` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brand_contract_records_lookup_idx` ON `brand_expert_contract_records` (`brand_id`,`month`,`expert`);--> statement-breakpoint
CREATE UNIQUE INDEX `brand_contract_records_lead_idx` ON `brand_expert_contract_records` (`brand_id`,`lead_ref`);--> statement-breakpoint
CREATE TABLE `brand_monthly_channel_contractor_fees` (
	`brand_id` text NOT NULL,
	`month` text NOT NULL,
	`instagram_toman` integer,
	`google_ads_toman` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `month`)
);
--> statement-breakpoint
CREATE TABLE `brand_monthly_currency_rates` (
	`brand_id` text NOT NULL,
	`month` text NOT NULL,
	`try_to_toman` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `month`)
);
--> statement-breakpoint
CREATE TABLE `brand_monthly_expert_contracts` (
	`brand_id` text NOT NULL,
	`month` text NOT NULL,
	`expert` text NOT NULL,
	`contract_count` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `month`, `expert`)
);
--> statement-breakpoint
CREATE TABLE `brand_weekly_ad_budgets` (
	`brand_id` text NOT NULL,
	`date` text NOT NULL,
	`week_start` text NOT NULL,
	`weekday` text NOT NULL,
	`sms_toman` integer,
	`instagram_toman` integer,
	`google_ads_toman` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`brand_id`, `date`)
);
--> statement-breakpoint
CREATE INDEX `brand_budgets_lookup_idx` ON `brand_weekly_ad_budgets` (`brand_id`,`week_start`,`date`);--> statement-breakpoint
CREATE TABLE `dashboard_brands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL,
	`logo_key` text,
	`logo_path` text,
	`sheet_csv_url` text DEFAULT '' NOT NULL,
	`sheet_index_url` text DEFAULT '' NOT NULL,
	`sheet_status` text DEFAULT 'pending' NOT NULL,
	`sheet_message` text DEFAULT 'آزمایش نشده' NOT NULL,
	`google_ads_mode` text DEFAULT 'oauth' NOT NULL,
	`google_ads_customer_id` text DEFAULT '' NOT NULL,
	`google_ads_login_customer_id` text DEFAULT '' NOT NULL,
	`google_ads_status` text DEFAULT 'pending' NOT NULL,
	`google_ads_message` text DEFAULT 'اتصال انجام نشده' NOT NULL,
	`config_status` text DEFAULT 'draft' NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
