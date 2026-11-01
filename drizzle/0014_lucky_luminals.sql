CREATE TABLE `brand_google_ads_service_accounts` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`service_account_email` text NOT NULL,
	`project_id` text,
	`private_key_encrypted` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
