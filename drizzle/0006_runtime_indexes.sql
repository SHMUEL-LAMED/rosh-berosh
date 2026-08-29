CREATE INDEX `ballots_survey_created_idx` ON `ballots` (`survey_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ballots_fingerprint_idx` ON `ballots` (`fingerprint`) WHERE fingerprint is not null;
--> statement-breakpoint
CREATE INDEX `album_votes_album_idx` ON `album_votes` (`album_id`);
--> statement-breakpoint
CREATE INDEX `song_votes_song_idx` ON `song_votes` (`song_id`);
--> statement-breakpoint
CREATE INDEX `artist_votes_artist_idx` ON `artist_votes` (`artist_id`);
