ALTER TABLE "runs" ADD COLUMN "input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cached_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cached_write_tokens" bigint;