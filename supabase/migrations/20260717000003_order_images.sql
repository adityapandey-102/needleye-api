-- Order reference images: up to 4 per order, one row per slot. Actual bytes
-- live in Supabase Storage (bucket below); this table is the pointer +
-- metadata. Uploads/downloads always go through apps/api using the
-- service-role key (never client -> Storage directly), so file-type/slot
-- checks and authorization stay server-side -- mirroring the prototype's
-- upload guard (file.type.startsWith("image/")).

create table public.order_images (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  slot smallint not null check (slot between 1 and 4),
  storage_path text not null,
  original_filename text,
  content_type text,
  size_bytes int,
  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (order_id, slot)
);

grant select, insert, update, delete on public.order_images to service_role;
grant select on public.order_images to authenticated;

alter table public.order_images enable row level security;

create policy order_images_select_scoped on public.order_images
  for select
  using (
    exists (
      select 1 from public.orders o
      join public.profiles p on p.id = auth.uid()
      where o.id = public.order_images.order_id
        and (
          p.role in ('owner_manager', 'accountant')
          or (p.role = 'designer' and o.designer_id = auth.uid())
          or (p.role = 'master_tailor' and o.master_tailor_id = auth.uid())
        )
    )
  );

-- Private bucket -- images are only ever reached via short-lived signed URLs
-- that apps/api mints with the service-role key (which bypasses RLS by
-- design), so no storage.objects policies are added: the default
-- deny-by-default RLS on storage.objects already blocks any other access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-images', 'order-images', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
