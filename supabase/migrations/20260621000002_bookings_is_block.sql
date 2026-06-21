-- Track whether a booking is an owner block vs a real guest booking.
-- Blocks must never generate turnovers or count as occupied stays.
ALTER TABLE bookings ADD COLUMN is_block boolean NOT NULL DEFAULT false;
