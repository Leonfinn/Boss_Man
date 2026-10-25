ALTER TABLE "companies" ADD COLUMN "ticket_prefix" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "next_ticket_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "number" integer;--> statement-breakpoint
-- Tickets imported from Paperclip keep their number: their body ends "Imported from HOL-12". A repeat keeps the oldest.
UPDATE "tickets" SET "number" = m.n FROM (
	SELECT id, n, row_number() OVER (PARTITION BY company_id, n ORDER BY created_at, id) AS dup
	FROM (SELECT id, company_id, created_at, (substring(body from 'Imported from [A-Z][A-Z0-9]*-([0-9]{1,9})\s*$'))::int AS n FROM "tickets" WHERE body ~ 'Imported from [A-Z][A-Z0-9]*-[0-9]{1,9}\s*$') x
) m WHERE m.id = "tickets".id AND m.dup = 1;--> statement-breakpoint
-- The prefix those imports used, else the first three letters or digits of the company's name.
UPDATE "companies" c SET "ticket_prefix" = coalesce(
	(SELECT substring(t.body from 'Imported from ([A-Z][A-Z0-9]*)-[0-9]{1,9}\s*$') AS p FROM "tickets" t WHERE t.company_id = c.id AND t.number IS NOT NULL GROUP BY p ORDER BY count(*) DESC, p LIMIT 1),
	nullif(upper(left(regexp_replace(c.name, '[^A-Za-z0-9]', '', 'g'), 3)), ''),
	'TKT'
);--> statement-breakpoint
-- Every other ticket is numbered after them, oldest first.
UPDATE "tickets" SET "number" = m.n FROM (
	SELECT id, coalesce((SELECT max(x.number) FROM "tickets" x WHERE x.company_id = y.company_id), 0) + row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS n
	FROM "tickets" y WHERE number IS NULL
) m WHERE m.id = "tickets".id;--> statement-breakpoint
UPDATE "companies" c SET "next_ticket_number" = coalesce((SELECT max(t.number) FROM "tickets" t WHERE t.company_id = c.id), 0) + 1;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_company_number" ON "tickets" USING btree ("company_id","number");--> statement-breakpoint
-- New tickets take the company's next number; one given (an import) moves the sequence past it. The row lock on the company keeps two inserts apart.
CREATE FUNCTION "tickets_assign_number"() RETURNS trigger AS $$
BEGIN
	IF NEW.number IS NULL THEN
		UPDATE "companies" SET "next_ticket_number" = "next_ticket_number" + 1 WHERE id = NEW.company_id RETURNING "next_ticket_number" - 1 INTO NEW.number;
	ELSE
		UPDATE "companies" SET "next_ticket_number" = GREATEST("next_ticket_number", NEW.number + 1) WHERE id = NEW.company_id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "tickets_assign_number" BEFORE INSERT ON "tickets" FOR EACH ROW EXECUTE FUNCTION "tickets_assign_number"();
