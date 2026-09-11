-- Spanish translations for turnover checklist tasks/sections and inventory
-- item names, per the crew app's Spanish-language support. Each `_es` column
-- is nullable text: an org (or the platform, for the seed catalog) may not
-- have entered a translation yet, in which case display falls back to the
-- English column — see lib/crew/content-locale.ts.
--
-- Nothing here is NOT NULL — a missing translation must never block a write
-- to the English side of these tables.

-- ── Checklist: room templates → template items → instance items ────────────

ALTER TABLE public.room_template_items
  ADD COLUMN IF NOT EXISTS task_es text;

ALTER TABLE public.checklist_template_sections
  ADD COLUMN IF NOT EXISTS name_es text;

ALTER TABLE public.checklist_template_items
  ADD COLUMN IF NOT EXISTS task_es text;

ALTER TABLE public.checklist_instance_items
  ADD COLUMN IF NOT EXISTS task_es text,
  ADD COLUMN IF NOT EXISTS section_name_es text;

COMMENT ON COLUMN public.room_template_items.task_es IS
  'PM-entered Spanish translation of task. Optional — falls back to task when null.';
COMMENT ON COLUMN public.checklist_template_sections.name_es IS
  'PM-entered Spanish translation of name. Optional — falls back to name when null.';
COMMENT ON COLUMN public.checklist_template_items.task_es IS
  'Copied from room_template_items.task_es via apply-master-template.ts. Optional — falls back to task when null.';
COMMENT ON COLUMN public.checklist_instance_items.task_es IS
  'Snapshot of checklist_template_items.task_es at turnover-creation time. Optional — falls back to task when null.';
COMMENT ON COLUMN public.checklist_instance_items.section_name_es IS
  'Snapshot of checklist_template_sections.name_es at turnover-creation time. Optional — falls back to section_name when null.';

-- ── Inventory: platform/org catalog → templates → property items ───────────

ALTER TABLE public.inventory_catalog
  ADD COLUMN IF NOT EXISTS name_es text;

ALTER TABLE public.org_inventory_catalog
  ADD COLUMN IF NOT EXISTS name_es text;

ALTER TABLE public.inventory_template_items
  ADD COLUMN IF NOT EXISTS name_es text;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS name_es text;

COMMENT ON COLUMN public.inventory_catalog.name_es IS
  'Platform-maintained Spanish translation of name, seeded for the full 115+ item catalog. Optional — falls back to name when null.';
COMMENT ON COLUMN public.org_inventory_catalog.name_es IS
  'Copied from inventory_catalog.name_es when an org''s catalog is first seeded, then independently PM-editable. Optional — falls back to name when null.';
COMMENT ON COLUMN public.inventory_template_items.name_es IS
  'Copied from org_inventory_catalog.name_es via templates/inventory/actions.ts. Optional — falls back to name when null.';
COMMENT ON COLUMN public.inventory_items.name_es IS
  'Copied from the source template/catalog item via lib/inventory/apply-standard-to-property.ts. Optional — falls back to name when null.';

-- ── Seed Spanish names for the global platform inventory catalog ───────────
-- Matched on `name` (unique per catalog item) rather than hardcoded ids, so
-- this stays reviewable as plain text pairs.

UPDATE public.inventory_catalog AS c SET name_es = v.name_es
FROM (VALUES
  ('Cocktail Napkins',              'Servilletas de cóctel'),
  ('Disposable Cutlery Set',        'Juego de cubiertos desechables'),
  ('Facial Tissues',                'Pañuelos faciales'),
  ('Napkins',                       'Servilletas'),
  ('Paper Cups',                    'Vasos de papel'),
  ('Paper Plates',                  'Platos de papel'),
  ('Paper Towels',                  'Toallas de papel'),
  ('Toilet Paper',                  'Papel higiénico'),

  ('All-Purpose Cleaner',           'Limpiador multiusos'),
  ('Bathroom Cleaner',              'Limpiador de baño'),
  ('Broom and Dustpan',             'Escoba y recogedor'),
  ('Dish Soap',                     'Jabón para platos'),
  ('Dishwasher Pods',               'Cápsulas para lavavajillas'),
  ('Disinfecting Wipes',            'Toallitas desinfectantes'),
  ('Floor Cleaner Solution',        'Solución limpiadora de pisos'),
  ('Furniture Polish',              'Abrillantador de muebles'),
  ('Glass Cleaner',                 'Limpiador de vidrios'),
  ('Grout Cleaner',                 'Limpiador de lechada'),
  ('Microfiber Cloths',             'Paños de microfibra'),
  ('Mildew Remover',                'Removedor de moho'),
  ('Rubber Gloves',                 'Guantes de goma'),
  ('Scrub Brushes',                 'Cepillos de fregar'),
  ('Sponges',                       'Esponjas'),
  ('Swiffer Mop',                   'Trapeador Swiffer'),
  ('Swiffer Refills',               'Repuestos para Swiffer'),
  ('Toilet Bowl Cleaner',           'Limpiador de inodoro'),
  ('Toilet Brush & Caddy',          'Cepillo de inodoro y soporte'),
  ('Trash Bags - Kitchen',          'Bolsas de basura - Cocina'),
  ('Trash Bags - Large',            'Bolsas de basura - Grandes'),
  ('Trash Bags - Small',            'Bolsas de basura - Pequeñas'),
  ('Vacuum Bags or Filters',        'Bolsas o filtros para aspiradora'),

  ('Aluminum Foil',                 'Papel aluminio'),
  ('Baking Sheets & Pans',          'Bandejas y moldes para hornear'),
  ('Blender',                       'Licuadora'),
  ('Bottle Opener and Corkscrew',   'Abrebotellas y sacacorchos'),
  ('Can Opener',                    'Abrelatas'),
  ('Chef Knife Block',              'Bloque de cuchillos de chef'),
  ('Coffee',                        'Café'),
  ('Coffee Filters',                'Filtros de café'),
  ('Coffee K-Cup',                  'Cápsulas de café K-Cup'),
  ('Coffee Maker / Keurig',         'Cafetera / Keurig'),
  ('Cooking Oil',                   'Aceite de cocina'),
  ('Cooking Spoon',                 'Cuchara de cocina'),
  ('Cookware Set',                  'Juego de ollas y sartenes'),
  ('Creamer Cups',                  'Cápsulas de crema para café'),
  ('Cutting Boards',                'Tablas de cortar'),
  ('Dinnerware Set / Plates',       'Juego de vajilla / Platos'),
  ('Dish Cloths and Towels',        'Paños y toallas de cocina'),
  ('Drinking Glasses',              'Vasos para beber'),
  ('Flatware Set',                  'Juego de cubiertos'),
  ('Hot Cocoa Packets',             'Sobres de chocolate caliente'),
  ('Matches',                       'Fósforos'),
  ('Measuring Cup Set',             'Juego de tazas medidoras'),
  ('Measuring Spoon Set',           'Juego de cucharas medidoras'),
  ('Microwave',                     'Microondas'),
  ('Mixing Bowls',                  'Tazones para mezclar'),
  ('Outdoor Drinkware',             'Vasos para exteriores'),
  ('Oven Mitts',                    'Guantes de horno'),
  ('Pepper',                        'Pimienta'),
  ('Plastic Wrap',                  'Papel film'),
  ('Salt',                          'Sal'),
  ('Spatula',                       'Espátula'),
  ('Sugar Packets',                 'Sobres de azúcar'),
  ('Sweetener Packets',             'Sobres de edulcorante'),
  ('Tea Bags',                      'Bolsitas de té'),
  ('Toaster',                       'Tostadora'),
  ('Toothpicks',                    'Palillos de dientes'),
  ('Wine Glasses',                  'Copas de vino'),
  ('Wine Opener & Bottle Opener',   'Sacacorchos y abrebotellas'),

  ('3 in 1 shower dispenser',       'Dispensador de ducha 3 en 1'),
  ('Bath Mats',                     'Alfombras de baño'),
  ('Bath Towels',                   'Toallas de baño'),
  ('Body Wash Bulk',                'Jabón corporal a granel'),
  ('Conditioner Bulk',              'Acondicionador a granel'),
  ('Cotton Balls / Swabs',          'Bolitas de algodón / Hisopos'),
  ('Disposable Razor',              'Rastrillo desechable'),
  ('Hair Dryer',                    'Secador de pelo'),
  ('Hand Soap Bulk',                'Jabón de manos a granel'),
  ('hand soap dispenser',           'Dispensador de jabón de manos'),
  ('Hand Towels',                   'Toallas de manos'),
  ('Lotion',                        'Loción'),
  ('Makeup Remover Wipes',          'Toallitas desmaquillantes'),
  ('Makeup Towels',                 'Toallas para desmaquillar'),
  ('Night Light',                   'Luz nocturna'),
  ('Plunger Set',                   'Juego de destapador'),
  ('Shampoo Bulk',                  'Champú a granel'),
  ('Toothbrush and Toothpaste Kit', 'Kit de cepillo y pasta de dientes'),
  ('Washcloths',                    'Toallitas de baño'),

  ('Dryer Sheets',                  'Hojas suavizantes para secadora'),
  ('Dryer Vent Brush',              'Cepillo para ducto de secadora'),
  ('Fabric Softener',               'Suavizante de telas'),
  ('Garmet Steamer',                'Vaporizador de ropa'),
  ('Iron',                          'Plancha'),
  ('Ironing Board',                 'Tabla de planchar'),
  ('Laundry Detergent/Pods',        'Detergente / Cápsulas de lavandería'),
  ('Mesh Laundry Bags',             'Bolsas de malla para lavandería'),
  ('Stain Remover',                 'Quitamanchas'),
  ('Washer Cleaning Tablets',       'Tabletas limpiadoras para lavadora'),

  ('Beach Chairs',                  'Sillas de playa'),
  ('Beach Towels',                  'Toallas de playa'),
  ('Bug Spray',                     'Repelente de insectos'),
  ('Charcoal',                      'Carbón'),
  ('Citronella Candles',            'Velas de citronela'),
  ('Fire Pit Tool Set',             'Juego de herramientas para fogata'),
  ('Fire Starters',                 'Encendedores para fuego'),
  ('Firewood Bundle',               'Paquete de leña'),
  ('Grill Brush',                   'Cepillo para parrilla'),
  ('Hot Tub Test Kit & Strips',     'Kit y tiras de prueba para jacuzzi'),
  ('Lighter Fluid',                 'Líquido para encendedor'),
  ('Patio String Light Bulbs',      'Bombillas para luces de patio'),
  ('Pool Salt',                     'Sal para piscina'),
  ('Pool Shock and Chemicals',      'Choque y químicos para piscina'),
  ('Pool Towels',                   'Toallas de piscina'),
  ('Propane Tank',                  'Tanque de propano'),
  ('Snow Shovels',                  'Palas para nieve'),
  ('Sunscreen',                     'Protector solar'),
  ('Thermacell',                    'Thermacell (repelente de insectos)'),

  ('Coat Hangers',                  'Perchas'),
  ('Duvet Cover',                   'Funda nórdica'),
  ('Duvet Insert / Comforter',      'Relleno nórdico / Edredón'),
  ('Extra Pillow Cases',            'Fundas de almohada adicionales'),
  ('Extra Sheet Set',               'Juego de sábanas adicional'),
  ('Extra Throw Blanket',           'Manta adicional'),
  ('Luggage Racks',                 'Portamaletas'),
  ('Mattress Protector',            'Protector de colchón'),
  ('Pillow Protectors',             'Protectores de almohada'),
  ('Spare Pillows',                 'Almohadas de repuesto'),

  ('Batteries 9V',                  'Pilas 9V'),
  ('Batteries AA',                  'Pilas AA'),
  ('Batteries AAA',                 'Pilas AAA'),
  ('CO/CO2 Detectors',              'Detectores de CO/CO2'),
  ('Command Strips',                'Tiras adhesivas Command'),
  ('Duct Tape',                     'Cinta adhesiva americana'),
  ('Fire Extinguisher',             'Extintor de incendios'),
  ('First Aid Kit',                 'Botiquín de primeros auxilios'),
  ('Flashlight',                    'Linterna'),
  ('HVAC Air Filters',              'Filtros de aire para HVAC'),
  ('Recessed/Other Light Bulbs',    'Bombillas empotradas / Otras bombillas'),
  ('Replacement Light Bulbs',       'Bombillas de repuesto'),
  ('Screwdriver',                   'Destornillador'),
  ('Smart Bulbs',                   'Bombillas inteligentes'),
  ('Surge Protector Strip',         'Regleta protectora contra sobretensiones'),
  ('WD-40',                         'WD-40'),
  ('Wrench',                        'Llave inglesa'),

  ('Bottled Water',                 'Agua embotellada'),
  ('Chocolates or Mints',           'Chocolates o menta'),
  ('Coffee Welcome Pack',           'Paquete de bienvenida de café'),
  ('Guest Book',                    'Libro de huéspedes'),
  ('Local Maps and Event Guides',   'Mapas locales y guías de eventos'),
  ('Local Snack Assortment',        'Surtido de bocadillos locales'),
  ('Welcome Cards',                 'Tarjetas de bienvenida'),

  ('HDMI Cable',                    'Cable HDMI'),
  ('Lightning Cable',               'Cable Lightning'),
  ('Power Strip',                   'Regleta de enchufes'),
  ('Universal TV Remote',           'Control remoto universal para TV'),
  ('USB-A Charging Cable',          'Cable de carga USB-A'),
  ('USB-C Charging Cable',          'Cable de carga USB-C')
) AS v(name, name_es)
WHERE c.name = v.name;
