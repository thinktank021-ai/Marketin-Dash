CREATE TABLE `brand_dashboard_rule_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brand_id` text NOT NULL,
	`version` integer NOT NULL,
	`config_json` text NOT NULL,
	`action` text DEFAULT 'publish' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brand_rule_versions_lookup_idx` ON `brand_dashboard_rule_versions` (`brand_id`,`version`);--> statement-breakpoint
CREATE TABLE `brand_dashboard_rules` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brand_system_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brand_id` text NOT NULL,
	`severity` text NOT NULL,
	`component` text NOT NULL,
	`event_code` text NOT NULL,
	`message` text NOT NULL,
	`safe_context` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brand_system_events_lookup_idx` ON `brand_system_events` (`brand_id`,`created_at`);