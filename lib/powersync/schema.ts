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
  turnover_id:        column.text,
  org_id:             column.text,
  status:             column.text,
  section_photo_path: column.text,
})

const checklist_instance_items = new Table({
  instance_id:           column.text,
  turnover_id:           column.text,
  section_name:          column.text,
  task:                  column.text,
  is_completed:          column.integer,
  completed_at:          column.text,
  completed_by_crew_id:  column.text,
  requires_photo:        column.integer,
  photo_reason:          column.text,
  photo_storage_path:    column.text,
  crew_notes:            column.text,
  sort_order:            column.integer,
  is_section_final_item: column.integer,
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
  org_id:         column.text,
  crew_member_id: column.text,
  available_date: column.text,
  is_available:   column.integer,
  notes:          column.text,
  created_at:     column.text,
})

const crew_members = new Table({
  org_id:             column.text,
  name:               column.text,
  email:              column.text,
  phone:              column.text,
  role:               column.text,
  specialty:          column.text,
  is_active:          column.integer,
  user_id:            column.text,
  invite_sent_at:     column.text,
  invite_accepted_at: column.text,
})

const maintenance_schedules = new Table({
  property_id:               column.text,
  org_id:                    column.text,
  name:                      column.text,
  description:               column.text,
  schedule_type:             column.text,
  frequency:                 column.text,
  active_from_month:         column.integer,
  active_to_month:           column.integer,
  asset_category:            column.text,
  next_due_date:             column.text,
  estimated_cost:            column.real,
  instructions:              column.text,
  auto_create_wo:            column.integer,
  is_from_standard_template: column.integer,
  is_active:                 column.integer,
  created_at:                column.text,
  updated_at:                column.text,
})

const maintenance_completions = new Table({
  maintenance_schedule_id: column.text,
  property_id:             column.text,
  org_id:                  column.text,
  asset_category:          column.text,
  completed_at:            column.text,
  completed_by:            column.text,
  notes:                   column.text,
  work_order_id:           column.text,
  next_due_date_set:       column.integer,
  created_at:              column.text,
})

const turnover_assignments = new Table({
  turnover_id:    column.text,
  crew_member_id: column.text,
  org_id:         column.text,
  assigned_at:    column.text,
  assigned_by:    column.text,
})

const messages = new Table({
  org_id:       column.text,
  sender_id:    column.text,
  recipient_id: column.text,
  content:      column.text,
  read_at:      column.text,
  turnover_id:  column.text,
  group_id:     column.text,
  group_label:  column.text,
  created_at:   column.text,
})

const turnover_issue_reports = new Table({
  turnover_id: column.text,
  org_id:      column.text,
  property_id: column.text,
  title:       column.text,
  description: column.text,
  priority:    column.text,
}, { insertOnly: true })

const pending_photo_uploads = new Table({
  target_table:   column.text,
  target_id:      column.text,
  target_column:  column.text,
  storage_path:   column.text,
  local_blob_key: column.text,
  mime_type:      column.text,
  retry_count:    column.integer,
  created_at:     column.text,
}, { localOnly: true })

export const AppSchema = new Schema({
  turnovers,
  checklist_instances,
  checklist_instance_items,
  inventory_items,
  properties,
  crew_availability,
  crew_members,
  maintenance_schedules,
  maintenance_completions,
  turnover_assignments,
  messages,
  turnover_issue_reports,
  pending_photo_uploads,
})
