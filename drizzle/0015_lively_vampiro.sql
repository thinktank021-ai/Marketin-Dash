ALTER TABLE `brand_google_ads_service_accounts` ADD `developer_token_encrypted` text;--> statement-breakpoint
UPDATE `brand_google_ads_service_accounts`
SET `developer_token_encrypted` = (
  SELECT `developer_token_encrypted` FROM `brand_google_ads_credentials`
  WHERE `brand_google_ads_credentials`.`brand_id` = `brand_google_ads_service_accounts`.`brand_id`
)
WHERE `developer_token_encrypted` IS NULL;--> statement-breakpoint
UPDATE `dashboard_brands`
SET `google_ads_status` = 'pending',
    `google_ads_message` = 'Service Account این دفتر باید مستقل تنظیم و آزمایش شود.'
WHERE `id` NOT IN (
  SELECT `brand_id` FROM `brand_google_ads_service_accounts`
  WHERE `developer_token_encrypted` IS NOT NULL
);--> statement-breakpoint
DROP TABLE `brand_google_ads_credentials`;--> statement-breakpoint
DROP TABLE `google_ads_oauth_states`;--> statement-breakpoint
ALTER TABLE `dashboard_brands` DROP COLUMN `google_ads_mode`;
