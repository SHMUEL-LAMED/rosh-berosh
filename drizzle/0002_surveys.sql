CREATE TABLE `surveys` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `active` integer DEFAULT false NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `surveys` (`id`, `name`, `active`) VALUES ('main', 'הסקר הראשי', 1);
--> statement-breakpoint
ALTER TABLE `albums` ADD `survey_id` text DEFAULT 'main' NOT NULL;
--> statement-breakpoint
ALTER TABLE `artists` ADD `survey_id` text DEFAULT 'main' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ballots` ADD `survey_id` text DEFAULT 'main' NOT NULL;
--> statement-breakpoint
CREATE INDEX `albums_survey_idx` ON `albums` (`survey_id`);
--> statement-breakpoint
CREATE INDEX `artists_survey_idx` ON `artists` (`survey_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `ballots_voter_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ballots_voter_survey_unique` ON `ballots` (`survey_id`,`voter_key`);
