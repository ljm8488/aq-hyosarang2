# 적정성평가 구조영역 계산 시스템 (Supabase + Netlify)

> 처음 설정하는 분은 **배포 후 `/guide.html`** (또는 이 저장소의 `web/guide.html`)의 체크리스트를 따라가세요. 아래는 같은 내용의 요약입니다.

## 구성

```
사용자 (어느 PC·휴대폰이든)
   │  https://<사이트이름>.netlify.app        ← 고정 URL (운영, main 브랜치)
   │  https://dev--<사이트이름>.netlify.app   ← 고정 URL (개발 미리보기, dev 브랜치)
   ▼
Netlify (무료, 화면)  ──로그인·조회·저장·업로드──▶  Supabase (무료, 공용 DB + 이메일 인증)
                                                        ▲
                       구글시트 ──5분마다── Apps Script (SheetSync.gs, 개발자 계정)
```

- **데이터는 Supabase 한 곳**에 있습니다. 누가 어디서 저장·업로드해도 모든 사용자가 같은 값을 봅니다.
- **구글시트**: 개발자만 연결(시트연동 화면). Apps Script가 5분마다 읽어 Supabase에 넣습니다.
- **파일 업로드**: 사용자가 엑셀/CSV를 올리면 Supabase에 저장되어 즉시 공통 반영됩니다.
  같은 기관·같은 종류는 **가장 최근에 바뀐 쪽**(업로드 또는 시트)이 적용됩니다.
- **업데이트**: GitHub에 커밋하면 Netlify가 1분 안에 다시 배포하고, 접속 중인 화면에 "새 버전" 안내가 뜹니다.

## 폴더

| 경로 | 내용 |
|---|---|
| `web/` | 화면. `index.html` = 앱, `guide.html` = 설정 안내 |
| `src/` | 계산 엔진·권한 엔진 (배포 시 자동 복사) |
| `supabase/01_schema.sql` | DB 테이블·보안 규칙·초기값 (SQL Editor에 1회 실행) |
| `supabase/02_sample_data.sql` | (선택) 테스트용 샘플 데이터 |
| `sheet-sync/` | 구글시트 → Supabase 동기화 (Apps Script에 붙여넣기) |
| `netlify.toml`, `scripts/build.sh` | Netlify 배포 설정 (수정 불필요) |

## 설정 요약 (자세한 화면 안내는 guide.html)

1. **Supabase** 프로젝트 생성(Region: Seoul) 또는 **기존 프로젝트** 사용 → SQL Editor에서 `01_schema.sql` 실행 (맨 아래 이메일을 본인 것으로)
   → **Project Settings → Data API → Exposed schemas** 에 `aq` 추가 → Save
   (모든 표는 `aq` 칸막이(스키마) 안에 만들어져 같은 프로젝트의 다른 시스템과 섞이지 않습니다)
2. Supabase **Authentication**
   - Email Templates > Magic Link 본문에 `{{ .Token }}` 추가 (6자리 코드 메일)
   - SMTP Settings: Gmail 앱 비밀번호로 사용자 지정 SMTP 설정 (기본 메일은 팀원에게만 발송됨)
3. Supabase **Project Settings > API**에서 Project URL · anon key · service_role key 확인
4. **GitHub** 새 저장소에 이 폴더 내용 업로드 → `dev` 브랜치 생성
5. **Netlify** > Import from GitHub → 환경변수 `SUPABASE_URL`, `SUPABASE_ANON_KEY` → Deploy
   → 사이트 이름 변경(고정 URL) → Branch deploys에 `dev` 추가
6. Supabase **URL Configuration > Site URL**에 Netlify 주소 입력
7. 고정 URL 접속 → 본인 이메일로 로그인 → 기준설정 > 사용자권한에서 사용자 등록
8. (구글시트 사용 시) `sheet-sync/` 를 Apps Script에 넣고 스크립트 속성 2개 → `syncNow` → `installTrigger`
   → 앱 기준설정 > 시트연동에서 URL·탭·열 입력·저장

## 무료 한도

| 서비스 | 무료 한도 | 주의 |
|---|---|---|
| Supabase | DB 500MB, 월 5만 사용자 | **7일간 요청이 없으면 일시정지** — 5분 동기화가 켜져 있으면 유지됨. 정지되면 대시보드에서 Restore |
| Netlify | 월 100GB 전송, 빌드 300분 | 커밋 1번 ≈ 빌드 20초 |
| Gmail SMTP | 하루 500통 | 로그인 유지 기간 동안 재인증 불필요 |

## 보안 메모

- `anon key`는 공개용 키라 화면에 들어가도 됩니다. 데이터는 DB 보안 규칙(RLS)으로 **등록된 사용자·권한별**로만 열립니다.
- `service_role key`는 **절대** 깃허브·화면에 넣지 말고 Apps Script 스크립트 속성에만 넣으세요.
- 기관별 세부 항목(목표값 등) 권한은 앱에서 검사하고, DB는 등급 단위(뷰/관리/admin)로 검사합니다.
