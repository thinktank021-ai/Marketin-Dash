CREATE TABLE `brand_google_ads_credentials` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text NOT NULL,
	`developer_token_encrypted` text NOT NULL,
	`refresh_token_encrypted` text,
	`connected_email` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `google_ads_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sheet_csv_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`source_url` text NOT NULL,
	`selector` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sheet_csv_cache_brand_idx` ON `sheet_csv_cache` (`brand_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `sheet_month_registry_cache` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
