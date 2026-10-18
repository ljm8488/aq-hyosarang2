/**
 * access-engine.js — 기관별 접근권한 확장 (window.AQX)  v1.0
 * calc-engine.js(AQ)의 계산 함수는 그대로 쓰고, 권한 모델만 교체합니다.
 *
 * 사용자 = { email, name, role: '시스템관리자'|'사용자', access: '1병원:admin,2병원:view', active, memo, lastSeen }
 * 기관별 등급:  view(뷰)    조회만
 *              manage(관리) 조회 + 해당 기관 목표 점수·약사재직률 편집
 *              admin        관리 + 해당 기관 기관명·원천시트·사용여부 + 해당 기관 사용자 권한 부여
 * 시스템관리자 = 전 기관 admin + 사용자 삭제·시스템관리자 지정
 * 공통 평가기준·환경설정 = 모든 기관 admin(globalAdmin)만
 * 3개기관 종합 = 시스템관리자 또는 모든 기관 뷰 이상
 * 소속(간호/진료)·병동 필터는 사용하지 않습니다.
 * 운영 반영: Code.gs의 perm_/findUser/api_adminGet/api_adminSave를 이 파일의 함수로 교체.
 */
(function (root, factory) {
  var X = factory(function () { return root.AQ || (typeof require === 'function' ? require('./calc-engine.js') : null); });   // 지연 참조: Apps Script 파일 로드 순서 무관
  if (typeof module === 'object' && module.exports) module.exports = X; else root.AQX = X;
})(typeof self !== 'undefined' ? self : this, function (getAQ) {
'use strict';
var LEVELS = ['', 'view', 'manage', 'admin'];
var RANK = { '': 0, view: 1, manage: 2, admin: 3 };
var LABEL = { '': '없음', view: '뷰', manage: '관리', admin: 'admin' };
var LONG = { '': '권한 없음', view: '뷰권한', manage: '관리권한', admin: '기관 admin' };
var ROLES = ['시스템관리자', '사용자'];
var UHEAD = ['email', 'name', 'role', 'access', 'active', 'memo', 'lastSeen'];
var HHEAD = ['code', 'name', 'patSheet', 'dbSheet', 'patDateCol', 'patValCol', 'nurseCol', 'doctorCol', 'wardCol', 'targetDoc', 'targetRn', 'targetNurse', 'pharmRate', 'active', 'patUrl', 'dbUrl'];
var MANAGE_COLS = [9, 10, 11, 12];   // 관리권한이 편집할 수 있는 기관 열 (목표 3종 + 약사재직률)
var SOURCE_COLS = [2, 3, 4, 5, 6, 7, 8, 14, 15];   // 구글시트 연결(탭·열·URL) — 개발자(시스템관리자)만

function low(s) { return String(s || '').trim().toLowerCase(); }
function isActive(u) { return String(u.active).toUpperCase() !== 'N'; }
function parseAccess(s) {
  var o = {};
  String(s || '').split(/[,;]/).forEach(function (p) {
    var m = p.split(':'), k = (m[0] || '').trim(), v = (m[1] || '').trim();
    if (k && RANK[v]) o[k] = v;
  });
  return o;
}
function formatAccess(o, codes) {
  return (codes || Object.keys(o)).filter(function (k) { return o[k]; }).map(function (k) { return k + ':' + o[k]; }).join(',');
}
function rowToUser(r) { var o = {}; UHEAD.forEach(function (k, i) { o[k] = r[i]; }); return o; }
function userToRow(u) { return UHEAD.map(function (k) { return u[k] === undefined ? '' : u[k]; }); }

function findUser(d, email) {
  email = low(email);
  var u = (d.users || []).filter(function (x) { return low(x.email) === email && isActive(x) && ROLES.indexOf(x.role) >= 0; })[0];
  if (!u) return null;
  if (u.role !== '시스템관리자' && !Object.keys(parseAccess(u.access)).length) return null;   // 어느 기관에도 권한 없음
  return { email: u.email, name: u.name, role: u.role, access: u.access || '' };
}

function permissions(u, hospList) {
  var codes = hospList.map(function (h) { return h.code; });
  var sys = u.role === '시스템관리자', acc = parseAccess(u.access), lv = {};
  codes.forEach(function (c) { lv[c] = sys ? 'admin' : (acc[c] || ''); });
  function at(min) { return codes.filter(function (c) { return RANK[lv[c]] >= RANK[min]; }); }
  var view = at('view'), manage = at('manage'), admin = at('admin'), n = codes.length;
  return {
    role: u.role, sys: sys, levels: lv,
    hospitals: view, manageHosps: manage, adminHosps: admin,
    combined: sys || (n > 0 && view.length === n),
    globalAdmin: sys || (n > 0 && admin.length === n),
    settings: manage.length > 0,
    sections: { doctor: true, nurse: true }, wards: null
  };
}

function roleLabel(u, codes) {
  if (u.role === '시스템관리자') return '시스템관리자';
  var a = parseAccess(u.access), ks = codes.filter(function (c) { return a[c]; });
  if (ks.length === codes.length && ks.every(function (c) { return a[c] === 'admin'; })) return '전 기관 admin';
  if (ks.length === codes.length && ks.every(function (c) { return a[c] === 'view'; })) return '전 기관 뷰';
  if (ks.length === 1) return ks[0] + ' ' + LONG[a[ks[0]]];
  return '기관별 권한';
}
function accessSummary(u, codes) {
  if (u.role === '시스템관리자') return '전 기관 admin';
  var a = parseAccess(u.access);
  return codes.filter(function (c) { return a[c]; }).map(function (c) { return c + ' ' + LABEL[a[c]]; }).join(' · ') || '권한 없음';
}

/* 대시보드 — 계산은 AQ 그대로, 권한만 교체 */
function buildDashboard(opts) {
  var AQ = getAQ();
  var d = opts.data, today = opts.today || d.meta.today, U = AQ.util;
  var user = findUser(d, opts.userEmail);
  if (!user) return { ok: false, error: 'AUTH', message: '등록되지 않았거나 사용중지된 사용자입니다.' };
  var hosp = d.hospitals.filter(function (h) { return String(h.active).toUpperCase() !== 'N'; });
  var crit = AQ.critFromRows(d.criteriaRows, d.config);
  var p = permissions(user, hosp);
  var start = U.dkey(opts.start), end = U.dkey(opts.end);
  if (!start || !end || start > end) return { ok: false, error: 'PERIOD', message: '기간을 확인해 주세요.' };
  if (U.daysBetween(start, end) > 400) return { ok: false, error: 'PERIOD', message: '조회 기간은 400일 이내로 설정해 주세요.' };
  var out = { ok: true, today: today, start: start, end: end, user: user, perm: p, hospitals: [] };
  hosp.forEach(function (cfg) {
    if (p.hospitals.indexOf(cfg.code) < 0) return;
    var S = d.series[cfg.code]; if (!S) return;
    var h = JSON.parse(JSON.stringify({
      code: cfg.code, name: cfg.name, level: p.levels[cfg.code],
      targets: { doc: cfg.targetDoc, rn: cfg.targetRn, nurse: cfg.targetNurse }, pharmRate: cfg.pharmRate,
      today: AQ.computeToday(S, crit, cfg, today),
      period: AQ.computePeriod(S, crit, cfg, start, end, today),
      trend: AQ.computeTrend(S, start, end, today)
    }));
    out.hospitals.push(AQ.filterByPerm(h, p));
  });
  if (p.combined) out.combined = AQ.combine(out.hospitals);
  out.criteria = { DOC_Q: crit.DOC_Q, RN_Q: crit.RN_Q, NURSE_Q: crit.NURSE_Q, PHARM_Q: crit.PHARM_Q, NURSE_GRADE: crit.NURSE_GRADE, DOC_GRADE: crit.DOC_GRADE };
  return out;
}

/* 관리 데이터 — 서버에서 권한 범위만 잘라서 전달 */
function visibleUsers(users, perm) {
  if (perm.globalAdmin) return users.slice();
  return users.filter(function (u) {
    if (u.role === '시스템관리자') return false;
    var a = parseAccess(u.access);
    return perm.adminHosps.some(function (c) { return a[c]; });
  });
}
function adminGet(d, perm) {
  return {
    CRIT: perm.globalAdmin ? d.criteriaRows.map(function (r) { return r.slice(); }) : null,
    CONF: perm.globalAdmin ? Object.keys(d.config).map(function (k) { return [k, d.config[k]]; }) : null,
    HOSP: d.hospitals.filter(function (h) { return perm.manageHosps.indexOf(h.code) >= 0; }).map(function (h) { return HHEAD.map(function (k) { return h[k]; }); }),
    USERS: perm.adminHosps.length ? { head: UHEAD, rows: visibleUsers(d.users, perm).map(userToRow) } : null,
    hospCodes: d.hospitals.map(function (h) { return h.code; }),
    perm: perm
  };
}
function adminLogs(d, perm) {
  var vis = {}; visibleUsers(d.users, perm).forEach(function (u) { vis[low(u.email)] = 1; });
  return d.logs.filter(function (l) { return perm.globalAdmin || vis[low(l[1])]; }).slice(0, 100).map(function (r) { return r.slice(); });
}

/* 저장 — 권한 검증 + 병합. 성공 시 {ok, data:새 배열}, 실패 시 {ok:false, msg} */
function applyUsers(all, rows, perm, codes) {
  var byEmail = {}; all.forEach(function (u) { byEmail[low(u.email)] = u; });
  var out = all.map(function (u) { var c = {}; for (var k in u) c[k] = u[k]; return c; });
  var idx = {}; out.forEach(function (u, i) { idx[low(u.email)] = i; });
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var u = rowToUser(rows[i]), e = low(u.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, msg: '이메일 형식 오류: ' + u.email };
    if (seen[e]) return { ok: false, msg: '중복 이메일: ' + u.email };
    seen[e] = 1;
    if (ROLES.indexOf(u.role) < 0) return { ok: false, msg: '권한등급 오류: ' + u.email };
    var old = byEmail[e];
    if (!perm.sys) {
      if (old && old.role === '시스템관리자') return { ok: false, msg: '시스템관리자 계정은 시스템관리자만 수정할 수 있습니다.' };
      if (u.role === '시스템관리자') return { ok: false, msg: '시스템관리자는 시스템관리자만 지정할 수 있습니다.' };
      var oa = old ? parseAccess(old.access) : {}, na = parseAccess(u.access), merged = {};
      codes.forEach(function (c) { merged[c] = perm.adminHosps.indexOf(c) >= 0 ? (na[c] || '') : (oa[c] || ''); });   // 관리 밖 기관은 기존값 유지
      u.access = formatAccess(merged, codes);
      if (!perm.globalAdmin) u.active = old ? old.active : 'Y';
      if (old && !visibleUsers([old], perm).length) { u.name = old.name; u.memo = old.memo; }
    }
    if (u.role === '시스템관리자') u.access = '';
    u.email = String(u.email).trim();
    u.lastSeen = old ? old.lastSeen : '';
    if (idx[e] !== undefined) out[idx[e]] = u; else { idx[e] = out.length; out.push(u); }
  }
  var vis = visibleUsers(all, perm), removed = vis.filter(function (u) { return !seen[low(u.email)]; });
  if (removed.length) {
    if (!perm.sys) return { ok: false, msg: '사용자 삭제는 시스템관리자만 가능합니다. 권한을 \'없음\'으로 바꿔 주세요.' };
    var rm = {}; removed.forEach(function (u) { rm[low(u.email)] = 1; });
    out = out.filter(function (u) { return !rm[low(u.email)]; });
  }
  if (!out.some(function (u) { return u.role === '시스템관리자' && isActive(u); })) return { ok: false, msg: '활성 시스템관리자가 최소 1명 필요합니다.' };
  return { ok: true, data: out };
}
function applyHosp(all, rows, perm) {
  var out = all.map(function (h) { var c = {}; for (var k in h) c[k] = h[k]; return c; });
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], code = r[0], lv = perm.levels[code] || '';
    var j = -1; out.forEach(function (h, x) { if (h.code === code) j = x; });
    if (j < 0) return { ok: false, msg: '기관 추가는 시스템관리자만 가능합니다: ' + code };
    if (RANK[lv] < RANK.manage) return { ok: false, msg: code + ' 편집 권한이 없습니다.' };
    var oldRow = HHEAD.map(function (k) { return out[j][k]; });
    for (var c = 1; c < HHEAD.length; c++) {
      if (!perm.sys && SOURCE_COLS.indexOf(c) >= 0 && String(r[c] == null ? '' : r[c]) !== String(oldRow[c] == null ? '' : oldRow[c])) return { ok: false, msg: code + ': 구글시트 연결(URL·탭·열)은 개발자(시스템관리자)만 변경할 수 있습니다.' };
      if (lv !== 'admin' && MANAGE_COLS.indexOf(c) < 0 && String(r[c] == null ? '' : r[c]) !== String(oldRow[c] == null ? '' : oldRow[c])) return { ok: false, msg: code + ': 관리권한은 목표·약사재직률만 수정할 수 있습니다.' };
      out[j][HHEAD[c]] = r[c];
    }
  }
  return { ok: true, data: out };
}
function canSave(which, perm) {
  if (which === 'CRIT' || which === 'CONF') return perm.globalAdmin;
  if (which === 'HOSP') return perm.manageHosps.length > 0;
  if (which === 'USERS') return perm.adminHosps.length > 0;
  return false;
}

/* 시트 연결 점검용 요약: buildSeries 결과 → {pat,rn,an,doc:{days,first,last,lastVal,recent}, wards, wardDate} */
function summarizeSeries(S) {
  function one(m) {
    var ks = Object.keys(m || {}).sort();
    if (!ks.length) return { days: 0, first: null, last: null, lastVal: null, recent: [] };
    return { days: ks.length, first: ks[0], last: ks[ks.length - 1], lastVal: m[ks[ks.length - 1]],
      recent: ks.slice(-5).reverse().map(function (k) { return [k, m[k]]; }) };
  }
  return { pat: one(S.pat), rn: one(S.rn), an: one(S.an), doc: one(S.doc), wards: (S.wardPat || []).length, wardDate: S.wardDataDate || '' };
}
/* 업로드 가능 기관: 기관별 등급이 minLevel(view|manage|admin, 기본 manage) 이상 */
function uploadHosps(perm, minLevel) {
  var min = RANK[minLevel] ? minLevel : 'manage';
  return perm.hospitals.filter(function (c) { return RANK[perm.levels[c] || ''] >= RANK[min]; });
}
/* 업로드 병합: 기존 행 + 새 행을 dateCol 기준으로 합침 (같은 날짜는 새 행으로 교체, 날짜 없는 기존 행은 유지) */
function mergeByDate(oldRows, newRows, dateColLetter) {
  var U = getAQ().util, ci = 0, s = String(dateColLetter || 'B').toUpperCase();
  for (var i = 0; i < s.length; i++) ci = ci * 26 + (s.charCodeAt(i) - 64); ci -= 1;
  var out = oldRows.map(function (r) { return r.slice(); }), at = {}, added = 0, replaced = 0;
  out.forEach(function (r, i) { var k = U.dkey(r[ci]); if (k) at[k] = i; });
  newRows.forEach(function (r) {
    var k = U.dkey(r[ci]); if (!k) return;
    if (at[k] !== undefined) { out[at[k]] = r.slice(); replaced++; } else { at[k] = out.length; out.push(r.slice()); added++; }
  });
  var w = 0; out.forEach(function (r) { if (r.length > w) w = r.length; });
  out = out.map(function (r) { while (r.length < w) r.push(''); return r; });
  return { rows: out, added: added, replaced: replaced };
}
function parseSheetUrl(u) {
  u = String(u || '').trim(); if (!u) return { ok: true, id: '' };
  var m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/) || u.match(/^([a-zA-Z0-9-_]{30,})$/);
  return m ? { ok: true, id: m[1] } : { ok: false, id: '' };
}

/* 기존 형식(role/hosp/affil/dept) → 새 형식 변환 (운영 시트 이관용) */
function migrateLegacyUser(u, codes) {
  if (u.role === '시스템관리자') return { email: u.email, name: u.name, role: '시스템관리자', access: '', active: u.active, memo: u.memo, lastSeen: u.lastSeen };
  var list = u.hosp === '전체' || u.role === '종합관리자' ? codes : String(u.hosp).split(/[,\s]+/).filter(function (c) { return codes.indexOf(c) >= 0; });
  var lv = u.role === '기관관리자' ? 'admin' : 'view', a = {};
  list.forEach(function (c) { a[c] = lv; });
  return { email: u.email, name: u.name, role: '사용자', access: formatAccess(a, codes), active: u.active, memo: u.memo, lastSeen: u.lastSeen };
}

return {
  version: '1.0', LEVELS: LEVELS, RANK: RANK, LABEL: LABEL, LONG: LONG, ROLES: ROLES, UHEAD: UHEAD, HHEAD: HHEAD, MANAGE_COLS: MANAGE_COLS,
  parseAccess: parseAccess, formatAccess: formatAccess, findUser: findUser, permissions: permissions,
  roleLabel: roleLabel, accessSummary: accessSummary, buildDashboard: buildDashboard,
  visibleUsers: visibleUsers, adminGet: adminGet, adminLogs: adminLogs,
  applyUsers: applyUsers, applyHosp: applyHosp, canSave: canSave, migrateLegacyUser: migrateLegacyUser,
  summarizeSeries: summarizeSeries, parseSheetUrl: parseSheetUrl, uploadHosps: uploadHosps, mergeByDate: mergeByDate, SOURCE_COLS: SOURCE_COLS
};
});
