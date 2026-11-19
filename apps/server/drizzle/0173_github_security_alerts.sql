CREATE TABLE "github_alert_tickets" (
	"project_id" uuid NOT NULL,
	"alert_key" text NOT NULL,
	"ticket_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_watches" ADD COLUMN "watch_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "github_watches" ADD COLUMN "alerts_error" text;--> statement-breakpoint
ALTER TABLE "github_alert_tickets" ADD CONSTRAINT "github_alert_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_alert_tickets" ADD CONSTRAINT "github_alert_tickets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_alert_tickets_alert" ON "github_alert_tickets" USING btree ("project_id","alert_key");