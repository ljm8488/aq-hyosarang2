-- 사번 로그인 조회 수정: 시스템관리자도 사번으로 로그인 가능
create or replace function aq.aq_login_email(p_kind text, p_id text) returns text language sql stable security definer set search_path = aq, public as $$
  select email from aq.app_users
  where upper(active) <> 'N' and case p_kind
    when 'sys'   then role = '시스템관리자' and lower(emp_no) = lower(trim(p_id))
    when 'gmail' then lower(profile ->> 'gmail') = lower(trim(p_id)) or email = lower(trim(p_id))
    else upper(emp_no) = upper(trim(p_id)) end
  limit 1 $$;
grant execute on function aq.aq_login_email(text, text) to anon, authenticated;
notify pgrst, 'reload schema';
