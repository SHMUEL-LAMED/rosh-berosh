ALTER TABLE `songs` ADD `preview_start` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `songs` ADD `preview_end` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `song_votes_album_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `song_votes_unique` ON `song_votes` (`ballot_id`,`album_id`,`song_id`);
--> statement-breakpoint
CREATE TABLE `poll_settings` (`id` text PRIMARY KEY DEFAULT 'main' NOT NULL, `voting_open` integer DEFAULT true NOT NULL, `albums_enabled` integer DEFAULT true NOT NULL, `albums_min` integer DEFAULT 5 NOT NULL, `albums_max` integer DEFAULT 5 NOT NULL, `songs_enabled` integer DEFAULT true NOT NULL, `songs_min` integer DEFAULT 1 NOT NULL, `songs_max` integer DEFAULT 1 NOT NULL, `artists_enabled` integer DEFAULT true NOT NULL, `artists_min` integer DEFAULT 1 NOT NULL, `artists_max` integer DEFAULT 3 NOT NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `poll_settings` (`id`) VALUES ('main');
