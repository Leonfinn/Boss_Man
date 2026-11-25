ALTER TABLE "decisions" ADD COLUMN "info_ask_why" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "info_ask_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "info_ask_nagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owner_chat_messages" ADD COLUMN "info_ask_card_id" uuid;