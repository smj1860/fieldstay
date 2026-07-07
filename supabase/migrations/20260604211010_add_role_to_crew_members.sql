DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crew_role') THEN
    CREATE TYPE crew_role AS ENUM ('lead', 'member', 'inspector');
  END IF;
END $$;

ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS role crew_role NOT NULL DEFAULT 'member';
