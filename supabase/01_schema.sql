-- =====================================================================
-- 적정성평가 구조영역 — Supabase 스키마 (SQL Editor에 통째로 붙여넣고 RUN)
-- 맨 아래 '여기에 본인 이메일' 한 곳만 바꾸세요.
-- 여러 번 실행해도 안전합니다 (이미 있는 것은 건너뜀).
--
-- ▣ 칸막이(스키마) 'aq' 안에 만듭니다 → 이미 다른 시스템이 쓰는 프로젝트에 넣어도 섞이지 않습니다.
--   실행 후 Project Settings → Data API → Exposed schemas 에 aq 를 추가하세요.
--   같은 프로젝트에 이 시스템을 하나 더 만들려면: 메모장 [바꾸기](Ctrl+H)로  aq.  →  aq2.  ,  schema aq  →  schema aq2
--   를 모두 바꾼 뒤 실행하고, Netlify 환경변수 SUPABASE_SCHEMA=aq2 를 추가합니다.
create schema if not exists aq;
set search_path = aq, public;
grant usage on schema aq to anon, authenticated, service_role;
-- =====================================================================

-- 1) 테이블 ------------------------------------------------------------
create table if not exists aq.settings (
  key text primary key,                 -- 'config' | 'criteria' | 'hospitals'
  value jsonb not null,
  updated_at timestamptz default now(),
  updated_by text
);
create table if not exists aq.app_users (
  email text primary key,               -- 소문자
  name text not null default '',
  role text not null default '사용자',  -- '시스템관리자' | '사용자'
  access text not null default '',      -- 예: '1병원:admin,2병원:view'
  active text not null default 'Y',
  memo text default '',
  last_seen timestamptz
);
create table if not exists aq.series (
  code text not null,                   -- 기관코드
  kind text not null check (kind in ('pat','db')),
  sheet jsonb, sheet_at timestamptz, sheet_hash text, sheet_error text, sheet_checked_at timestamptz,  -- 구글시트 동기화가 씀
  upload jsonb, upload_at timestamptz, upload_by text,                                              -- 사용자 업로드가 씀
  primary key (code, kind)
);
create table if not exists aq.app_logs (
  id bigserial primary key, at timestamptz default now(),
  email text, name text, act text, detail text
);
create table if not exists aq.upload_history (
  id bigserial primary key, at timestamptz default now(),
  email text, name text, code text, kind text, mode text,
  rows int, added int, replaced int, range text
);

-- 2) 권한 함수 ----------------------------------------------------------
create or replace function aq.aq_rank(l text) returns int language sql immutable as $$
  select case l when 'view' then 1 when 'manage' then 2 when 'admin' then 3 else 0 end $$;

create or replace function aq.aq_active() returns boolean language sql stable security definer set search_path = aq, public as $$
  select exists (select 1 from aq.app_users where email = lower(auth.email()) and upper(active) <> 'N') $$;

create or replace function aq.aq_is_sys() returns boolean language sql stable security definer set search_path = aq, public as $$
  select exists (select 1 from aq.app_users where email = lower(auth.email()) and upper(active) <> 'N' and role = '시스템관리자') $$;

create or replace function aq.aq_level(p_code text) returns text language sql stable security definer set search_path = aq, public as $$
  select case when u.role = '시스템관리자' then 'admin'
              else (regexp_match(',' || coalesce(u.access, ''), ',' || p_code || ':(view|manage|admin)'))[1] end
  from aq.app_users u where u.email = lower(auth.email()) and upper(u.active) <> 'N' $$;

create or replace function aq.aq_codes() returns setof text language sql stable security definer set search_path = aq, public as $$
  select jsonb_array_elements(value) ->> 'code' from aq.settings where key = 'hospitals' $$;

create or replace function aq.aq_any_level(p_min text) returns boolean language sql stable security definer set search_path = aq, public as $$
  select aq_is_sys() or exists (select 1 from aq_codes() c where aq_rank(aq_level(c)) >= aq_rank(p_min)) $$;

create or replace function aq.aq_global_admin() returns boolean language sql stable security definer set search_path = aq, public as $$
  select aq_is_sys() or (exists (select 1 from aq_codes()) and not exists (select 1 from aq_codes() c where coalesce(aq_level(c), '') <> 'admin')) $$;

create or replace function aq.aq_can_upload(p_code text) returns boolean language sql stable security definer set search_path = aq, public as $$
  select aq_rank(aq_level(p_code)) >= aq_rank(coalesce((select value ->> 'UPLOAD_MIN_LEVEL' from aq.settings where key = 'config'), 'manage')) $$;

create or replace function aq.aq_touch() returns void language sql security definer set search_path = aq, public as $$
  update aq.app_users set last_seen = now() where email = lower(auth.email()) $$;

-- 3) 행 보안(RLS) ------------------------------------------------------
grant all on all tables in schema aq to authenticated, service_role;
grant all on all sequences in schema aq to authenticated, service_role;
grant execute on all functions in schema aq to authenticated, service_role;
alter table aq.settings enable row level security;
alter table aq.app_users enable row level security;
alter table aq.series enable row level security;
alter table aq.app_logs enable row level security;
alter table aq.upload_history enable row level security;

drop policy if exists s_read on aq.settings;   create policy s_read on aq.settings for select to authenticated using (aq_active());
drop policy if exists s_write on aq.settings;  create policy s_write on aq.settings for update to authenticated
  using (case key when 'hospitals' then aq_any_level('manage') else aq_global_admin() end)
  with check (case key when 'hospitals' then aq_any_level('manage') else aq_global_admin() end);

drop policy if exists u_read on aq.app_users;  create policy u_read on aq.app_users for select to authenticated using (email = lower(auth.email()) or aq_any_level('admin'));
drop policy if exists u_ins on aq.app_users;   create policy u_ins on aq.app_users for insert to authenticated with check (aq_any_level('admin') and (role <> '시스템관리자' or aq_is_sys()));
drop policy if exists u_upd on aq.app_users;   create policy u_upd on aq.app_users for update to authenticated using (aq_any_level('admin')) with check (role <> '시스템관리자' or aq_is_sys());
drop policy if exists u_del on aq.app_users;   create policy u_del on aq.app_users for delete to authenticated using (aq_is_sys());

drop policy if exists r_read on aq.series;     create policy r_read on aq.series for select to authenticated using (aq_rank(aq_level(code)) >= 1);
drop policy if exists r_upd on aq.series;      create policy r_upd on aq.series for update to authenticated using (aq_can_upload(code)) with check (aq_can_upload(code));
revoke insert, delete, update on aq.series from anon, authenticated;
grant update (upload, upload_at, upload_by) on aq.series to authenticated;   -- 사용자는 업로드 칸만 수정 가능

drop policy if exists l_ins on aq.app_logs;    create policy l_ins on aq.app_logs for insert to authenticated with check (email = lower(auth.email()) and aq_active());
drop policy if exists l_read on aq.app_logs;   create policy l_read on aq.app_logs for select to authenticated using (aq_any_level('admin'));

drop policy if exists h_ins on aq.upload_history;  create policy h_ins on aq.upload_history for insert to authenticated with check (email = lower(auth.email()) and aq_can_upload(code));
drop policy if exists h_read on aq.upload_history; create policy h_read on aq.upload_history for select to authenticated using (aq_rank(aq_level(code)) >= 1);

revoke all on aq.settings, aq.app_users, aq.app_logs, aq.upload_history from anon;

-- 4) 초기 데이터 --------------------------------------------------------
insert into aq.settings (key, value) values
  ('config', '{"APP_TITLE":"적정성평가 구조영역 모바일","EVAL_START":"2026-06-15","EVAL_END":"2026-12-14","AN_CODES":"AN,AN2,AN3","RN_SHARE_BONUS":66.7,"RN_SHARE_PENALTY":33.3,"SESSION_DAYS":7,"AUTO_REFRESH_MIN":5,"UPLOAD_MIN_LEVEL":"manage","SYNC_MIN":5}'::jsonb),
  ('criteria', '[["DOC_Q","적정성평가 의사1인당 환자수",1,"8.5",8.5,0,26,"이상미만",""],["DOC_Q","적정성평가 의사1인당 환자수",2,"6.8",6.8,26,30,"이상미만",""],["DOC_Q","적정성평가 의사1인당 환자수",3,"5.1",5.1,30,34,"이상미만",""],["DOC_Q","적정성평가 의사1인당 환자수",4,"3.4",3.4,34,38,"이상미만",""],["DOC_Q","적정성평가 의사1인당 환자수",5,"1.7",1.7,38,"","이상미만",""],["RN_Q","적정성평가 간호사1인당 환자수",1,"8.5",8.5,0,6,"이상미만",""],["RN_Q","적정성평가 간호사1인당 환자수",2,"6.8",6.8,6,9,"이상미만",""],["RN_Q","적정성평가 간호사1인당 환자수",3,"5.1",5.1,9,12,"이상미만",""],["RN_Q","적정성평가 간호사1인당 환자수",4,"3.4",3.4,12,15,"이상미만",""],["RN_Q","적정성평가 간호사1인당 환자수",5,"1.7",1.7,15,"","이상미만",""],["NURSE_Q","적정성평가 간호인력1인당 환자수",1,"7.5",7.5,0,3,"이상미만",""],["NURSE_Q","적정성평가 간호인력1인당 환자수",2,"6",6,3,4,"이상미만",""],["NURSE_Q","적정성평가 간호인력1인당 환자수",3,"4.5",4.5,4,5,"이상미만",""],["NURSE_Q","적정성평가 간호인력1인당 환자수",4,"3",3,5,6,"이상미만",""],["NURSE_Q","적정성평가 간호인력1인당 환자수",5,"1.5",1.5,6,"","이상미만",""],["PHARM_Q","적정성평가 약사 재직일수율(%)",1,"5.5",5.5,100,"","이상미만",""],["PHARM_Q","적정성평가 약사 재직일수율(%)",2,"4.4",4.4,80,100,"이상미만",""],["PHARM_Q","적정성평가 약사 재직일수율(%)",3,"3.3",3.3,60,80,"이상미만",""],["PHARM_Q","적정성평가 약사 재직일수율(%)",4,"2.2",2.2,40,60,"이상미만",""],["PHARM_Q","적정성평가 약사 재직일수율(%)",5,"1.1",1.1,0,40,"이상미만",""],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",1,"1등급",1,0,4.5,"이상미만","60% 가산"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",2,"2등급",2,4.5,5,"이상미만","50% 가산"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",3,"3등급",3,5,5.5,"이상미만","35% 가산"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",4,"4등급",4,5.5,6,"이상미만","20% 가산"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",5,"5등급",5,6,6.5,"이상미만","기준등급(가·감산 없음)"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",6,"6등급",6,6.5,7.5,"이상미만","20% 감산"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",7,"7등급",7,7.5,9,"이상미만","35% 감산"],["NURSE_GRADE","간호인력 차등제 등급(환자:간호인력)",8,"8등급",8,9,"","이상미만","50% 감산"],["DOC_GRADE","의사인력 차등제 등급(환자:의사)",1,"1등급",1,0,35,"초과이하","전문의 50% 이상 20% 가산 / 미만 10% 가산"],["DOC_GRADE","의사인력 차등제 등급(환자:의사)",2,"2등급",2,35,40,"초과이하","기준등급(가·감산 없음)"],["DOC_GRADE","의사인력 차등제 등급(환자:의사)",3,"3등급",3,40,50,"초과이하","15% 감산"],["DOC_GRADE","의사인력 차등제 등급(환자:의사)",4,"4등급",4,50,60,"초과이하","30% 감산"],["DOC_GRADE","의사인력 차등제 등급(환자:의사)",5,"5등급",5,60,"","초과이하","50% 감산"]]'::jsonb),
  ('hospitals', '[{"code":"1병원","name":"효사랑전주요양병원","patSheet":"1병원_요양병원일자별건수DATA_importing","dbSheet":"1병원근무표DBimport","patDateCol":"B","patValCol":"AL","nurseCol":"V","doctorCol":"K","wardCol":"Q","targetDoc":6.8,"targetRn":6.8,"targetNurse":4.5,"pharmRate":null,"active":"Y","patUrl":"","dbUrl":""},{"code":"2병원","name":"효사랑가족요양병원","patSheet":"2병원_요양병원일자별건수DATA_importing","dbSheet":"2병원근무표DBimport","patDateCol":"B","patValCol":"AL","nurseCol":"V","doctorCol":"K","wardCol":"Q","targetDoc":6.8,"targetRn":6.8,"targetNurse":4.5,"pharmRate":null,"active":"Y","patUrl":"","dbUrl":""},{"code":"3병원","name":"가족사랑요양병원","patSheet":"3병원_요양병원일자별건수DATA_importing","dbSheet":"3병원근무표DBimport","patDateCol":"B","patValCol":"AL","nurseCol":"V","doctorCol":"AE","wardCol":"Q","targetDoc":6.8,"targetRn":6.8,"targetNurse":4.5,"pharmRate":null,"active":"Y","patUrl":"","dbUrl":""}]'::jsonb)
on conflict (key) do nothing;

insert into aq.series (code, kind) select c, k from (values ('1병원'), ('2병원'), ('3병원')) a(c), (values ('pat'), ('db')) b(k)
on conflict do nothing;

-- ★ 여기에 본인 이메일 (소문자) — 첫 시스템관리자(개발자)
insert into aq.app_users (email, name, role, access, active, memo)
values (lower('여기에본인이메일@gmail.com'), '개발자', '시스템관리자', '', 'Y', '최초 관리자')
on conflict (email) do nothing;


-- 5) 사번 로그인 (추가) ---------------------------------------------------
alter table aq.app_users add column if not exists emp_no text;
create unique index if not exists app_users_emp_no on aq.app_users (upper(emp_no)) where emp_no is not null and emp_no <> '';
create or replace function aq.aq_email_for_emp(p_emp text) returns text language sql stable security definer set search_path = aq, public as $$
  select email from aq.app_users where upper(emp_no) = upper(trim(p_emp)) and upper(active) <> 'N' limit 1 $$;
grant execute on function aq.aq_email_for_emp(text) to anon, authenticated;

-- 6) 관리자 비밀번호 지정·초기화 (추가) -----------------------------------
create extension if not exists pgcrypto with schema extensions;
alter table aq.app_users add column if not exists pw_reset boolean not null default false;
alter table aq.app_users add column if not exists pw_set_at timestamptz;

create or replace function aq.aq_admin_set_password(p_email text, p_pw text) returns text
language plpgsql security definer set search_path = aq, public, auth, extensions as $$
declare e text := lower(trim(p_email)); t aq.app_users; uid uuid;
begin
  select * into t from aq.app_users where email = e;
  if not found then raise exception '등록되지 않은 사용자입니다'; end if;
  if not (aq.aq_is_sys() or (t.role <> '시스템관리자' and exists (
      select 1 from aq.aq_codes() c where aq.aq_level(c) = 'admin' and (',' || coalesce(t.access, '')) like '%,' || c || ':%'))) then
    raise exception '이 사용자의 비밀번호를 바꿀 권한이 없습니다'; end if;
  if length(coalesce(p_pw, '')) < 6 then raise exception '비밀번호 형식 오류'; end if;
  select id into uid from auth.users where lower(email) = e;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e, extensions.crypt(p_pw, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true), 'email', now(), now(), now());
  else
    update auth.users set encrypted_password = extensions.crypt(p_pw, extensions.gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = uid;
  end if;
  update aq.app_users set pw_reset = true, pw_set_at = now() where email = e;
  insert into aq.app_logs (email, name, act, detail) select lower(auth.email()), '', '비밀번호 지정', e;
  return 'ok';
end $$;

create or replace function aq.aq_pw_changed() returns void language sql security definer set search_path = aq, public as $$
  update aq.app_users set pw_reset = false, pw_set_at = now() where email = lower(auth.email()) $$;

revoke all on function aq.aq_admin_set_password(text, text) from public, anon;
grant execute on function aq.aq_admin_set_password(text, text) to authenticated;
grant execute on function aq.aq_pw_changed() to authenticated;

-- 7) 계정관리 재구성: 프로필 · 로그인 3방식 (추가) ---------------------------
alter table aq.app_users add column if not exists profile jsonb not null default '{}'::jsonb;

-- 로그인 ID → 계정 이메일. kind: emp(사번) | gmail | sys(시스템관리자 ID)
create or replace function aq.aq_login_email(p_kind text, p_id text) returns text language sql stable security definer set search_path = aq, public as $$
  select email from aq.app_users
  where upper(active) <> 'N' and case p_kind
    when 'sys'   then role = '시스템관리자' and lower(emp_no) = lower(trim(p_id))
    when 'gmail' then lower(profile ->> 'gmail') = lower(trim(p_id)) or email = lower(trim(p_id))
    else role <> '시스템관리자' and upper(emp_no) = upper(trim(p_id)) end
  limit 1 $$;
grant execute on function aq.aq_login_email(text, text) to anon, authenticated;

-- 기관 admin도 자기 기관 사용자 삭제 가능
drop policy if exists u_del on aq.app_users;
create policy u_del on aq.app_users for delete to authenticated using (aq_is_sys() or (role <> '시스템관리자' and aq_any_level('admin')));

-- ★ 시스템관리자 로그인 ID·비밀번호 지정 (아래 두 값만 바꾸고 실행)
do $$
declare v_mail text := lower('여기에본인이메일@gmail.com');   -- 01_schema.sql에 넣은 본인 이메일
        v_id   text := 'admin';                             -- 로그인 화면 [시스템 관리자] ID
        v_pw   text := '1234';                              -- 숫자 4자리
        uid uuid;
begin
  update aq.app_users set emp_no = v_id where email = v_mail and role = '시스템관리자';
  select id into uid from auth.users where lower(email) = v_mail;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', v_mail, extensions.crypt('aq#' || v_pw || '#hs', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', v_mail, 'email_verified', true), 'email', now(), now(), now());
  else
    update auth.users set encrypted_password = extensions.crypt('aq#' || v_pw || '#hs', extensions.gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()) where id = uid;
  end if;
end $$;
