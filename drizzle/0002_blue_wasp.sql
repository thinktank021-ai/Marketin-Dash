CREATE TABLE `monthly_expert_contracts` (
	`month` text NOT NULL,
	`expert` text NOT NULL,
	`contract_count` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`month`, `expert`)
);
