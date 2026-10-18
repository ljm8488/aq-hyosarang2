#!/usr/bin/env bash
# Netlify가 배포할 때 자동 실행 — web/ + src/ 를 site/ 로 모으고 config.js 를 만듭니다.
set -euo pipefail
rm -rf site && mkdir -p site
cp -r web/. site/
cp src/calc-engine.js src/access-engine.js site/
# ★ 저장소 맨 위(루트)에 index.html이 있으면 그것을 사용 (단일 파일 업데이트 방식)
if [ -f index.html ]; then cp index.html site/index.html; echo "✓ 루트 index.html 사용"; fi

ENVN="prod"
if [ "${CONTEXT:-production}" != "production" ]; then ENVN="dev"; fi
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "⚠ SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없어 데모 모드로 배포합니다."
  ENVN="demo"
fi
SHA="${COMMIT_REF:-local}"
VER="$(TZ=Asia/Seoul date +%m%d-%H%M)-${SHA:0:7}"

cat > site/config.js <<EOF
window.AQ_CONFIG = { supabaseUrl: '${SUPABASE_URL:-}', supabaseAnonKey: '${SUPABASE_ANON_KEY:-}', supabaseSchema: '${SUPABASE_SCHEMA:-aq}', env: '${ENVN}', version: '${VER}' };
EOF
printf '{"version":"%s"}\n' "$VER" > site/version.json
echo "✓ build ${ENVN} ${VER}"
