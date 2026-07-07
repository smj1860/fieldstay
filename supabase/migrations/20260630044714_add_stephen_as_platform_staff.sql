
INSERT INTO platform_staff (user_id, role)
VALUES ('f880f6e6-fdbd-4f9e-b3ce-0b0c6d51e527', 'admin')
ON CONFLICT (user_id) DO NOTHING;
