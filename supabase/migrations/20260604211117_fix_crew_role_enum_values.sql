ALTER TABLE crew_members DROP COLUMN IF EXISTS role;
DROP TYPE IF EXISTS crew_role;
CREATE TYPE crew_role AS ENUM ('cleaning', 'landscaping', 'maintenance', 'general');
ALTER TABLE crew_members ADD COLUMN role crew_role NOT NULL DEFAULT 'general';
