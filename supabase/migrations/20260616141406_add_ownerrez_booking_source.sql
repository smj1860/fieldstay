
-- Add 'ownerrez' to the booking_source enum
-- PostgreSQL requires this specific syntax to add enum values
ALTER TYPE booking_source ADD VALUE IF NOT EXISTS 'ownerrez';
