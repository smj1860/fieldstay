-- Optional sponsor photo, uploaded from the self-serve media kit page and
-- rendered in the guest guidebook sponsor card when present.

alter table guidebook_sponsors
  add column photo_storage_path text;

comment on column guidebook_sponsors.photo_storage_path is
  'Optional storage path in the guidebook-sponsor-photos bucket. Null if the sponsor has not uploaded a photo.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'guidebook-sponsor-photos',
  'guidebook-sponsor-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;
