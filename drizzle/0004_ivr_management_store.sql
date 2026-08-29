CREATE TABLE `ivr_recorders` (
  `phone` text PRIMARY KEY NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ivr_prompts` (
  `key` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `audio_url` text NOT NULL,
  `yemot_path` text DEFAULT '' NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ivr_store_meta` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL
);
