CREATE TABLE `subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`source` text DEFAULT 'site' NOT NULL,
	`survey_id` text,
	`user_sub` text,
	`consented_at` integer DEFAULT (unixepoch()) NOT NULL,
	`unsubscribed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
CREATE UNIQUE INDEX `subscribers_email_unique` ON `subscribers` (`email`);
CREATE INDEX `subscribers_created_idx` ON `subscribers` (`created_at`);
