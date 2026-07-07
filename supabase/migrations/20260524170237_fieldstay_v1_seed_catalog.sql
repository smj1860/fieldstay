
INSERT INTO inventory_catalog (name, category, default_unit, description) VALUES
  -- Paper Goods
  ('Toilet Paper',          'paper_goods', 'rolls',   'Standard toilet paper rolls'),
  ('Paper Towels',          'paper_goods', 'rolls',   'Paper towel rolls'),
  ('Facial Tissues',        'paper_goods', 'boxes',   'Tissue boxes'),
  ('Napkins',               'paper_goods', 'packs',   'Paper napkins'),
  -- Cleaning
  ('Dish Soap',             'cleaning',    'bottles', 'Dish washing liquid'),
  ('Dishwasher Pods',       'cleaning',    'count',   'Dishwasher detergent pods'),
  ('Laundry Detergent',     'cleaning',    'bottles', 'Laundry detergent'),
  ('All-Purpose Cleaner',   'cleaning',    'bottles', 'All-purpose spray cleaner'),
  ('Bathroom Cleaner',      'cleaning',    'bottles', 'Toilet and bathroom cleaner'),
  ('Glass Cleaner',         'cleaning',    'bottles', 'Window and glass cleaner'),
  ('Trash Bags - Kitchen',  'cleaning',    'count',   'Standard kitchen trash bags'),
  ('Trash Bags - Large',    'cleaning',    'count',   'Large outdoor/bin trash bags'),
  ('Sponges',               'cleaning',    'count',   'Kitchen sponges'),
  ('Scrub Brushes',         'cleaning',    'count',   'Scrub brushes'),
  ('Mop Heads',             'cleaning',    'count',   'Replacement mop heads'),
  -- Kitchen
  ('Coffee',                'kitchen',     'bags',    'Ground or whole bean coffee'),
  ('Coffee Filters',        'kitchen',     'count',   'Paper coffee filters'),
  ('Sugar',                 'kitchen',     'bags',    'Granulated sugar or packets'),
  ('Salt',                  'kitchen',     'count',   'Salt shakers or packets'),
  ('Pepper',                'kitchen',     'count',   'Pepper shakers or packets'),
  ('Cooking Oil',           'kitchen',     'bottles', 'Cooking/vegetable oil'),
  ('Aluminum Foil',         'kitchen',     'rolls',   'Aluminum foil rolls'),
  ('Plastic Wrap',          'kitchen',     'rolls',   'Plastic cling wrap'),
  ('Zip Lock Bags',         'kitchen',     'boxes',   'Resealable storage bags'),
  -- Bath
  ('Hand Soap',             'bath',        'bottles', 'Bar or liquid hand soap'),
  ('Shampoo',               'bath',        'bottles', 'Shampoo bottles'),
  ('Conditioner',           'bath',        'bottles', 'Hair conditioner'),
  ('Body Wash',             'bath',        'bottles', 'Body wash or shower gel'),
  ('Lotion',                'bath',        'bottles', 'Body lotion'),
  ('Shower Caps',           'bath',        'count',   'Disposable shower caps'),
  ('Cotton Balls / Swabs',  'bath',        'bags',    'Cotton balls or Q-tips'),
  -- Laundry
  ('Dryer Sheets',          'laundry',     'boxes',   'Dryer sheets'),
  ('Fabric Softener',       'laundry',     'bottles', 'Liquid fabric softener'),
  ('Stain Remover',         'laundry',     'bottles', 'Spray stain remover'),
  -- Outdoor
  ('Bug Spray',             'outdoor',     'bottles', 'Insect repellent'),
  ('Sunscreen',             'outdoor',     'bottles', 'Sunscreen SPF 30+'),
  ('Charcoal',              'outdoor',     'bags',    'Grill charcoal'),
  ('Lighter Fluid',         'outdoor',     'bottles', 'Grill lighter fluid'),
  ('Propane Tank',          'outdoor',     'count',   'Propane tank for gas grill');
