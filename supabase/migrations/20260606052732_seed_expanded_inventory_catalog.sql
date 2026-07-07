
-- Paper Goods (fill gaps)
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Paper Plates',            'paper_goods', 'count',   'Disposable plates for outdoor/pool use', true),
  ('Paper Cups',              'paper_goods', 'count',   'Disposable cups', true),
  ('Disposable Cutlery Set',  'paper_goods', 'count',   'Plastic forks, knives, spoons', true),
  ('Cocktail Napkins',        'paper_goods', 'count',   'Small napkins for drinks/snacks', true)
ON CONFLICT DO NOTHING;

-- Cleaning Supplies (fill gaps)
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Toilet Bowl Cleaner',      'cleaning', 'bottles', 'Separate from general bathroom cleaner', true),
  ('Toilet Brush',             'cleaning', 'count',   'Replace when worn', true),
  ('Disinfecting Wipes',       'cleaning', 'count',   'For quick surface wipe-downs', true),
  ('Microfiber Cloths',        'cleaning', 'count',   'Reusable cleaning cloths', true),
  ('Rubber Gloves',            'cleaning', 'pairs',   'Cleaning gloves', true),
  ('Air Freshener Spray',      'cleaning', 'bottles', 'Odor eliminator for turnovers', true),
  ('Drain Unclogger',          'cleaning', 'bottles', 'Drano or equivalent', true),
  ('Furniture Polish',         'cleaning', 'bottles', 'For wood surfaces', true),
  ('Stainless Steel Cleaner',  'cleaning', 'bottles', 'For appliance exteriors', true),
  ('Floor Cleaner Solution',   'cleaning', 'bottles', 'Mopping solution', true),
  ('Broom and Dustpan',        'cleaning', 'count',   'Replace when worn', true),
  ('Vacuum Bags or Filters',   'cleaning', 'count',   'Note vacuum model per property', true),
  ('Grout Cleaner',            'cleaning', 'bottles', 'For tile grout maintenance', true),
  ('Mildew Remover',           'cleaning', 'bottles', 'For bathroom and outdoor mildew', true)
ON CONFLICT DO NOTHING;

-- Kitchen & Pantry (fill gaps)
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Tea Bags',                 'kitchen', 'boxes',   'Assorted tea selection', true),
  ('Coffee Creamer',           'kitchen', 'count',   'Individual creamers or small bottles', true),
  ('Sweetener Packets',        'kitchen', 'boxes',   'Sugar, Splenda, Stevia assortment', true),
  ('Hot Cocoa Packets',        'kitchen', 'boxes',   'Seasonal guest touch', true),
  ('Dish Cloths and Towels',   'kitchen', 'count',   'Kitchen hand towels', true),
  ('Parchment Paper',          'kitchen', 'rolls',   'For baking', true),
  ('Matches',                  'kitchen', 'boxes',   'For candles and grill lighting', true),
  ('Bottle Opener and Corkscrew','kitchen','count',  'Replace when missing', true),
  ('Toothpicks',               'kitchen', 'boxes',   'Small touch, frequently gone', true)
ON CONFLICT DO NOTHING;

-- Bath & Personal Care (fill gaps)
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Feminine Hygiene Products','bath', 'count',   'Tampons and pads mixed pack', true),
  ('Disposable Razors',        'bath', 'count',   'Single-use for guests', true),
  ('Toothbrush and Paste Kit', 'bath', 'count',   'Travel-size starter kit', true),
  ('Mouthwash',                'bath', 'bottles', 'Travel size', true),
  ('Dental Floss',             'bath', 'count',   'Travel size', true),
  ('Makeup Remover Wipes',     'bath', 'count',   'Individual packets', true),
  ('Bath Salts or Epsom Salt', 'bath', 'bags',    'For properties with tubs or hot tubs', true),
  ('Night Light',              'bath', 'count',   'Plug-in for hallway or bathroom', true)
ON CONFLICT DO NOTHING;

-- Laundry (fill gaps)
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Dryer Vent Brush',         'laundry', 'count', 'Lint trap deep clean tool', true),
  ('Washer Cleaning Tablets',  'laundry', 'count', 'Monthly drum cleaning', true),
  ('Mesh Laundry Bags',        'laundry', 'count', 'For delicate items', true)
ON CONFLICT DO NOTHING;

-- Outdoor (fill gaps)
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Pool Towels',              'outdoor', 'count', 'For properties with pool', true),
  ('Citronella Candles',       'outdoor', 'count', 'Mosquito deterrent for patio', true),
  ('Firewood Bundle',          'outdoor', 'count', 'For properties with fireplace or fire pit', true),
  ('Fire Starters',            'outdoor', 'count', 'Fatwood or wax fire starters', true),
  ('Pool Shock and Chemicals', 'outdoor', 'count', 'For properties with pool', true),
  ('Grill Brush',              'outdoor', 'count', 'Replace when worn', true),
  ('Patio String Light Bulbs', 'outdoor', 'count', 'Replacement bulbs for outdoor lighting', true)
ON CONFLICT DO NOTHING;

-- NEW: Bedroom & Linens
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Extra Pillow Cases',       'bedroom_linens', 'count', 'Par: 4 per bedroom', true),
  ('Extra Sheet Set',          'bedroom_linens', 'count', 'Full spare set per bed size', true),
  ('Mattress Protector',       'bedroom_linens', 'count', 'Waterproof — one per mattress', true),
  ('Pillow Protectors',        'bedroom_linens', 'count', 'Under pillow cases', true),
  ('Extra Throw Blanket',      'bedroom_linens', 'count', 'Decorative and guest use', true),
  ('Spare Pillows',            'bedroom_linens', 'count', 'Extra pillows stored in closet', true)
ON CONFLICT DO NOTHING;

-- NEW: Maintenance & Safety
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Light Bulbs LED A19',      'maintenance_safety', 'count', 'Standard base — most common', true),
  ('Light Bulbs LED BR30',     'maintenance_safety', 'count', 'Recessed and flood bulbs', true),
  ('Smart Bulbs',              'maintenance_safety', 'count', 'For smart lighting properties', true),
  ('Batteries AA',             'maintenance_safety', 'count', 'For remotes and devices', true),
  ('Batteries AAA',            'maintenance_safety', 'count', 'For remotes and devices', true),
  ('Batteries 9V',             'maintenance_safety', 'count', 'For smoke and CO detectors', true),
  ('First Aid Kit',            'maintenance_safety', 'count', 'Fully stocked — inspect monthly', true),
  ('Band-Aids Assorted',       'maintenance_safety', 'count', 'Restock first aid kit', true),
  ('Pain Reliever Packets',    'maintenance_safety', 'count', 'Ibuprofen and acetaminophen', true),
  ('Duct Tape',                'maintenance_safety', 'count', 'For quick repairs', true),
  ('Surge Protector Strip',    'maintenance_safety', 'count', 'Desk or nightstand power', true),
  ('Command Strips and Hooks', 'maintenance_safety', 'count', 'Damage-free wall hanging', true)
ON CONFLICT DO NOTHING;

-- NEW: Guest Experience
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('Welcome Cards',            'guest_experience', 'count', 'Handwritten or printed welcome note', true),
  ('Bottled Water',            'guest_experience', 'count', 'Welcome fridge stock', true),
  ('Local Snack Assortment',   'guest_experience', 'count', 'Regional snack basket', true),
  ('Coffee Welcome Kit',       'guest_experience', 'count', 'Curated coffee and tea welcome set', true),
  ('Guest Book',               'guest_experience', 'count', 'Replace when full', true),
  ('Local Maps and Brochures', 'guest_experience', 'count', 'Area attraction guides', true),
  ('Chocolates or Mints',      'guest_experience', 'count', 'Pillow mints or welcome chocolate', true),
  ('Decorative Candles',       'guest_experience', 'count', 'Unscented or light scent', true)
ON CONFLICT DO NOTHING;

-- NEW: Technology & Connectivity
INSERT INTO inventory_catalog (name, category, default_unit, description, is_active) VALUES
  ('HDMI Cable',               'technology', 'count', 'Spare for TV connectivity', true),
  ('USB-C Charging Cable',     'technology', 'count', 'Most common cable guests need', true),
  ('Lightning Cable',          'technology', 'count', 'For Apple device guests', true),
  ('USB-A Charging Cable',     'technology', 'count', 'Universal spare', true),
  ('Power Strip',              'technology', 'count', 'Surge-protected power strip', true)
ON CONFLICT DO NOTHING;
