CREATE TABLE `expert_contract_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
CREATE UNIQUE INDEX `expert_contract_records_lead_ref_unique` ON `expert_contract_records` (`lead_ref`);