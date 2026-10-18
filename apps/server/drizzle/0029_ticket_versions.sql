ALTER TABLE "tickets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE FUNCTION "tickets_bump_version"() RETURNS trigger AS $$
BEGIN
	IF (NEW.title, NEW.body, NEW.system_state, NEW.outcome, NEW.column_id, NEW.assignee_agent_id, NEW.assigned_to_owner, NEW.risk, NEW.plan_first)
		IS DISTINCT FROM (OLD.title, OLD.body, OLD.system_state, OLD.outcome, OLD.column_id, OLD.assignee_agent_id, OLD.assigned_to_owner, OLD.risk, OLD.plan_first) THEN
		NEW.version = OLD.version + 1;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "tickets_bump_version" BEFORE UPDATE ON "tickets" FOR EACH ROW EXECUTE FUNCTION "tickets_bump_version"();
