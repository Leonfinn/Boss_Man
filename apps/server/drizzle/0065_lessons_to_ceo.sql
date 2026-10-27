UPDATE "decisions" SET "tier" = 'ceo' WHERE "status" = 'open' AND "tier" = 'owner' AND "context"->>'type' IN ('lesson', 'lesson_replace');
