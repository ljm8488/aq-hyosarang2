-- 02_sample_data.sql을 이미 실행했다면, 그때 들어간 예시 사용자 6명을 지웁니다 (시스템관리자는 그대로).
delete from aq.app_users
where email in ('exec@hospital.kr','gm1@hospital.kr','nurse2@hospital.kr','doc3@hospital.kr','mix@hospital.kr','old@hospital.kr')
  and role <> '시스템관리자';
