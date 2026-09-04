CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`picture` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
CREATE INDEX `auth_sessions_expires_idx` ON `auth_sessions` (`expires_at`);
CREATE TABLE `site_ballot_progress` (
	`survey_id` text NOT NULL,
	`user_sub` text NOT NULL,
	`data_json` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`survey_id`, `user_sub`),
	FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `site_ballot_progress_updated_idx` ON `site_ballot_progress` (`updated_at`);
CREATE TABLE `media_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`survey_id` text NOT NULL,
	`album_id` text NOT NULL,
	`song_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `media_uploads_created_idx` ON `media_uploads` (`created_at`);
