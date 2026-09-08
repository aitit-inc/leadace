DROP TABLE "web_previews" CASCADE;--> statement-breakpoint
DELETE FROM chat_rate_windows WHERE scope = 'web_preview';
