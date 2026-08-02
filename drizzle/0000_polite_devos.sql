CREATE TABLE `albums` (`id` text PRIMARY KEY NOT NULL, `title` text NOT NULL, `artist_name` text NOT NULL, `cover_url` text, `position` integer DEFAULT 0 NOT NULL, `active` integer DEFAULT true NOT NULL);
--> statement-breakpoint
CREATE TABLE `songs` (`id` text PRIMARY KEY NOT NULL, `album_id` text NOT NULL, `title` text NOT NULL, `audio_url` text, `position` integer DEFAULT 0 NOT NULL, `active` integer DEFAULT true NOT NULL, FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `songs_album_idx` ON `songs` (`album_id`);
--> statement-breakpoint
CREATE TABLE `artists` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `image_url` text, `position` integer DEFAULT 0 NOT NULL, `active` integer DEFAULT true NOT NULL);
--> statement-breakpoint
CREATE TABLE `ballots` (`id` text PRIMARY KEY NOT NULL, `voter_key` text NOT NULL, `channel` text DEFAULT 'site' NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `ballots_voter_unique` ON `ballots` (`voter_key`);
--> statement-breakpoint
CREATE TABLE `album_votes` (`ballot_id` text NOT NULL, `album_id` text NOT NULL, FOREIGN KEY (`ballot_id`) REFERENCES `ballots`(`id`) ON DELETE cascade, FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`));
--> statement-breakpoint
CREATE UNIQUE INDEX `album_votes_unique` ON `album_votes` (`ballot_id`,`album_id`);
--> statement-breakpoint
CREATE TABLE `song_votes` (`ballot_id` text NOT NULL, `album_id` text NOT NULL, `song_id` text NOT NULL, FOREIGN KEY (`ballot_id`) REFERENCES `ballots`(`id`) ON DELETE cascade, FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`), FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`));
--> statement-breakpoint
CREATE UNIQUE INDEX `song_votes_album_unique` ON `song_votes` (`ballot_id`,`album_id`);
--> statement-breakpoint
CREATE TABLE `artist_votes` (`ballot_id` text NOT NULL, `artist_id` text NOT NULL, FOREIGN KEY (`ballot_id`) REFERENCES `ballots`(`id`) ON DELETE cascade, FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`));
--> statement-breakpoint
CREATE UNIQUE INDEX `artist_votes_unique` ON `artist_votes` (`ballot_id`,`artist_id`);
