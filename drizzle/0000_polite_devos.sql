CREATE TABLE `surveys` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'single' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`question` text NOT NULL,
	`options_json` text NOT NULL,
	`channels_json` text DEFAULT '["site"]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `surveys_status_idx` ON `surveys` (`status`);--> statement-breakpoint
CREATE TABLE `votes` (
	`id` text PRIMARY KEY NOT NULL,
	`survey_id` text NOT NULL,
	`voter_key` text NOT NULL,
	`answers_json` text NOT NULL,
	`channel` text DEFAULT 'site' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `votes_survey_voter_unique` ON `votes` (`survey_id`,`voter_key`);--> statement-breakpoint
CREATE INDEX `votes_survey_idx` ON `votes` (`survey_id`);