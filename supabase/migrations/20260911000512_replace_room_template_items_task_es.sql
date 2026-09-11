-- replace_room_template_items is the Templates Hub's room-template item
-- editor RPC (app/(dashboard)/templates/checklist/actions.ts) — the PM-facing
-- entry point for room template tasks. Extended to accept an optional
-- 'task_es' key per item so a PM can enter a Spanish translation here and
-- have it flow through apply-master-template.ts into every property's
-- checklist. NULLIF/'' matches the existing 'notes' handling: an empty
-- string from the form means "no translation", not a literal empty string.

CREATE OR REPLACE FUNCTION public.replace_room_template_items(p_room_template_id uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.room_template_items
  WHERE room_template_id = p_room_template_id;

  INSERT INTO public.room_template_items (room_template_id, task, task_es, requires_photo, notes, sort_order)
  SELECT
    p_room_template_id,
    item->>'task',
    NULLIF(item->>'task_es', ''),
    COALESCE((item->>'requires_photo')::boolean, false),
    NULLIF(item->>'notes', ''),
    COALESCE((item->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
