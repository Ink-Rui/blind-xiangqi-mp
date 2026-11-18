-- 盲下象棋 · 联机房间表
-- 用法：Supabase Dashboard → SQL Editor → 新建查询 → 整段粘贴执行（只需一次）。

create table if not exists public.rooms (
  code         text primary key,
  state        jsonb not null,
  version      integer not null default 0,
  guest_joined boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.rooms enable row level security;

-- 房间码本身就是「口令」：知道 6 位码才能读写这个房间。
-- 前端用 version 做乐观锁，冲突时以库里最新状态为准。
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to anon using (true);

drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to anon with check (true);

drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to anon using (true) with check (true);

grant select, insert, update on public.rooms to anon;

-- 在线状态：双方各自定期更新自己那一列，用于显示“对手在线 / 可能已离开”
alter table public.rooms add column if not exists host_seen timestamptz;
alter table public.rooms add column if not exists guest_seen timestamptz;

create index if not exists rooms_updated_at_idx on public.rooms (updated_at);

-- 可选：定期清理两天前的房间（需要项目开启 pg_cron 扩展）
-- select cron.schedule('clean-blind-xiangqi-rooms', '0 4 * * *',
--   $$delete from public.rooms where updated_at < now() - interval '2 days'$$);
