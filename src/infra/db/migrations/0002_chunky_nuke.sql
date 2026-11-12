CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum_sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_key_unique` ON `files` (`key`);--> statement-breakpoint
CREATE INDEX `files_user_id_status_created_at_id_idx` ON `files` (`user_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `files_status_created_at_id_idx` ON `files` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `files_status_expires_at_idx` ON `files` (`status`,`expires_at`);