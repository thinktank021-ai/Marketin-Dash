CREATE TABLE `dashboard_login_attempts` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dashboard_login_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`credential_version` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dashboard_login_sessions_expiry_idx` ON `dashboard_login_sessions` (`expires_at`);