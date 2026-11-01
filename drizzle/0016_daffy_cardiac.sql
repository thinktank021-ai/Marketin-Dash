CREATE TABLE `brand_search_console_service_accounts` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`property_url` text NOT NULL,
	`service_account_email` text NOT NULL,
	`project_id` text,
	`private_key_encrypted` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_console_report_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`saved_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
