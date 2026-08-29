CREATE TABLE `ivr_admin_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `phone` text NOT NULL,
  `action` text NOT NULL,
  `target` text,
  `status` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ivr_admin_audit_created_idx` ON `ivr_admin_audit` (`created_at`);
