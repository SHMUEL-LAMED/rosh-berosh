CREATE TABLE `ballot_rate_limits` (
  `bucket` text PRIMARY KEY NOT NULL,
  `count` integer NOT NULL,
  `reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ballot_rate_limits_reset_idx` ON `ballot_rate_limits` (`reset_at`);
