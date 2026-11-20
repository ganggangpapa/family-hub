-- =====================================================================
-- 하루노트 가족 연결 (우리집 허브) — 서버 표와 보안 규칙
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run
-- 여러 번 실행해도 괜찮게 만들었습니다 (이미 있으면 건너뜀).
-- 설계 문서: docs/FAMILY_HUB.md
-- =====================================================================
-- 원칙
--  · 부모만 이메일로 로그인. 아이 기기는 "익명 로그인" 후 부모가 만든 6자리 코드로 가족에 연결.
--  · 아이 정보는 별명·학년만. 학습 기록은 하루 요약만.
--  · 모든 표에 RLS(행 단위 보안)를 켜서 자기 가족 데이터만 읽고 쓰게 함.
--  · 가족 만들기, 아이 추가, 연결 코드는 아래 함수(RPC)로만 처리.
-- =====================================================================

-- ---------- 표 ----------
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 30),
  invite_code text not null unique,          -- 배우자(두 번째 부모)가 들어올 때 쓰는 코드
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  user_id    uuid unique references auth.users(id) on delete set null,  -- 연결된 로그인 (아이는 연결 전엔 비어 있음)
  role       text not null check (role in ('parent', 'child')),
  nickname   text not null check (char_length(nickname) between 1 and 20),
  grade      int  check (grade between 1 and 9),                         -- 초1~6, 중1~3은 7~9
  created_at timestamptz not null default now()
);
create index if not exists members_family_idx on public.members(family_id);

create table if not exists public.link_codes (
  code       text primary key,
  family_id  uuid not null references public.families(id) on delete cascade,
  member_id  uuid not null references public.members(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table if not exists public.study_daily (
  id         bigint generated always as identity primary key,
  family_id  uuid not null references public.families(id) on delete cascade,
  member_id  uuid not null references public.members(id) on delete cascade,
  app        text not null check (app in ('harunote', 'nuneul')),
  day        date not null,
  subject    text not null check (char_length(subject) <= 20),
  solved     int  not null default 0 check (solved between 0 and 10000),
  correct    int  not null default 0 check (correct between 0 and 10000),
  practice   jsonb not null default '[]'::jsonb,   -- 더 연습하면 좋은 단원 이름 몇 개
  updated_at timestamptz not null default now(),
  unique (member_id, app, day, subject)
);
create index if not exists study_daily_family_day_idx on public.study_daily(family_id, day desc);

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  family_id   uuid not null references public.families(id) on delete cascade,
  from_member uuid not null references public.members(id) on delete cascade,
  to_member   uuid references public.members(id) on delete cascade,   -- 비우면 가족 모두에게
  kind        text not null check (kind in ('cheer', 'sticker', 'show', 'meal_request')),  -- 응원 / 칭찬 스티커 / 보여 주기 / 먹고 싶어요
  body        text not null check (char_length(body) <= 200),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists messages_family_idx on public.messages(family_id, created_at desc);
-- 이미 표를 만든 뒤 다시 실행할 때를 위해 종류 목록을 새로 맞춤
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('cheer', 'sticker', 'show', 'meal_request'));

-- 오늘저녁: 저녁 메뉴 투표 (메뉴 이름만. 알레르기·학교 정보는 올리지 않음)
create table if not exists public.meal_polls (
  id         bigint generated always as identity primary key,
  family_id  uuid not null references public.families(id) on delete cascade,
  day        date not null,
  created_by uuid not null references public.members(id) on delete cascade,
  options    jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 5),
  closed_at  timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists meal_polls_family_idx on public.meal_polls(family_id, day desc);

create table if not exists public.meal_votes (
  poll_id    bigint not null references public.meal_polls(id) on delete cascade,
  member_id  uuid not null references public.members(id) on delete cascade,
  family_id  uuid not null references public.families(id) on delete cascade,
  choice     int  not null check (choice between 0 and 4),
  created_at timestamptz not null default now(),
  primary key (poll_id, member_id)
);

-- ---------- 도움 함수 ----------
-- 지금 로그인한 사람의 구성원 정보 (RLS 안에서 쓰므로 security definer)
create or replace function public.my_member()
returns public.members language sql stable security definer set search_path = public as $$
  select * from public.members where user_id = auth.uid() limit 1;
$$;

create or replace function public.my_family_id()
returns uuid language sql stable security definer set search_path = public as $$
  select family_id from public.members where user_id = auth.uid() limit 1;
$$;

create or replace function public.i_am_parent()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'parent')
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;

create or replace function public._new_code(len int)
returns text language sql volatile as $$
  select lpad(floor(random() * power(10, len))::bigint::text, len, '0');
$$;

-- ---------- 함수(RPC): 앱에서 부르는 기능 ----------
-- 1) 부모: 가족 만들기 (이메일로 로그인한 부모만, 아직 가족이 없을 때)
create or replace function public.create_family(fam_name text, parent_nickname text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid; code text;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception '부모 계정으로 로그인해 주세요';
  end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception '이미 가족에 속해 있어요';
  end if;
  loop
    code := _new_code(8);
    exit when not exists (select 1 from families where invite_code = code);
  end loop;
  insert into families(name, invite_code) values (fam_name, code) returning id into fid;
  insert into members(family_id, user_id, role, nickname) values (fid, auth.uid(), 'parent', parent_nickname);
  return fid;
end $$;

-- 2) 두 번째 부모: 초대 코드로 가족에 들어가기
create or replace function public.join_family_as_parent(code text, parent_nickname text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception '부모 계정으로 로그인해 주세요';
  end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception '이미 가족에 속해 있어요';
  end if;
  select id into fid from families where invite_code = code;
  if fid is null then raise exception '초대 코드가 맞지 않아요'; end if;
  insert into members(family_id, user_id, role, nickname) values (fid, auth.uid(), 'parent', parent_nickname);
  return fid;
end $$;

-- 3) 부모: 아이 추가 (별명·학년만)
create or replace function public.add_child(child_nickname text, child_grade int)
returns uuid language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if not i_am_parent() then raise exception '부모만 할 수 있어요'; end if;
  insert into members(family_id, role, nickname, grade)
  values (my_family_id(), 'child', child_nickname, child_grade) returning id into mid;
  return mid;
end $$;

-- 4) 부모: 아이 기기용 6자리 연결 코드 (10분 동안 유효)
create or replace function public.create_link_code(child_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not i_am_parent() then raise exception '부모만 할 수 있어요'; end if;
  if not exists (select 1 from members where id = child_id and family_id = my_family_id() and role = 'child') then
    raise exception '우리 가족 아이가 아니에요';
  end if;
  delete from link_codes where expires_at < now() or member_id = child_id;
  loop
    c := _new_code(6);
    exit when not exists (select 1 from link_codes where code = c);
  end loop;
  insert into link_codes(code, family_id, member_id, expires_at)
  values (c, my_family_id(), child_id, now() + interval '10 minutes');
  return c;
end $$;

-- 5) 아이 기기: 연결 코드 입력 (익명 로그인 상태에서)
create or replace function public.redeem_link_code(c text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lc link_codes;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  select * into lc from link_codes where code = c and used_at is null and expires_at > now();
  if lc.code is null then raise exception '코드가 맞지 않거나 시간이 지났어요'; end if;
  update members set user_id = null where user_id = auth.uid();          -- 이 기기의 예전 연결은 풂
  update members set user_id = auth.uid() where id = lc.member_id;      -- 새 기기로 연결 (예전 기기는 끊김)
  update link_codes set used_at = now() where code = c;
  return lc.member_id;
end $$;

-- 6) 아무나: 이 기기의 가족 연결 끊기
create or replace function public.leave_family()
returns void language sql security definer set search_path = public as $$
  update public.members set user_id = null where user_id = auth.uid() and role = 'child';
  delete from public.members where user_id = auth.uid() and role = 'parent';
$$;

-- 함수 실행 권한: 로그인한 사람만
revoke all on function public.my_member(), public.my_family_id(), public.i_am_parent(), public._new_code(int),
  public.create_family(text, text), public.join_family_as_parent(text, text), public.add_child(text, int),
  public.create_link_code(uuid), public.redeem_link_code(text), public.leave_family()
  from public, anon;
grant execute on function public.my_member(), public.my_family_id(), public.i_am_parent(),
  public.create_family(text, text), public.join_family_as_parent(text, text), public.add_child(text, int),
  public.create_link_code(uuid), public.redeem_link_code(text), public.leave_family()
  to authenticated;

-- ---------- 보안 규칙 (RLS) ----------
alter table public.families    enable row level security;
alter table public.members     enable row level security;
alter table public.link_codes  enable row level security;   -- 규칙 없음 = 직접 접근 불가 (함수로만)
alter table public.study_daily enable row level security;
alter table public.messages    enable row level security;
alter table public.meal_polls  enable row level security;
alter table public.meal_votes  enable row level security;

revoke all on public.families, public.members, public.link_codes, public.study_daily, public.messages, public.meal_polls, public.meal_votes from anon;
revoke all on public.link_codes from authenticated;
grant select on public.families to authenticated;
grant select, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.study_daily to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert, update on public.meal_polls to authenticated;
grant select, insert, update, delete on public.meal_votes to authenticated;

drop policy if exists fam_read on public.families;
create policy fam_read on public.families for select to authenticated
  using (id = my_family_id());

drop policy if exists mem_read on public.members;
create policy mem_read on public.members for select to authenticated
  using (family_id = my_family_id());
drop policy if exists mem_parent_edit on public.members;
create policy mem_parent_edit on public.members for update to authenticated
  using (family_id = my_family_id() and i_am_parent())
  with check (family_id = my_family_id());
drop policy if exists mem_parent_delete on public.members;
create policy mem_parent_delete on public.members for delete to authenticated
  using (family_id = my_family_id() and i_am_parent() and role = 'child');

drop policy if exists study_read on public.study_daily;
create policy study_read on public.study_daily for select to authenticated
  using (family_id = my_family_id());
drop policy if exists study_write on public.study_daily;
create policy study_write on public.study_daily for insert to authenticated
  with check (member_id = (my_member()).id and family_id = my_family_id());
drop policy if exists study_update on public.study_daily;
create policy study_update on public.study_daily for update to authenticated
  using (member_id = (my_member()).id) with check (member_id = (my_member()).id and family_id = my_family_id());
drop policy if exists study_delete on public.study_daily;
create policy study_delete on public.study_daily for delete to authenticated
  using (family_id = my_family_id() and (member_id = (my_member()).id or i_am_parent()));

drop policy if exists msg_read on public.messages;
create policy msg_read on public.messages for select to authenticated
  using (family_id = my_family_id());
drop policy if exists msg_send on public.messages;
create policy msg_send on public.messages for insert to authenticated
  with check (from_member = (my_member()).id and family_id = my_family_id()
              and (to_member is null or to_member in (select id from public.members where family_id = my_family_id())));
drop policy if exists msg_mark_read on public.messages;
create policy msg_mark_read on public.messages for update to authenticated
  using (family_id = my_family_id() and (to_member = (my_member()).id or to_member is null))
  with check (family_id = my_family_id());

-- 투표: 부모가 올리고 닫음, 가족 누구나 한 표 (다시 누르면 바뀜)
drop policy if exists poll_read on public.meal_polls;
create policy poll_read on public.meal_polls for select to authenticated
  using (family_id = my_family_id());
drop policy if exists poll_create on public.meal_polls;
create policy poll_create on public.meal_polls for insert to authenticated
  with check (family_id = my_family_id() and i_am_parent() and created_by = (my_member()).id);
drop policy if exists poll_close on public.meal_polls;
create policy poll_close on public.meal_polls for update to authenticated
  using (family_id = my_family_id() and i_am_parent()) with check (family_id = my_family_id());

drop policy if exists vote_read on public.meal_votes;
create policy vote_read on public.meal_votes for select to authenticated
  using (family_id = my_family_id());
drop policy if exists vote_cast on public.meal_votes;
create policy vote_cast on public.meal_votes for insert to authenticated
  with check (member_id = (my_member()).id and family_id = my_family_id()
              and poll_id in (select id from public.meal_polls where family_id = my_family_id() and closed_at is null));
drop policy if exists vote_change on public.meal_votes;
create policy vote_change on public.meal_votes for update to authenticated
  using (member_id = (my_member()).id)
  with check (member_id = (my_member()).id and family_id = my_family_id()
              and poll_id in (select id from public.meal_polls where family_id = my_family_id() and closed_at is null));
drop policy if exists vote_cancel on public.meal_votes;
create policy vote_cancel on public.meal_votes for delete to authenticated
  using (member_id = (my_member()).id);

-- 끝. 실행 후 "Success. No rows returned"가 나오면 성공입니다.
