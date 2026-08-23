-- An inspection can be STARTED at a property with no signal.
--
-- §8 originally required started_at to be a server clock, because "a device
-- clock is both skewable and, for an artifact whose entire value is being
-- believed, the wrong thing to trust." That made starting an inspection the one
-- online-only step in an otherwise offline feature — so offline inspections
-- only worked if somebody had remembered to create the row in advance.
--
-- WHY THE ORIGINAL ARGUMENT IS WEAKER THAN IT READS
--
-- started_at does exactly one job: it is the denominator of the 24-hour rule,
-- which exists so that "an inspection that took thirty hours is worth less to
-- an insurer than one that took four." It is not an identity and not an
-- ordering key. What a device clock puts at risk is a DURATION CLAIM, not the
-- record itself.
--
-- AND THE DURATION CLAIM SURVIVES, because at sync time the server holds both
-- clocks at once. The device sends what it believed the start time was AND what
-- it believes "now" is; the server subtracts to get the skew and corrects. A
-- tablet four hours off still yields a correct start time. The only residual
-- error is drift DURING the offline window — seconds over a morning.
--
-- What that does not stop is deliberate manipulation: set the clock back, walk
-- for three hours, set it forward before syncing. But the 24-hour rule was
-- never a defence against a dishonest inspector — someone faking it taps Pass
-- fifty-two times in four minutes. It defends against a SLOPPY one who leaves a
-- draft open over a weekend, and skew correction handles that completely.
--
-- SO: RECORD PROVENANCE RATHER THAN PRETEND.
--
-- The same pattern the weather already uses. ConditionsSnapshot carries
-- `source: 'recorded' | 'reported'` precisely so a self-reported claim cannot
-- be laundered as a machine reading — "41°F, light rain (recorded)" is a
-- different claim from "overcast (reported)". A start time gets the same
-- treatment, so a report can say a duration was device-timed and an adjuster
-- can weigh that themselves. That is strictly more honest than today, where
-- every duration looks equally authoritative.

ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS started_at_source text NOT NULL DEFAULT 'server',
  ADD COLUMN IF NOT EXISTS device_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS device_clock_offset_seconds integer;

ALTER TABLE inspections
  DROP CONSTRAINT IF EXISTS inspections_started_at_source_valid;
ALTER TABLE inspections
  ADD CONSTRAINT inspections_started_at_source_valid
    CHECK (started_at_source IN ('server', 'device'));

-- A device-timed start must carry the evidence that makes it readable: what the
-- device claimed, and the skew measured against the server at sync. Without
-- both, 'device' is an unfalsifiable label rather than a provenance record —
-- and a report showing "device-timed" with nothing behind it is worse than one
-- that says nothing, because it implies a check that never happened.
ALTER TABLE inspections
  DROP CONSTRAINT IF EXISTS inspections_device_start_has_evidence;
ALTER TABLE inspections
  ADD CONSTRAINT inspections_device_start_has_evidence
    CHECK (
      started_at_source <> 'device'
      OR (device_started_at IS NOT NULL AND device_clock_offset_seconds IS NOT NULL)
    );

COMMENT ON COLUMN inspections.started_at_source IS
  'Whether started_at came from the server clock (started online) or from a device clock corrected by the skew measured at sync (started offline).';
COMMENT ON COLUMN inspections.device_started_at IS
  'The raw time the device claimed, uncorrected. Kept so a report can show the correction rather than only its result.';
COMMENT ON COLUMN inspections.device_clock_offset_seconds IS
  'server_now - device_now, measured in the same request that carried the start. started_at = device_started_at + this.';
