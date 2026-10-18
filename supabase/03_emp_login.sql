-- 5) 사번 로그인 (추가) ---------------------------------------------------
alter table aq.app_users add column if not exists emp_no text;
create unique index if not exists app_users_emp_no on aq.app_users (upper(emp_no)) where emp_no is not null and emp_no <> '';
create or replace function aq.aq_email_for_emp(p_emp text) returns text language sql stable security definer set search_path = aq, public as $$
  select email from aq.app_users where upper(emp_no) = upper(trim(p_emp)) and upper(active) <> 'N' limit 1 $$;
grant execute on function aq.aq_email_for_emp(text) to anon, authenticated;
