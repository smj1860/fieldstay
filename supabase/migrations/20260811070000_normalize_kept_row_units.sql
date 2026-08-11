-- Finish the unit-vocabulary migration that 20260811060000 started.
--
-- The seed sheet rewrote the catalog's unit vocabulary: 'count' became 'each'
-- and the 'bags'/'boxes'/'pairs' units were collapsed into 'packs'. That
-- applied to the 114 rows the sheet covers and the 19 it adds, but the 19 KEPT
-- rows only had their default_par_level set, so they were left speaking the old
-- vocabulary — 9 rows still on 'count' and 2 ('Matches', 'Tea Bags') on 'boxes'.
--
-- A catalog with two unit vocabularies is a UI problem, not a data one: the
-- par-levels grid and the PO builder render whatever string is stored, so a PM
-- would see "4 each" next to "2 count" for no reason they could discern.
--
-- Written as a value mapping rather than a name list so it stays correct on
-- both projects. The E2E project's catalog holds 31 fewer rows than production
-- (a divergence that predates this work — E2E was never seeded with the same
-- set), so a name-keyed statement would silently cover a different population
-- on each. Idempotent: re-running matches nothing.

UPDATE public.inventory_catalog SET default_unit = 'each'  WHERE default_unit = 'count';
UPDATE public.inventory_catalog SET default_unit = 'packs' WHERE default_unit IN ('boxes', 'bags', 'pairs');
