import { column, Schema, Table } from '@powersync/web'

const turnovers = new Table({
  property_id:       column.text,
  org_id:            column.text,
  checkout_datetime: column.text,
  checkin_datetime:  column.text,
  window_minutes:    column.integer,
  status:            column.text,
  priority:          column.text,
  notes:             column.text,
})

const checklist_instances = new Table({
  turnover_id: column.text,
  status:      column.text,
})

const checklist_instance_items = new Table({
  instance_id:        column.text,
  section_name:       column.text,
  task:               column.text,
  is_completed:       column.integer,
  requires_photo:     column.integer,
  photo_storage_path: column.text,
  crew_notes:         column.text,
  sort_order:         column.integer,
})

const inventory_items = new Table({
  property_id:      column.text,
  name:             column.text,
  category:         column.text,
  unit:             column.text,
  par_level:        column.integer,
  current_quantity: column.integer,
})

const properties = new Table({
  name:    column.text,
  address: column.text,
  city:    column.text,
  state:   column.text,
})

export const AppSchema = new Schema({
  turnovers,
  checklist_instances,
  checklist_instance_items,
  inventory_items,
  properties,
})
