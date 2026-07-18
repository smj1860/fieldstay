-- Seeds the 14 standard room-turnover templates (see FUTURE_ADDITIONS.md #2)
-- into room_templates / room_template_items for the org that
-- sjones@lakemartindelivery.com belongs to. "Whole Home" is flagged
-- auto_include = true so it's seeded onto every property's checklist
-- automatically instead of via the PM's opt-in quantity picker.
--
-- Idempotent: re-running this file is a no-op if the org already has a room
-- template with a matching name (ON CONFLICT-free, since name isn't unique —
-- guarded instead with a NOT EXISTS check per room).

do $$
declare
  v_org_id uuid;
  v_room_id uuid;
begin
  select om.org_id into v_org_id
  from public.organization_members om
  join auth.users u on u.id = om.user_id
  where u.email = 'sjones@lakemartindelivery.com'
    and om.invite_accepted_at is not null
  limit 1;

  if v_org_id is null then
    raise exception 'No accepted organization_members row found for sjones@lakemartindelivery.com';
  end if;

  -- 1. Bedroom
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Bedroom') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Bedroom') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Strip Linens: Remove all sheets, pillowcases, and mattress protectors. Inspect for hairs, stains, or tears before placing them in the laundry.', 0),
      (v_room_id, 'Inspect Bedding: Check duvet covers, quilts, and bed skirts for marks. Launder or spot-clean as necessary.', 1),
      (v_room_id, 'Lighting & Air: Check that all lamps turn on (replace dead bulbs). Ensure ceiling fan blades are dust-free.', 2),
      (v_room_id, 'Dust & Wipe Down: Dust all flat surfaces, including nightstands, dressers, headboards, and window sills. Wipe down baseboards if dust has gathered.', 3),
      (v_room_id, 'Electronics Staging: Wipe down TV screens and disinfect the remote control. Turn on the TV to verify it boots up and resets cleanly to the default screen.', 4),
      (v_room_id, 'Closet & Drawers: Check all drawers, shelves, and closet floors for items left behind by previous occupants. Ensure standard hangers are neatly aligned.', 5),
      (v_room_id, 'Rebuild Bed: Remake the bed tightly with fresh linens. Tuck corners cleanly and fluff/arrange all pillows neatly.', 6),
      (v_room_id, 'Under-Bed Sweep: Vacuum or sweep thoroughly underneath the entire bed frame to catch hidden dust or stray trash.', 7),
      (v_room_id, 'Floor Exit Pass: Complete the vacuuming/sweeping from the furthest corner of the room, finishing wipe-down of baseboards if dust has gathered, working backward out the door.', 8);
  end if;

  -- 2. Bathroom
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Bathroom') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Bathroom') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Strip Used Towels: Collect all dirty towels, bath mats, and washcloths and move them to the laundry pile.', 0),
      (v_room_id, 'Dust Exhaust Fan: Wipe off or dust off the exhaust fan.', 1),
      (v_room_id, 'Apply Cleaners (Dwell Time): Spray down the toilet bowl, shower walls, tub basin, and sink with appropriate cleaners to let them sit while cleaning other elements.', 2),
      (v_room_id, 'Vanity Mirror: Clean mirror with glass cleaner and wipe down upper wall light fixtures.', 3),
      (v_room_id, 'Shower & Tub: Scrub wall tiles, grout lines, and tub basin. Remove hair from the drain grate. Polish chrome fixtures to a streak-free shine. Check shower head for mineral build-up.', 4),
      (v_room_id, 'Vanity & Sink: Scrub sink basin, clean mirror with glass cleaner, and wipe the countertop. Check the interior vanity cabinet for debris or leaks.', 5),
      (v_room_id, 'Toilet Sanitization: Clean bowl interior with a brush. Sanitize the exterior handle, seat, lid, base, and the wall/floor directly behind it. Flush to verify working properly.', 6),
      (v_room_id, 'Towel Reset: Hang a clean, matching set of bath towels, hand towels, and washcloths. Place a fresh bath mat on the floor.', 7),
      (v_room_id, 'Restock Essentials: Replenish toilet paper (with a folded neat edge), hand soap, body wash, shampoo, and conditioner.', 8),
      (v_room_id, 'Floor Care & Exit: Shake out and place a fresh bath mat on the floor. Sweep and mop the bathroom floor from the back corner out to the threshold.', 9);
  end if;

  -- 3. Kitchen
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Kitchen') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Kitchen') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Clear & Extract: Clear out all leftover food from the fridge and freezer. Empty out the dishwasher (clear the bottom filter mesh). Pull all trash.', 0),
      (v_room_id, 'Upper Cabinets & Lighting: Wipe down exterior upper cabinet fronts. Check inside top shelves for dust or forgotten items.', 1),
      (v_room_id, 'Oven & Stove Interior: Check for burnt residue and debris. Clean stovetop elements, control knobs, and drip pans.', 2),
      (v_room_id, 'Countertops & Backsplash: Sanitize all surfaces; move small appliances to clean thoroughly underneath.', 3),
      (v_room_id, 'Coffee Maker: Clean the exterior, moving it to get any spilled grounds or coffee clean. Empty and clean out the drip tray. Clean out the basket or pod holder; if traditional maker, put a clean new filter in the basket and leave open. Empty water reservoir, clean it, and refill with fresh water.', 4),
      (v_room_id, 'Fridge & Freezer Interior: Wipe down interior shelves, drawers, and rubber door seals (gaskets) ensuring none are damaged. Verify temperature settings are correct.', 5),
      (v_room_id, 'Lower Cabinets & Appliances Exterior: Wipe down lower cabinet fronts. Wipe down the microwave, oven, fridge, and dishwasher front face to ensure they are completely streak-free.', 6),
      (v_room_id, 'Sink & Disposal: Clean and sanitize the basin, then polish the hardware. Run the disposal to ensure it clears smoothly.', 7),
      (v_room_id, 'Inventory & Restock: Verify a full, matching set of dishes and utensils. Replenish the sponge, dish soap, dishwasher pods, and paper towels.', 8),
      (v_room_id, 'Deep Floor Mopping: Sweep and thoroughly mop the entire floor area, working from the farthest corner outward toward the main living area.', 9);
  end if;

  -- 4. Laundry Room
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Laundry Room') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Laundry Room') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Machine Mechanical Check: Pull out the dryer lint screen and clean it completely. Wipe down the interior dryer drum. Check the rubber door boot on front-load washers for standing water or mold; wipe dry.', 0),
      (v_room_id, 'Washer & Dryer Exterior: Wipe down the control panels, doors, and tops of both machines. Clear away detergent drips or lint buildup.', 1),
      (v_room_id, 'Cabinets & Shelving: Wipe down surfaces where laundry detergents are kept. Ensure items are neatly organized.', 2),
      (v_room_id, 'Floor Care & Exit: Sweep and mop behind and around the machines where lint and detergent dust accumulate heavily, exiting the room. Leave the washer door cracked open to prevent odors.', 3);
  end if;

  -- 5. Common Spaces
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Common Spaces') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Common Spaces') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'High Dusting: Clean ceiling fan blades, high corners, and upper window casings. Dust picture frames and wall art as needed.', 0),
      (v_room_id, 'Window & Glass Polish: Use streak-free glass cleaner on all interior windows, glass tabletop inserts, and large wall mirrors. Dust picture frames as needed.', 1),
      (v_room_id, 'Surface Sanitization & High-Touch: Dust and wipe down coffee tables, end tables, TV consoles, bookshelves, and decorative items. Sanitize all light switches, doorknobs, cabinet pulls, and media remotes with disinfectant wipes.', 2),
      (v_room_id, 'Furniture Upholstery: Vacuum couch cushions, armchairs, and accent chairs. Flip and rotate cushions, checking deep down in the crevices for crumbs or lost belongings.', 3),
      (v_room_id, 'Specific Space Detailing: If Play Room, wipe down and sanitize any provided toys or games and organize them neatly back into storage bins. If Sun Room, check indoor plant pots for dropped leaves and wipe down lightweight wicker or casual furniture.', 4),
      (v_room_id, 'Staging & Ambiance: Plump throw pillows and fold accent blankets neatly. Reset the thermostat to the property''s standard vacant/turnover temperature.', 5),
      (v_room_id, 'Rug & Floor Care: Move lightweight furniture to vacuum or mop underneath. Clean edge-to-edge, ensuring no debris is left behind doors or in corners. Check baseboards—dust as needed.', 6);
  end if;

  -- 6. Dining Room
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Dining Room') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Dining Room') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Light Fixture Dusting: Dust the dining room chandelier or pendant lights hanging over the table (ensuring no cobwebs or dead bugs are left in the glass fixtures).', 0),
      (v_room_id, 'Table Deep Clean & Polish: Wipe down the entire table surface. If it''s hardwood, use a wood-safe cleaner/polish; if it''s glass, ensure it is completely streak-free. Check table edges and underneath the rim for sticky residue.', 1),
      (v_room_id, 'Chair Inspection & Wipe Down: Wipe down all chair frames, including the legs and backrests. If chairs are upholstered, vacuum the seats or check for food stains that need spot-cleaning.', 2),
      (v_room_id, 'Staging: Center any decor, table runners, or centerpieces exactly in the middle of the table. Ensure all chairs are pushed in symmetrically.', 3),
      (v_room_id, 'Rug & Floor Care: Vacuum or sweep thoroughly underneath the dining table. Pay special attention to crumb buildup where the chairs sit. If the floor is hardwood/tile, mop edge-to-edge.', 4);
  end if;

  -- 7. Breakfast Room
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Breakfast Room') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Breakfast Room') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Window Sill & Blind Dusting: Dust the sills and wipe away any splatters or dust from nearby windows or blinds.', 0),
      (v_room_id, 'Sanitize Casual Table: Wash and sanitize the table surface, checking thoroughly for syrup, coffee rings, or dried food spills. Wipe down the table pedestal or legs.', 1),
      (v_room_id, 'High-Traffic Chair/Stool Clean: Sanitize casual dining chairs or barstools. Because these get heavy daily use, check the seat lips and base for sticky handprints.', 2),
      (v_room_id, 'Trash & Restock: If the nook has a small secondary trash bin, empty it. Ensure any daily-use items (like a napkin holder or salt/pepper shakers) are wiped clean and fully stocked.', 3),
      (v_room_id, 'Under-Table Floor Mop: Sweep and thoroughly mop the entire floor area, moving chairs out of the way to catch everything.', 4);
  end if;

  -- 8. Office
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Office') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Office') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Tech & Window Sills: Dust high shelves and window sills. Gently wipe down computer monitor screens with a microfiber cloth.', 0),
      (v_room_id, 'Desk Surface: Thoroughly clean and sanitize the desktop. Remove any coffee ring stains, dust, or scuffs.', 1),
      (v_room_id, 'Peripheral & Chair Sanitize: Sanitize external keyboards, mice, and desk mats. Wipe down the office chair (including armrests and adjustment levers).', 2),
      (v_room_id, 'Cable Management & Audit: Neatly coil or organize charging cables, power strips, and monitor cords so they are not tangled on or under the desk. Check desk organizers or drawers. Throw away dried-up pens, clear out random scraps of paper, and ensure a pad of paper and working pen are neatly staged.', 3),
      (v_room_id, 'Trash/Shredder: Empty the office wastebasket. Check if a paper shredder was used and empty its bin if necessary.', 4),
      (v_room_id, 'Floor Exit Reset: Ensure the chair rolls smoothly and is tucked neatly under the desk. Vacuum or sweep the room from the desk corner out through the entryway.', 5);
  end if;

  -- 9. Screen Porch
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Screen Porch') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Screen Porch') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Structural Overhead Dusting: Dust the outdoor ceiling fan blades and light fixtures (remove cobwebs and bugs). Check all screen panels for rips, tears, or detachment from the frame. Wipe dust or heavy pollen off screen frames.', 0),
      (v_room_id, 'Outdoor Furniture Wipe Down: Wipe down all patio chairs, tables, and outdoor cushions. Shake out or vacuum outdoor cushions if dusty.', 1),
      (v_room_id, 'Floor Sweep Exit: Thoroughly sweep pollen, dirt, and dried leaves off the floor, focusing on corners and door tracks.', 2);
  end if;

  -- 10. Patio / Deck
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Patio / Deck') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Patio / Deck') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Safety & Overhead Check: Check for any loose deck boards, protruding nails, or railings that require maintenance attention. Clear away overhead cobwebs near house siding eaves.', 0),
      (v_room_id, 'Grill / Cooking Station: Inspect the grill. Clean the grates, empty the grease trap, wipe the exterior handles, and verify the propane tank level.', 1),
      (v_room_id, 'Furniture Reset: Clean outdoor dining tables and arrange patio seating neatly. Close and secure outdoor umbrellas.', 2),
      (v_room_id, 'Blowing / Sweeping: Use a leaf blower or large broom to clear the entire surface of leaves, twigs, dirt, and debris.', 3);
  end if;

  -- 11. Pool
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Pool') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Pool') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Debris Skimming: Skim the water surface with a net to remove leaves, bugs, and floating debris.', 0),
      (v_room_id, 'Equipment & Clarity Audit: Check pool equipment is functioning properly. Visually check that water is clear (not cloudy or green) and report any filtration or chemistry imbalances immediately.', 1),
      (v_room_id, 'Safety Equipment Check: Verify that life rings, safety hooks, and pool gates are functioning, secure, and properly staged.', 2),
      (v_room_id, 'Pool Perimeter & Staging: Hose down or sweep the pool coping and immediate concrete/deck surrounding area. Straighten pool loungers.', 3);
  end if;

  -- 12. Pool House
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Pool House') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Pool House') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Kitchenette/Bar & Bathroom Extraction: Pull any trash from the pool house spaces. Complete full bathroom standard protocol (scrub toilet, sink, shower, and restock pool towels). Clear out the mini-fridge, wipe down the bar counter, and clean the bar sink basin. Replenish plastic cups or outdoor drinkware.', 0),
      (v_room_id, 'High Surface Dusting: Dust high ledges, window sills, and surface fixtures.', 1),
      (v_room_id, 'Main Living Area Staging: Wipe down casual furniture and surfaces.', 2),
      (v_room_id, 'Floor Clearance Out: Vacuum/mop floors to remove water tracks or tracked-in dirt/sand, washing your way out the exit threshold.', 3);
  end if;

  -- 13. Garage
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Garage') then
    insert into public.room_templates (org_id, name) values (v_org_id, 'Garage') returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Overhead Tracks: Blow away cobwebs, leaves, and bugs around the garage door tracks and high corners.', 0),
      (v_room_id, 'Remotes & Access: Ensure garage door openers or wall keypads are wiped clean and operational.', 1),
      (v_room_id, 'Trash & Recycling Hub: Empty all internal house trash into the large rolling bins. Ensure bins are lined and ready for pickup (or pulled to the curb).', 2),
      (v_room_id, 'Floor Clearance: Sweep out main walking paths, blowing away cobwebs, leaves, and bugs around the garage door tracks.', 3);
  end if;

  -- 14. Whole Home — auto_include = true, applied to every property automatically.
  if not exists (select 1 from public.room_templates where org_id = v_org_id and name = 'Whole Home') then
    insert into public.room_templates (org_id, name, auto_include) values (v_org_id, 'Whole Home', true) returning id into v_room_id;
    insert into public.room_template_items (room_template_id, task, sort_order) values
      (v_room_id, 'Initial Damage & Security Walkthrough: Walk the entire interior perimeter and check walls, doors, and trim for any new holes, deep scuffs, or structural damage. Check that all windows are closed, locked, and that glass panes are intact. Verify that smoke detectors and carbon monoxide alarms are intact and not chirping.', 0),
      (v_room_id, 'Tech & Climate Systems: Check the router/modem. Verify that the internet is online and the Wi-Fi network is actively broadcasting. Set the main HVAC thermostat to the property''s standard vacant/staged temperature setting and verify the system is running. Verify that electronic door locks have sufficient battery power.', 1),
      (v_room_id, 'Lighting & Electrical Audit: Turn on every single lamp, overhead light, and exterior fixture on the property to verify all bulbs are working. Replace any dead bulbs immediately. Ensure small counter appliances are plugged in and staged neatly.', 2),
      (v_room_id, 'Surface & Deep Dusting: Check and dust as needed the tops of all picture frames, wall art, and mirrors throughout the home. Walk the property and dust/wipe down baseboards as needed. Look up and check/vacuum HVAC return vent grates if dust buildup is visible.', 3),
      (v_room_id, 'Final Staging & Lockup: Verify the home smells fresh and clean. Set all window blinds and curtains to the property''s standard staging position. Turn off all non-staging lights, lock the back/side doors, and ensure the front smart lock engages perfectly as you exit.', 4);
  end if;
end $$;
