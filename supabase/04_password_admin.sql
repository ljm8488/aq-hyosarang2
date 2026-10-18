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
