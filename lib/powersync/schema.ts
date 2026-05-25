import { Column, ColumnType, Schema, Table } from '@powersync/web'

const turnovers = new Table({
  property_id:       new Column({ type: ColumnType.TEXT }),
  checkout_datetime: new Column({ type: ColumnType.TEXT }),
  checkin_datetime:  new Column({ type: ColumnType.TEXT }),
  window_minutes:    new Column({ type: ColumnType.INTEGER }),
  status:            new Column({ type: ColumnType.TEXT }),
  priority:          new Column({ type: ColumnType.TEXT }),
  notes:             new Column({ type: ColumnType.TEXT }),
})

const checklist_instances = new Table({
  turnover_id: new Column({ type: ColumnType.TEXT }),
  status:      new Column({ type: ColumnType.TEXT }),
})

const checklist_instance_items = new Table({
  instance_id:        new Column({ type: ColumnType.TEXT }),
  section_name:       new Column({ type: ColumnType.TEXT }),
  task:               new Column({ type: ColumnType.TEXT }),
  is_completed:       new Column({ type: ColumnType.INTEGER }),
  requires_photo:     new Column({ type: ColumnType.INTEGER }),
  photo_storage_path: new Column({ type: ColumnType.TEXT }),
  crew_notes:         new Column({ type: ColumnType.TEXT }),
  sort_order:         new Column({ type: ColumnType.INTEGER }),
})

const inventory_items = new Table({
  property_id:      new Column({ type: ColumnType.TEXT }),
  name:             new Column({ type: ColumnType.TEXT }),
  category:         new Column({ type: ColumnType.TEXT }),
  unit:             new Column({ type: ColumnType.TEXT }),
  par_level:        new Column({ type: ColumnType.INTEGER }),
  current_quantity: new Column({ type: ColumnType.INTEGER }),
})

export const AppSchema = new Schema([
  turnovers,
  checklist_instances,
  checklist_instance_items,
  inventory_items,
])
