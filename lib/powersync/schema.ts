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
  org_id:      column.text,
  status:      column.text,
})

const checklist_instance_items = new Table({
  instance_id:        column.text,
  section_name:       column.text,
  task:               column.text,
  is_completed:       column.integer,
  completed_at:       column.text,
  requires_photo:     column.integer,
  photo_storage_path: column.text,
  crew_notes:         column.text,
  sort_order:         column.integer,
})

const inventory_items = new Table({
  property_id:      column.text,
  org_id:           column.text,
  name:             column.text,
  category:         column.text,
  unit:             column.text,
  par_level:        column.integer,
  current_quantity: column.integer,
})

const properties = new Table({
  name:    column.text,
  org_id:  column.text,
  address: column.text,
  city:    column.text,
  state:   column.text,
})

const crew_availability = new Table({
  org_id:          column.text,
  crew_member_id:  column.text,
  available_date:  column.text,
  is_available:    column.integer,
  notes:           column.text,
})

const messages = new Table({
  org_id:       column.text,
  sender_id:    column.text,
  recipient_id: column.text,
  content:      column.text,
  read_at:      column.text,
  turnover_id:  column.text,
  created_at:   column.text,
})

export const AppSchema = new Schema({
  turnovers,
  checklist_instances,
  checklist_instance_items,
  inventory_items,
  properties,
  crew_availability,
  messages,
})
