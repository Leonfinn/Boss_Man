CREATE INDEX "decisions_status" ON "decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_unread_decision" ON "notifications" USING btree ("decision_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "nudges_wake" ON "nudges" USING btree ("wake_id");--> statement-breakpoint
CREATE INDEX "runs_live" ON "runs" USING btree ("company_id") WHERE "runs"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "runs_ticket_started" ON "runs" USING btree ("ticket_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_agent_started" ON "runs" USING btree ("agent_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_ended" ON "runs" USING btree ("ended_at" DESC NULLS LAST) WHERE "runs"."ended_at" is not null;--> statement-breakpoint
CREATE INDEX "ticket_dependencies_blocked" ON "ticket_dependencies" USING btree ("blocked_ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_dependencies_blocker" ON "ticket_dependencies" USING btree ("blocker_ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_watcher" ON "tickets" USING btree ("watcher_agent_id") WHERE "tickets"."watcher_agent_id" is not null;--> statement-breakpoint
CREATE INDEX "tickets_monitor_at" ON "tickets" USING btree ("monitor_at") WHERE "tickets"."monitor_at" is not null;
