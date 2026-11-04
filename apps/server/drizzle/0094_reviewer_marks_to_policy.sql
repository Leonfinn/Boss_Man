-- BOS-198: Settings > Reviews is the one place that says who reviews. Every review-kind cell that said
-- "marked" (the agent marked on its agent page as the company's reviewer of that kind) now names that
-- agent itself, in company policies and project overrides alike:
--   one marked agent -> its id (the agent page allowed only one per kind, so this is every real case);
--   several (an old import could make two) -> the list of their ids, oldest first;
--   none -> "ceo", who reviewed it then anyway.
-- Cells that are off stay off: being marked never switched a review on. Retired agents never counted.
-- Only cells still saying "marked" change, so running it twice changes nothing.
-- agents.review_kind is kept, unread except by a leftover "marked", for one release (docs/10-migrations.md).
DO $$
DECLARE
  r record;
  tier text;
  k text;
  marks jsonb;
  pol jsonb;
BEGIN
  FOR r IN
    SELECT 'companies' AS tbl, id, id AS company_id, review_policy AS policy FROM companies
    UNION ALL
    SELECT 'projects', id, company_id, review_policy FROM projects WHERE review_policy IS NOT NULL
  LOOP
    pol := r.policy;
    FOREACH tier IN ARRAY ARRAY['trivial', 'low', 'medium', 'high', 'critical'] LOOP
      FOREACH k IN ARRAY ARRAY['security', 'infra', 'adversarial'] LOOP
        IF pol #>> ARRAY[tier, 'kinds', k] = 'marked' THEN
          SELECT coalesce(jsonb_agg(to_jsonb(a.id::text) ORDER BY a.created_at, a.id), '[]'::jsonb) INTO marks
            FROM agents a WHERE a.company_id = r.company_id AND a.review_kind = k AND a.retired_at IS NULL;
          pol := jsonb_set(pol, ARRAY[tier, 'kinds', k], CASE jsonb_array_length(marks) WHEN 0 THEN '"ceo"'::jsonb WHEN 1 THEN marks -> 0 ELSE marks END);
        END IF;
      END LOOP;
    END LOOP;
    IF pol IS DISTINCT FROM r.policy THEN
      IF r.tbl = 'companies' THEN
        UPDATE companies SET review_policy = pol WHERE id = r.id;
      ELSE
        UPDATE projects SET review_policy = pol WHERE id = r.id;
      END IF;
    END IF;
  END LOOP;
END $$;
