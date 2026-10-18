-- ============================================================
-- 12_auto_login_account.sql   ★ 근본 해결: 사용자 등록 = 로그인 계정 자동 생성
-- · 사용자 계정 관리에서 사용자를 등록(추가)하는 순간, 서버가 로그인 계정을 자동으로 만듭니다.
--   초기 비밀번호 1234 · 첫 로그인 때 본인이 변경
-- · 이미 등록됐는데 로그인 계정이 없는 사용자(예: 이은이)도 이 파일 실행 시 함께 만들어집니다.
-- · 기존 사용자·비밀번호는 바꾸지 않습니다. 여러 번 실행해도 안전합니다.
-- ============================================================
set search_path = aq, public, extensions;

alter table aq.app_users add column if not exists pw_reset boolean not null default false;
alter table aq.app_users add column if not exists pw_set_at timestamptz;

-- 로그인 계정이 없으면 만든다 (있으면 아무것도 안 함). 반환: true = 새로 만듦
create or replace function aq.aq_ensure_auth(p_email text, p_pin text default '1234') returns boolean
language plpgsql security definer set search_path = aq, public, auth, extensions as $$
declare e text := lower(trim(p_email)); uid uuid;
begin
  if e is null or e = '' then return false; end if;
  if exists (select 1 from auth.users where lower(email) = e) then return false; end if;
  uid := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e,
    extensions.crypt('aq#' || p_pin || '#hs', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true), 'email', now(), now(), now());
  return true;
end $$;
revoke all on function aq.aq_ensure_auth(text, text) from public, anon, authenticated;

-- 등록 직후 화면에서 로그인 계정 생성 여부 확인용 (관리자만)
create or replace function aq.aq_login_check(p_email text) returns boolean language sql stable security definer set search_path = aq, public, auth as $$
  select aq.aq_any_level('admin') and exists (select 1 from auth.users where lower(email) = lower(trim(p_email))) $$;
grant execute on function aq.aq_login_check(text) to authenticated;

-- 등록(추가) 시 자동 실행되는 트리거
create or replace function aq.aq_users_auto_auth() returns trigger
language plpgsql security definer set search_path = aq, public, auth, extensions as $$
begin
  if aq.aq_ensure_auth(new.email, '1234') then
    new.pw_reset := true; new.pw_set_at := now();
  end if;
  return new;
end $$;
drop trigger if exists app_users_auto_auth on aq.app_users;
create trigger app_users_auto_auth before insert or update of email on aq.app_users
  for each row execute function aq.aq_users_auto_auth();

-- 이미 등록됐지만 로그인 계정이 없는 사용자 → 지금 만들기 (초기 비밀번호 1234)
do $$
declare r record;
begin
  for r in select u.email from aq.app_users u
           where not exists (select 1 from auth.users a where lower(a.email) = u.email) loop
    if aq.aq_ensure_auth(r.email, '1234') then
      update aq.app_users set pw_reset = true, pw_set_at = now() where email = r.email;
    end if;
  end loop;
end $$;

-- 소속기관은 있는데 기관권한이 비어 로그인이 막힌 사용자 → 현황뷰어 [뷰] 권한 부여
update aq.app_users u set access = case when (u.profile ->> 'hosp') = '전체'
    then (select string_agg(c || ':' || case when upper(u.profile ->> 'orgAdmin') = 'Y' then 'admin' when upper(u.profile ->> 'vUse') = 'Y' then 'manage' else 'view' end, ',') from aq.aq_codes() c)
    else (u.profile ->> 'hosp') || ':' || case when upper(u.profile ->> 'orgAdmin') = 'Y' then 'admin' when upper(u.profile ->> 'vUse') = 'Y' then 'manage' else 'view' end end
where u.role <> '시스템관리자' and coalesce(u.access, '') = '' and coalesce(u.profile ->> 'hosp', '') <> '';

notify pgrst, 'reload schema';

-- 결과 확인: 모든 줄의 로그인계정이 '있음'이면 정상
select u.emp_no as 사번, u.name as 이름, u.role as 구분, u.active as 사용, u.profile ->> 'hosp' as 소속,
       u.access as 기관권한, case when a.id is null then '없음' else '있음' end as 로그인계정, u.pw_reset as 첫로그인변경필요
from aq.app_users u left join auth.users a on lower(a.email) = u.email
order by u.role, u.emp_no;
