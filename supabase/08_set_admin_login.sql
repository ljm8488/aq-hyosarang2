-- 시스템관리자 로그인 ID·비밀번호 지정 (필요할 때만 실행)
-- 아래 세 값만 바꾸고 실행하세요. 다른 사용자는 건드리지 않습니다.
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
