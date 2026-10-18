/**
 * 구글시트 → Supabase 자동 동기화 (개발자 전용, 5분마다)
 *
 * 설치 (README 5장)
 *  1) script.google.com > 새 프로젝트
 *  2) 이 파일(SheetSync.gs) + AQ.gs(src/calc-engine.js 내용) 붙여넣기
 *  3) 프로젝트 설정 > 스크립트 속성:
 *       SUPABASE_URL          https://xxxx.supabase.co
 *       SUPABASE_SERVICE_KEY  service_role 키 (절대 화면·깃허브에 넣지 마세요)
 *       SUPABASE_SCHEMA       (선택) 칸막이 이름, 기본 aq
 *  4) 함수 syncNow 실행 → 권한 허용 → 실행 로그 확인
 *  5) 함수 installTrigger 실행 → 5분마다 자동 실행 등록
 *
 * 어떤 시트를 읽을지는 앱의 기준설정 > 시트연동(개발자만 수정)에 저장된 값을 따릅니다.
 * 시트 내용이 바뀐 경우에만 Supabase에 씁니다 (바뀐 쪽이 우선: 업로드 vs 시트).
 */
var TZ = 'Asia/Seoul';

function prop_(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('스크립트 속성 ' + k + ' 가 없습니다.');
  return v;
}
function sb_(method, path, body) {
  var url = prop_('SUPABASE_URL').replace(/\/$/, '') + '/rest/v1/' + path, key = prop_('SUPABASE_SERVICE_KEY');
  var schema = PropertiesService.getScriptProperties().getProperty('SUPABASE_SCHEMA') || 'aq';
  var res = UrlFetchApp.fetch(url, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal,resolution=merge-duplicates', 'Accept-Profile': schema, 'Content-Profile': schema },
    payload: body === undefined ? undefined : JSON.stringify(body)
  });
  var c = res.getResponseCode(), t = res.getContentText();
  if (c >= 300) throw new Error('Supabase ' + c + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function hash_(o) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(o)).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function openTab_(url, tab) {
  var m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/);
  var ss = m ? SpreadsheetApp.openById(m[1]) : null;
  if (!ss) throw new Error('구글시트 URL이 없거나 형식이 아닙니다.');
  var sh = ss.getSheetByName(tab);
  if (!sh) throw new Error("'" + tab + "' 탭이 없습니다.");
  return sh;
}

function syncNow() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) return;
  try {
    var st = sb_('get', 'settings?select=key,value&key=in.(config,hospitals)'), conf = {}, hosp = [];
    st.forEach(function (r) { if (r.key === 'config') conf = r.value; if (r.key === 'hospitals') hosp = r.value; });
    var prev = {};
    sb_('get', 'series?select=code,kind,sheet_hash').forEach(function (r) { prev[r.code + '|' + r.kind] = r.sheet_hash; });
    var an = String(conf.AN_CODES || 'AN,AN2,AN3').split(/[,\s]+/).filter(String), today = today_(), now = new Date().toISOString();
    hosp.filter(function (h) { return String(h.active || 'Y').toUpperCase() !== 'N'; }).forEach(function (h) {
      ['pat', 'db'].forEach(function (kind) {
        var row = { code: h.code, kind: kind, sheet_checked_at: now };
        try {
          var v = openTab_(kind === 'pat' ? h.patUrl : h.dbUrl, kind === 'pat' ? h.patSheet : h.dbSheet).getDataRange().getValues();
          var S = AQ.buildSeries(h, kind === 'pat' ? v : [], kind === 'db' ? v : [], an, today);
          var part = kind === 'pat' ? { pat: S.pat } : { rn: S.rn, an: S.an, doc: S.doc, nurseWard: S.nurseWard, wardPat: S.wardPat, wardDataDate: S.wardDataDate };
          var n = kind === 'pat' ? Object.keys(S.pat).length : Object.keys(S.rn).length + Object.keys(S.doc).length;
          if (!n) throw new Error('날짜 데이터를 찾지 못했습니다. 시트연동의 열 위치를 확인하세요.');
          var hs = hash_(part);
          row.sheet_error = null;
          if (hs !== prev[h.code + '|' + kind]) { row.sheet = part; row.sheet_at = now; row.sheet_hash = hs; }
          Logger.log('✓ ' + h.code + ' ' + kind + (row.sheet ? ' 갱신' : ' 변경 없음') + ' (' + n + '일)');
        } catch (e) {
          row.sheet_error = String(e.message || e).slice(0, 300);
          Logger.log('✗ ' + h.code + ' ' + kind + ' ' + row.sheet_error);
        }
        sb_('post', 'series?on_conflict=code,kind', row);
      });
    });
  } finally { lock.releaseLock(); }
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(5).create();
  Logger.log('5분마다 syncNow 실행 등록 완료');
}
