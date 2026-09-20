CREATE INDEX `ballots_survey_channel_idx` ON `ballots` (`survey_id`,`created_at`,`channel`);
CREATE INDEX `ballots_voter_key_idx` ON `ballots` (`voter_key`);
CREATE INDEX `ballots_survey_fingerprint_idx` ON `ballots` (`survey_id`,`fingerprint`);
CREATE INDEX `subscribers_user_sub_idx` ON `subscribers` (`user_sub`);
