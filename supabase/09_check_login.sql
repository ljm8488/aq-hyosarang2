-- 로그인 점검용 (읽기만 합니다 · 아무것도 바꾸지 않음)
select u.emp_no as 사번, u.name as 이름, u.role as 구분, u.active as 사용, u.profile ->> 'gmail' as gmail, u.email as 계정이메일,
       case when a.id is null then '없음 → 비밀번호 초기화 필요' when a.encrypted_password is null or a.encrypted_password = '' then '비밀번호 없음 → 초기화 필요' else '있음' end as 로그인계정,
       u.pw_reset as 초기화상태, u.profile ->> 'to' as 유효기간끝
from aq.app_users u left join auth.users a on lower(a.email) = u.email
order by u.role, u.emp_no;
