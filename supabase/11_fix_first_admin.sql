-- 11_fix_first_admin.sql  첫 시스템관리자 계정 바로잡기 (1회 실행)
-- 01_schema.sql의 '여기에본인이메일@gmail.com' 자리표시 계정을 본인 정보로 바꾸고 로그인 비밀번호를 만듭니다.
-- ★ 아래 4개 값만 확인·수정하고 Run 하세요. 다른 사용자는 건드리지 않습니다.
do $$
declare v_mail text := lower('kscript8488@gmail.com');   -- 본인 Gmail (로그인 계정)
        v_emp  text := '1234';                           -- 사번 (= 시스템 관리자 ID)
        v_name text := '이종민';                         -- 이름
        v_pw   text := '1234';                           -- 비밀번호 숫자 4자리
        uid uuid;
begin
  -- 1) 자리표시 계정 → 본인 정보로 변경 (이미 바꿨으면 건너뜀)
  if exists (select 1 from aq.app_users where email = lower('여기에본인이메일@gmail.com'))
     and not exists (select 1 from aq.app_users where email = v_mail) then
    update aq.app_users set email = v_mail where email = lower('여기에본인이메일@gmail.com');
  end if;
  insert into aq.app_users (email, name, role, access, active, memo)
  values (v_mail, v_name, '시스템관리자', '', 'Y', '최초 관리자') on conflict (email) do nothing;
  update aq.app_users set emp_no = v_emp, name = v_name, role = '시스템관리자', active = 'Y',
         profile = coalesce(profile, '{}'::jsonb) || jsonb_build_object('gmail', v_mail, 'hosp', '전체')
   where email = v_mail;

  -- 2) 로그인 계정(비밀번호) 생성 또는 변경
  select id into uid from auth.users where lower(email) = v_mail;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', v_mail, extensions.crypt('aq#' || v_pw || '#hs', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', v_mail, 'email_verified', true), 'email', now(), now(), now());
  else
    update auth.users set encrypted_password = extensions.crypt('aq#' || v_pw || '#hs', extensions.gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = uid;
  end if;
end $$;

notify pgrst, 'reload schema';

-- 결과 확인
select u.emp_no as 사번, u.name as 이름, u.role as 구분, u.email as 계정이메일,
       case when a.id is null then '없음' else '있음' end as 로그인계정
from aq.app_users u left join auth.users a on lower(a.email) = u.email order by u.role, u.emp_no;
