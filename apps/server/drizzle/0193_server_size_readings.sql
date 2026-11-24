CREATE TABLE "server_size_readings" (
	"day" text PRIMARY KEY NOT NULL,
	"db_bytes" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
