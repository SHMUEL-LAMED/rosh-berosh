ALTER TABLE `ballots` ADD `voter_email` text;
CREATE TABLE `blocked_fingerprints` (
	`survey_id` text NOT NULL REFERENCES `surveys`(`id`) ON DELETE cascade,
	`fingerprint` text NOT NULL,
	`blocked_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
CREATE UNIQUE INDEX `blocked_fingerprints_unique` ON `blocked_fingerprints` (`survey_id`,`fingerprint`);
