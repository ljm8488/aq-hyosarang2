/**
 * calc-engine.js — 적정성평가(구조영역) 예상점수 계산 엔진  v1.0
 * ------------------------------------------------------------------
 * 실제 운영 시스템(Google Apps Script: Calc.gs + Code.gs)과 "동일한 코드"를
 * 브라우저 / Node 어디서나 쓰도록 묶은 단독 모듈입니다. 외부 의존성 없음.
 *
 * 프로토타입(Claude Design)에서 사용법:
 *   <script src="calc-engine.js"></script>          // window.AQ 생성
 *   const data = await (await fetch('sample-data.json')).json();
 *   const dash = AQ.buildDashboard({ data, userEmail: 'admin@hospital.kr',
 *                                    start: '2026-06-15', end: '2026-12-14' });
 *   // dash 구조 = 운영 서버 api_dashboard() 응답과 100% 동일
 *
 * 검증: AQ.selfTest()  → 실제 시트(1병원) 값과 대조한 결과를 반환
 * ------------------------------------------------------------------ */
(function (root, factory) {
  var AQ = factory();
  if (typeof module === 'object' && module.exports) module.exports = AQ;
  else root.AQ = AQ;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------- 공통 유틸 ---------- */
function colIndex_(letter) {            // 'A' -> 0, 'AL' -> 37
  var s = String(letter || '').trim().toUpperCase(), n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}
function dkey_(v) {                     // Date | '2026-09-01 (화)' -> '2026-09-01'
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    return v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
  }
  var m = String(v).match(/(\d{4})\s*[-.\/]\s*(\d{1,2})\s*[-.\/]\s*(\d{1,2})/);
  return m ? m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]) : null;
}
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function num_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
function addDays_(key, n) {
  var p = key.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}
function daysBetween_(a, b) {           // 포함 일수 (a..b)
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000) + 1;
}
function round_(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  var p = Math.pow(10, d === undefined ? 2 : d); return Math.round(v * p) / p;
}
function safeDiv_(a, b) { return b ? a / b : null; }

/* ---------- 기준(구간) 매칭 ---------- */
/** bands: [{code,label,score,min,max,mode,note}] mode: '이상미만'(기본) | '초과이하' */
function matchBand_(bands, value) {
  if (value === null || value === undefined || !isFinite(value) || !bands) return null;
  for (var i = 0; i < bands.length; i++) {
    var b = bands[i];
    var lo = (b.min === '' || b.min === null) ? -Infinity : b.min;
    var hi = (b.max === '' || b.max === null) ? Infinity : b.max;
    var ok = b.mode === '초과이하' ? (value > lo && value <= hi) : (value >= lo && value < hi);
    if (ok) return b;
  }
  return null;
}

/* ---------- 원본 -> 시계열 ---------- */
/**
 * cfg: 기관설정 1행 {code,name,patDateCol,patValCol,nurseCol,doctorCol,wardCol}
 * patRows: 요양병원일자별건수DATA 시트 값, dbRows: 근무표DBimport 시트 값
 * anCodes: ['AN','AN2','AN3'] 간호조무 인력으로 합산할 코드
 * todayKey: 'yyyy-mm-dd'
 */
function buildSeries_(cfg, patRows, dbRows, anCodes, todayKey) {
  var S = { code: cfg.code, pat: {}, rn: {}, an: {}, doc: {}, nurseWard: {}, wardPat: [], wardDataDate: '' };
  var keepFrom = addDays_(todayKey, -400), wardFrom = addDays_(todayKey, -62);

  // 1) 일자별 재원환자 (EMR 요양병원 건수 DATA)
  var pd = colIndex_(cfg.patDateCol || 'B'), pv = colIndex_(cfg.patValCol || 'AL');
  for (var i = 0; i < patRows.length; i++) {
    var k = dkey_(patRows[i][pd]);
    if (!k || k < keepFrom || k > todayKey) continue;
    var raw = patRows[i][pv];
    if (raw === '' || raw === null) continue;
    S.pat[k] = num_(raw);
  }

  // 2) 간호인력 (연간 근무 DATA 블록: 날짜/부서/세부부서/RN/AN/AN2/AN3)
  var nc = colIndex_(cfg.nurseCol || 'V');
  var anOffset = { AN: 4, AN2: 5, AN3: 6 };
  var dc = colIndex_(cfg.doctorCol || 'K');
  var wc = colIndex_(cfg.wardCol || 'Q');
  for (var r = 0; r < dbRows.length; r++) {
    var row = dbRows[r];
    var nk = dkey_(row[nc]);
    if (nk && nk >= keepFrom) {
      var ward = String(row[nc + 2] || '').trim();
      var rn = num_(row[nc + 3]), an = 0;
      for (var c = 0; c < anCodes.length; c++) if (anOffset[anCodes[c]] !== undefined) an += num_(row[nc + anOffset[anCodes[c]]]);
      S.rn[nk] = (S.rn[nk] || 0) + rn;
      S.an[nk] = (S.an[nk] || 0) + an;
      if (nk >= wardFrom && nk <= todayKey && ward) {
        var w = S.nurseWard[nk] || (S.nurseWard[nk] = {});
        var cur = w[ward] || (w[ward] = { rn: 0, an: 0 });
        cur.rn += rn; cur.an += an;
      }
    }
    // 3) 의사인력 (진료부 근무 DATA: 날짜/부서/-/의료진수) — 날짜 중복시 마지막 값
    var dk = dkey_(row[dc]);
    if (dk && dk >= keepFrom && String(row[dc + 1] || '').indexOf('진료') >= 0) S.doc[dk] = num_(row[dc + 3]);
    // 4) 병동별 실시간 재원 (병실현황판 연동)
    var wn = String(row[wc] || '').trim();
    if (/병동$/.test(wn) && r > 1 && row[wc + 1] !== '' && row[wc + 1] !== null) S.wardPat.push({ ward: wn, pat: num_(row[wc + 1]) });
    if (r >= 2 && r <= 6 && !S.wardDataDate) { var wd = dkey_(row[wc + 2]); if (wd) S.wardDataDate = wd; }
  }
  return S;
}

/* 가장 최근(<= key) 값 */
function latest_(map, key) {
  var best = null;
  for (var k in map) if (k <= key && (best === null || k > best)) best = k;
  return best === null ? { date: null, value: 0 } : { date: best, value: map[best] };
}
function sumRange_(map, a, b) {
  var s = 0, n = 0;
  for (var k in map) if (k >= a && k <= b) { s += map[k]; n++; }
  return { sum: s, n: n };
}

/* ---------- 지표 산출 공통 ---------- */
function grades_(crit, pat, doc, rn, an, pharmRate) {
  var nurse = rn + an;
  var docRatio = safeDiv_(pat, doc), rnRatio = safeDiv_(pat, rn), nurseRatio = safeDiv_(pat, nurse);
  var rnShare = safeDiv_(rn, nurse);
  var bDocQ = matchBand_(crit.DOC_Q, docRatio), bRnQ = matchBand_(crit.RN_Q, rnRatio),
      bNurQ = matchBand_(crit.NURSE_Q, nurseRatio), bPh = matchBand_(crit.PHARM_Q, pharmRate);
  var bDocG = matchBand_(crit.DOC_GRADE, docRatio), bNurG = matchBand_(crit.NURSE_GRADE, nurseRatio);
  var rnBonus = '';
  if (rnShare !== null) {
    var hi = crit._opt && crit._opt.RN_SHARE_BONUS || 66.7, lo = crit._opt && crit._opt.RN_SHARE_PENALTY || 33.3;
    if (rnShare * 100 >= hi) rnBonus = '간호사 비율 ' + hi + '% 이상: 입원료 일당 약 2,000원 추가 가산';
    else if (rnShare * 100 < lo) rnBonus = '간호사 비율 ' + lo + '% 미만: 등급별 감산율에 10% 추가 감산';
  }
  var scores = {
    doc: bDocQ ? bDocQ.score : null, rn: bRnQ ? bRnQ.score : null,
    nurse: bNurQ ? bNurQ.score : null, pharm: bPh ? bPh.score : null
  };
  var total = 0, max = 0;
  ['DOC_Q', 'RN_Q', 'NURSE_Q', 'PHARM_Q'].forEach(function (k) {
    var m = 0; (crit[k] || []).forEach(function (b) { m = Math.max(m, b.score || 0); }); max += m;
  });
  ['doc', 'rn', 'nurse', 'pharm'].forEach(function (k) { total += scores[k] || 0; });
  return {
    ratio: { doc: round_(docRatio, 2), rn: round_(rnRatio, 2), nurse: round_(nurseRatio, 2) },
    rnShare: rnShare === null ? null : round_(rnShare * 100, 2),
    score: scores, total: round_(total, 1), maxTotal: round_(max, 1),
    docGrade: bDocG ? { label: bDocG.label, note: bDocG.note } : null,
    nurseGrade: bNurG ? { label: bNurG.label, note: bNurG.note } : null,
    rnShareNote: rnBonus
  };
}

/* ---------- Today 현황 ---------- */
function computeToday_(S, crit, cfg, todayKey) {
  var p = latest_(S.pat, todayKey);
  var rn = latest_(S.rn, todayKey), an = latest_(S.an, todayKey), doc = latest_(S.doc, todayKey);
  var g = grades_(crit, p.value, doc.value, rn.value, an.value, cfg.pharmRate);
  // 병동별
  var nwDate = latest_(S.nurseWard, todayKey).date, nw = nwDate ? S.nurseWard[nwDate] : {};
  var wards = [], seen = {};
  S.wardPat.forEach(function (w) {
    seen[w.ward] = 1; var s = nw[w.ward] || { rn: 0, an: 0 };
    wards.push(wardRow_(w.ward, w.pat, s.rn, s.an));
  });
  Object.keys(nw).forEach(function (wn) {             // 근무표에만 있는 병동(격리팀 등)
    if (seen[wn]) return;
    var base = wn.replace(/\s.*$/, '');
    var target = null; wards.forEach(function (x) { if (x.ward === base) target = x; });
    if (target) {                                      // '3병동 격리팀' -> '3병동'에 합산
      target.rn += nw[wn].rn; target.an += nw[wn].an; target.nurse = target.rn + target.an;
      target.rnRatio = round_(safeDiv_(target.pat, target.rn), 2);
      target.anRatio = round_(safeDiv_(target.pat, target.an), 2);
      target.nurseRatio = round_(safeDiv_(target.pat, target.nurse), 2);
      target.merged = (target.merged || []).concat(wn);
    } else wards.push(wardRow_(wn, null, nw[wn].rn, nw[wn].an));
  });
  wards.sort(function (a, b) { return (parseInt(a.ward, 10) || 999) - (parseInt(b.ward, 10) || 999); });
  return {
    code: cfg.code, name: cfg.name, date: todayKey, patDate: p.date, staffDate: rn.date, docDate: doc.date,
    wardDataDate: S.wardDataDate,
    pat: p.value, doc: doc.value, rn: rn.value, an: an.value, nurse: rn.value + an.value,
    ratio: g.ratio, rnShare: g.rnShare, score: g.score, total: g.total, maxTotal: g.maxTotal,
    docGrade: g.docGrade, nurseGrade: g.nurseGrade, rnShareNote: g.rnShareNote, wards: wards
  };
}
function wardRow_(ward, pat, rn, an) {
  return { ward: ward, pat: pat, rn: rn, an: an, nurse: rn + an,
    rnRatio: pat === null ? null : round_(safeDiv_(pat, rn), 2),
    anRatio: pat === null ? null : round_(safeDiv_(pat, an), 2),
    nurseRatio: pat === null ? null : round_(safeDiv_(pat, rn + an), 2) };
}

/* ---------- 기간 예측 (결과예측계산기 산식) ----------
 * 예상 재원일수 = [시작일~Today 실데이터] + Today 재원환자수 × 잔여일수
 * 예상 재직일수 = [시작일~Today 근무표]   + Today 근무자수   × 잔여일수
 * 최소필요인원(일평균) = (예상 재원일수 ÷ 목표구간 상한 − 실적 재직일수) ÷ 잔여일수
 * 조정가능 재원일수    = 예상 재직일수 × 목표구간 상한 − 실적 재원일수
 */
function computePeriod_(S, crit, cfg, start, end, todayKey) {
  var total = daysBetween_(start, end);
  var actualEnd = todayKey < end ? todayKey : end;
  var elapsed = todayKey < start ? 0 : daysBetween_(start, actualEnd);
  var remain = Math.max(0, total - elapsed);

  var t = computeToday_(S, crit, cfg, todayKey);
  var act = {
    pat: elapsed ? sumRange_(S.pat, start, actualEnd).sum : 0,
    doc: elapsed ? sumRange_(S.doc, start, actualEnd).sum : 0,
    rn: elapsed ? sumRange_(S.rn, start, actualEnd).sum : 0,
    an: elapsed ? sumRange_(S.an, start, actualEnd).sum : 0
  };
  act.nurse = act.rn + act.an;
  var coverage = {
    pat: elapsed ? sumRange_(S.pat, start, actualEnd).n : 0,
    doc: elapsed ? sumRange_(S.doc, start, actualEnd).n : 0,
    nurse: elapsed ? sumRange_(S.rn, start, actualEnd).n : 0
  };
  var fc = {
    pat: act.pat + t.pat * remain, doc: act.doc + t.doc * remain,
    rn: act.rn + t.rn * remain, an: act.an + t.an * remain
  };
  fc.nurse = fc.rn + fc.an;
  var g = grades_(crit, fc.pat, fc.doc, fc.rn, fc.an, cfg.pharmRate);
  var ga = elapsed ? grades_(crit, act.pat, act.doc, act.rn, act.an, cfg.pharmRate) : null;

  function plan(key, bandKey, target, actualStaff, fcStaff, todayStaff) {
    var band = null;
    (crit[bandKey] || []).forEach(function (b) { if (String(b.score) === String(target) || b.label === String(target)) band = b; });
    var bound = band && band.max !== '' && band.max !== null ? band.max : null;
    var cur = g.score[key];
    var res = { target: target, bound: bound, expected: cur, achieved: cur !== null && target !== '' && cur >= num_(target) };
    if (bound && remain > 0) {
      var need = (fc.pat / bound - actualStaff) / remain;
      res.minNeeded = round_(need, 2);
      res.shortage = round_(Math.max(0, need - todayStaff), 2);
      res.adjPatDays = Math.round(fcStaff * bound - act.pat);
      res.adjPatAvg = round_(res.adjPatDays / remain, 2);
    }
    return res;
  }
  return {
    code: cfg.code, name: cfg.name, start: start, end: end, today: todayKey,
    days: { total: total, elapsed: elapsed, remain: remain }, coverage: coverage,
    actual: act, forecast: fc,
    avg: { pat: round_(fc.pat / total, 2), doc: round_(fc.doc / total, 2), rn: round_(fc.rn / total, 2), an: round_(fc.an / total, 2), nurse: round_(fc.nurse / total, 2) },
    todayStaff: { pat: t.pat, doc: t.doc, rn: t.rn, an: t.an, nurse: t.nurse },
    result: g, actualResult: ga,
    plan: {
      doc: plan('doc', 'DOC_Q', cfg.targetDoc, act.doc, fc.doc, t.doc),
      rn: plan('rn', 'RN_Q', cfg.targetRn, act.rn, fc.rn, t.rn),
      nurse: plan('nurse', 'NURSE_Q', cfg.targetNurse, act.nurse, fc.nurse, t.nurse)
    }
  };
}

/* ---------- 일자별 추이 ---------- */
function computeTrend_(S, start, end, todayKey) {
  var last = todayKey < end ? todayKey : end, out = [];
  for (var k = start; k <= last; k = addDays_(k, 1)) {
    var p = S.pat[k], rn = S.rn[k] || 0, an = S.an[k] || 0, d = S.doc[k] || 0;
    if (p === undefined) continue;
    out.push({ d: k, pat: p, rn: rn, an: an, doc: d,
      rnR: round_(safeDiv_(p, rn), 2), nuR: round_(safeDiv_(p, rn + an), 2), docR: round_(safeDiv_(p, d), 2) });
  }
  return out;
}

/* ---------- 기간 프리셋 ---------- */
/** 차등제 분기 산정기간: 직전분기 마지막달 15일 ~ 해당분기 마지막달 14일 */
function quarterPeriod_(todayKey) {
  var y = +todayKey.slice(0, 4), m = +todayKey.slice(5, 7), d = +todayKey.slice(8, 10);
  var ends = [3, 6, 9, 12], endM = null, endY = y;
  for (var i = 0; i < 4; i++) if (m < ends[i] || (m === ends[i] && d <= 14)) { endM = ends[i]; break; }
  if (endM === null) { endM = 3; endY = y + 1; }
  var sM = endM - 3, sY = endY; if (sM <= 0) { sM += 12; sY -= 1; }
  return { start: sY + '-' + pad2_(sM) + '-15', end: endY + '-' + pad2_(endM) + '-14' };
}

/* ---------- 권한 · 필터 · 종합 (Code.gs에서 발췌) ---------- */
function perm_(u, hospList) {
  var all = hospList.map(function (h) { return h.code; });
  var wide = u.role === '시스템관리자' || u.role === '종합관리자';
  var mine = u.hosp.split(/[,\s]+/).filter(function (x) { return all.indexOf(x) >= 0; });
  var p = {
    role: u.role,
    hospitals: wide || u.hosp === '전체' ? all : mine,
    combined: wide,
    settings: u.role === '시스템관리자',
    sections: { doctor: true, nurse: true },
    wards: null
  };
  if (u.role === '부서사용자') {
    if (/간호/.test(u.affil)) p.sections = { doctor: false, nurse: true };
    else if (/진료|의국|의료진/.test(u.affil)) p.sections = { doctor: true, nurse: false };
    if (u.dept && u.dept !== '전체') p.wards = u.dept.split(/[,\s]+/).filter(String);
  }
  return p;
}

function filterByPerm_(h, p) {
  function strip(o, keys) { keys.forEach(function (k) { if (o && k in o) o[k] = null; }); }
  var docKeys = ['doc'], nurseKeys = ['rn', 'an', 'nurse'];
  [h.today, h.period.todayStaff, h.period.actual, h.period.forecast, h.period.avg].forEach(function (o) {
    if (!p.sections.doctor) strip(o, docKeys);
    if (!p.sections.nurse) strip(o, nurseKeys);
  });
  [h.today, h.period.result, h.period.actualResult].forEach(function (g) {
    if (!g) return;
    if (!p.sections.doctor) { strip(g.ratio, ['doc']); strip(g.score, ['doc']); g.docGrade = null; }
    if (!p.sections.nurse) { strip(g.ratio, ['rn', 'nurse']); strip(g.score, ['rn', 'nurse']); g.nurseGrade = null; g.rnShare = null; g.rnShareNote = ''; }
  });
  if (!p.sections.doctor) h.period.plan.doc = null;
  if (!p.sections.nurse) { h.period.plan.rn = null; h.period.plan.nurse = null; h.today.wards = []; }
  if (p.wards) h.today.wards = h.today.wards.filter(function (w) {
    return p.wards.some(function (x) { return w.ward === x || w.ward.indexOf(x) === 0; });
  });
  h.trend = h.trend.map(function (d) {
    return { d: d.d, pat: d.pat, rnR: p.sections.nurse ? d.rnR : null, nuR: p.sections.nurse ? d.nuR : null, docR: p.sections.doctor ? d.docR : null };
  });
  h.sections = p.sections;
  return h;
}

function combine_(list) {
  var t = { pat: 0, doc: 0, rn: 0, an: 0 }, f = { pat: 0, doc: 0, rn: 0, an: 0 };
  list.forEach(function (h) {
    ['pat', 'doc', 'rn', 'an'].forEach(function (k) { t[k] += h.today[k] || 0; f[k] += h.period.forecast[k] || 0; });
  });
  function r(a, b) { return b ? round_(a / b, 2) : null; }
  return {
    today: { pat: t.pat, doc: t.doc, rn: t.rn, an: t.an, nurse: t.rn + t.an,
      ratio: { doc: r(t.pat, t.doc), rn: r(t.pat, t.rn), nurse: r(t.pat, t.rn + t.an) } },
    period: { ratio: { doc: r(f.pat, f.doc), rn: r(f.pat, f.rn), nurse: r(f.pat, f.rn + f.an) } },
    ranking: list.map(function (h) { return { code: h.code, name: h.name, total: h.period.result.total, maxTotal: h.period.result.maxTotal }; })
      .sort(function (a, b) { return b.total - a.total; })
  };
}

/** 부서사용자: 소속(간호/진료) 및 부서(병동) 범위만 남김 */

/* ---------- 설정 행(시트 형식) → 기준 구간 객체 ---------- */
/** rows: [[지표코드, 지표명, 순번, 표시, 점수, 하한, 상한, 경계방식, 비고], ...] */
function critFromRows(rows, opt) {
  var c = {};
  (rows || []).forEach(function (r) {
    var k = String(r[0]).trim(); if (!k) return;
    (c[k] = c[k] || []).push({ order: num_(r[2]), label: String(r[3]), score: num_(r[4]),
      min: r[5] === '' || r[5] === null ? '' : num_(r[5]), max: r[6] === '' || r[6] === null ? '' : num_(r[6]),
      mode: String(r[7] || '이상미만').trim(), note: String(r[8] || '') });
  });
  Object.keys(c).forEach(function (k) { c[k].sort(function (a, b) { return a.order - b.order; }); });
  c._opt = { RN_SHARE_BONUS: (opt && num_(opt.RN_SHARE_BONUS)) || 66.7, RN_SHARE_PENALTY: (opt && num_(opt.RN_SHARE_PENALTY)) || 33.3 };
  return c;
}

/* ---------- 순수 예측 공식 (집계값 입력) ---------- */
/**
 * 시계열 없이 집계값만으로 결과예측계산기를 재현합니다. (설계서 7장 공식)
 * inp = { totalDays, elapsedDays, actual:{pat,doc,rn,an}, today:{pat,doc,rn,an}, target:{doc,rn,nurse} }
 */
function forecastFromAggregates(inp, crit) {
  var R = inp.totalDays - inp.elapsedDays, A = inp.actual, T = inp.today;
  var fc = { pat: A.pat + T.pat * R, doc: A.doc + T.doc * R, rn: A.rn + T.rn * R, an: A.an + T.an * R };
  fc.nurse = fc.rn + fc.an;
  var g = grades_(crit, fc.pat, fc.doc, fc.rn, fc.an, null);
  function plan(key, bandKey, target, actStaff, fcStaff, todayStaff) {
    var band = (crit[bandKey] || []).filter(function (b) { return String(b.score) === String(target); })[0];
    var bound = band ? band.max : null, need = (fc.pat / bound - actStaff) / R;
    return { target: target, bound: bound, expected: g.score[key], minNeeded: round_(need, 2),
      shortage: round_(Math.max(0, need - todayStaff), 2), adjPatDays: Math.round(fcStaff * bound - A.pat),
      adjPatAvg: round_((fcStaff * bound - A.pat) / R, 2) };
  }
  return {
    forecast: fc,
    avg: { pat: round_(fc.pat / inp.totalDays, 2), doc: round_(fc.doc / inp.totalDays, 2), rn: round_(fc.rn / inp.totalDays, 2), nurse: round_(fc.nurse / inp.totalDays, 2) },
    ratio: g.ratio, score: g.score,
    plan: {
      doc: plan('doc', 'DOC_Q', inp.target.doc, A.doc, fc.doc, T.doc),
      rn: plan('rn', 'RN_Q', inp.target.rn, A.rn, fc.rn, T.rn),
      nurse: plan('nurse', 'NURSE_Q', inp.target.nurse, A.rn + A.an, fc.nurse, T.rn + T.an)
    }
  };
}

/* ---------- 대시보드 1회 호출 (운영 api_dashboard와 동일 응답) ---------- */
/**
 * opts = { data: sample-data.json 객체, userEmail, start, end, today? }
 * 반환: { ok, user, perm, hospitals:[{code,name,targets,pharmRate,today,period,trend,sections}], combined?, criteria }
 */
function buildDashboard(opts) {
  var d = opts.data, today = opts.today || d.meta.today;
  var user = findUser(d, opts.userEmail);
  if (!user) return { ok: false, error: 'AUTH', message: '등록되지 않았거나 사용중지된 사용자입니다.' };
  var hosp = d.hospitals.filter(function (h) { return String(h.active).toUpperCase() !== 'N'; });
  var crit = critFromRows(d.criteriaRows, d.config);
  var p = perm_(user, hosp);
  var start = dkey_(opts.start), end = dkey_(opts.end);
  if (!start || !end || start > end) return { ok: false, error: 'PERIOD', message: '기간을 확인해 주세요.' };
  if (daysBetween_(start, end) > 400) return { ok: false, error: 'PERIOD', message: '조회 기간은 400일 이내로 설정해 주세요.' };
  var out = { ok: true, today: today, start: start, end: end, user: user, perm: p, hospitals: [] };
  hosp.forEach(function (cfg) {
    if (p.hospitals.indexOf(cfg.code) < 0) return;
    var S = d.series[cfg.code];
    if (!S) return;
    var h = JSON.parse(JSON.stringify({
      code: cfg.code, name: cfg.name,
      targets: { doc: cfg.targetDoc, rn: cfg.targetRn, nurse: cfg.targetNurse }, pharmRate: cfg.pharmRate,
      today: computeToday_(S, crit, cfg, today),
      period: computePeriod_(S, crit, cfg, start, end, today),
      trend: computeTrend_(S, start, end, today)
    }));
    out.hospitals.push(filterByPerm_(h, p));
  });
  if (p.combined) out.combined = combine_(out.hospitals);
  out.criteria = { DOC_Q: crit.DOC_Q, RN_Q: crit.RN_Q, NURSE_Q: crit.NURSE_Q, PHARM_Q: crit.PHARM_Q, NURSE_GRADE: crit.NURSE_GRADE, DOC_GRADE: crit.DOC_GRADE };
  return out;
}
function findUser(d, email) {
  email = String(email || '').trim().toLowerCase();
  var roles = ['시스템관리자', '종합관리자', '기관관리자', '부서사용자'];
  var u = (d.users || []).filter(function (x) {
    return String(x.email).toLowerCase() === email && String(x.active).toUpperCase() !== 'N' && roles.indexOf(x.role) >= 0;
  })[0];
  return u ? { email: u.email, name: u.name, role: u.role, hosp: u.hosp, affil: u.affil, dept: u.dept } : null;
}
function periodPresets(data) {
  var t = data.meta.today, q = quarterPeriod_(t);
  return {
    eval: { start: data.config.EVAL_START || q.start, end: data.config.EVAL_END || q.end, label: '적정성평가 기간' },
    quarter: { start: q.start, end: q.end, label: '차등제 분기' }
  };
}

/* ---------- 관리자 저장 전 검증 (운영 api_adminSave와 동일 규칙) ---------- */
function validateAdminSave(which, rows) {
  var roles = ['시스템관리자', '종합관리자', '기관관리자', '부서사용자'];
  if (which === 'USERS') {
    for (var i = 0; i < rows.length; i++) if (roles.indexOf(String(rows[i][2]).trim()) < 0) return '권한등급 오류: ' + rows[i][0];
    if (!rows.some(function (r) { return r[2] === '시스템관리자' && String(r[6]).toUpperCase() !== 'N'; })) return '활성 시스템관리자가 최소 1명 필요합니다.';
  }
  if (which === 'CRIT') for (var j = 0; j < rows.length; j++)
    if (!/^(DOC_Q|RN_Q|NURSE_Q|PHARM_Q|NURSE_GRADE|DOC_GRADE)$/.test(String(rows[j][0]).trim())) return '지표코드 오류: ' + rows[j][0];
  return null;   // 통과
}

/* ---------- 자체 검증: 실제 시트(1병원, 2026-06-15~12-14, 오늘 09-23) ---------- */
var GOLDEN = {
  input: { totalDays: 183, elapsedDays: 101,
    actual: { pat: 32540, doc: 980, rn: 3143, an: 3571 },
    today: { pat: 325, doc: 10, rn: 38, an: 41 },
    target: { doc: 6.8, rn: 6.8, nurse: 4.5 } },
  expect: {   // 시트 [결과예측계산기] 표시값
    'forecast.doc': 1800, 'forecast.rn': 6259, 'forecast.nurse': 13192, 'forecast.pat': 59190,
    'avg.pat': 323.44, 'avg.doc': 9.84, 'avg.rn': 34.2, 'avg.nurse': 72.09,
    'ratio.doc': 32.88, 'ratio.rn': 9.46, 'ratio.nurse': 4.49,
    'score.doc': 5.1, 'score.rn': 5.1, 'score.nurse': 4.5,
    'plan.doc.minNeeded': 12.11, 'plan.rn.minNeeded': 41.87,
    'plan.doc.adjPatDays': 21460, 'plan.rn.adjPatDays': 23791, 'plan.nurse.adjPatDays': 33420,
    'plan.doc.adjPatAvg': 261.71, 'plan.rn.adjPatAvg': 290.13, 'plan.nurse.adjPatAvg': 407.56
  }
};
function selfTest(criteriaRows) {
  var crit = critFromRows(criteriaRows || DEFAULT_CRITERIA_ROWS);
  var r = forecastFromAggregates(GOLDEN.input, crit), res = [], pass = true;
  Object.keys(GOLDEN.expect).forEach(function (k) {
    var v = k.split('.').reduce(function (o, p) { return o && o[p]; }, r), ok = v === GOLDEN.expect[k];
    if (!ok) pass = false; res.push({ key: k, expected: GOLDEN.expect[k], actual: v, ok: ok });
  });
  return { pass: pass, results: res };
}

/* 기본 평가기준 (운영 ⚙️앱_평가기준 시트 초기값과 동일) */
var DEFAULT_CRITERIA_ROWS = [
  ['DOC_Q','적정성평가 의사1인당 환자수',1,'8.5',8.5,0,26,'이상미만',''],['DOC_Q','적정성평가 의사1인당 환자수',2,'6.8',6.8,26,30,'이상미만',''],
  ['DOC_Q','적정성평가 의사1인당 환자수',3,'5.1',5.1,30,34,'이상미만',''],['DOC_Q','적정성평가 의사1인당 환자수',4,'3.4',3.4,34,38,'이상미만',''],
  ['DOC_Q','적정성평가 의사1인당 환자수',5,'1.7',1.7,38,'','이상미만',''],
  ['RN_Q','적정성평가 간호사1인당 환자수',1,'8.5',8.5,0,6,'이상미만',''],['RN_Q','적정성평가 간호사1인당 환자수',2,'6.8',6.8,6,9,'이상미만',''],
  ['RN_Q','적정성평가 간호사1인당 환자수',3,'5.1',5.1,9,12,'이상미만',''],['RN_Q','적정성평가 간호사1인당 환자수',4,'3.4',3.4,12,15,'이상미만',''],
  ['RN_Q','적정성평가 간호사1인당 환자수',5,'1.7',1.7,15,'','이상미만',''],
  ['NURSE_Q','적정성평가 간호인력1인당 환자수',1,'7.5',7.5,0,3,'이상미만',''],['NURSE_Q','적정성평가 간호인력1인당 환자수',2,'6',6,3,4,'이상미만',''],
  ['NURSE_Q','적정성평가 간호인력1인당 환자수',3,'4.5',4.5,4,5,'이상미만',''],['NURSE_Q','적정성평가 간호인력1인당 환자수',4,'3',3,5,6,'이상미만',''],
  ['NURSE_Q','적정성평가 간호인력1인당 환자수',5,'1.5',1.5,6,'','이상미만',''],
  ['PHARM_Q','적정성평가 약사 재직일수율(%)',1,'5.5',5.5,100,'','이상미만',''],['PHARM_Q','적정성평가 약사 재직일수율(%)',2,'4.4',4.4,80,100,'이상미만',''],
  ['PHARM_Q','적정성평가 약사 재직일수율(%)',3,'3.3',3.3,60,80,'이상미만',''],['PHARM_Q','적정성평가 약사 재직일수율(%)',4,'2.2',2.2,40,60,'이상미만',''],
  ['PHARM_Q','적정성평가 약사 재직일수율(%)',5,'1.1',1.1,0,40,'이상미만',''],
  ['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',1,'1등급',1,0,4.5,'이상미만','60% 가산'],['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',2,'2등급',2,4.5,5.0,'이상미만','50% 가산'],
  ['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',3,'3등급',3,5.0,5.5,'이상미만','35% 가산'],['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',4,'4등급',4,5.5,6.0,'이상미만','20% 가산'],
  ['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',5,'5등급',5,6.0,6.5,'이상미만','기준등급(가·감산 없음)'],['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',6,'6등급',6,6.5,7.5,'이상미만','20% 감산'],
  ['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',7,'7등급',7,7.5,9.0,'이상미만','35% 감산'],['NURSE_GRADE','간호인력 차등제 등급(환자:간호인력)',8,'8등급',8,9.0,'','이상미만','50% 감산'],
  ['DOC_GRADE','의사인력 차등제 등급(환자:의사)',1,'1등급',1,0,35,'초과이하','전문의 50% 이상 20% 가산 / 미만 10% 가산'],['DOC_GRADE','의사인력 차등제 등급(환자:의사)',2,'2등급',2,35,40,'초과이하','기준등급(가·감산 없음)'],
  ['DOC_GRADE','의사인력 차등제 등급(환자:의사)',3,'3등급',3,40,50,'초과이하','15% 감산'],['DOC_GRADE','의사인력 차등제 등급(환자:의사)',4,'4등급',4,50,60,'초과이하','30% 감산'],
  ['DOC_GRADE','의사인력 차등제 등급(환자:의사)',5,'5등급',5,60,'','초과이하','50% 감산']
];

return {
  version: '1.0',
  // 데이터 준비
  buildSeries: buildSeries_, critFromRows: critFromRows, DEFAULT_CRITERIA_ROWS: DEFAULT_CRITERIA_ROWS,
  // 계산
  computeToday: computeToday_, computePeriod: computePeriod_, computeTrend: computeTrend_,
  forecastFromAggregates: forecastFromAggregates, grades: grades_, matchBand: matchBand_,
  quarterPeriod: quarterPeriod_, periodPresets: periodPresets,
  // 권한
  findUser: findUser, permissions: perm_, filterByPerm: filterByPerm_, combine: combine_,
  // 통합
  buildDashboard: buildDashboard, validateAdminSave: validateAdminSave,
  // 유틸
  util: { dkey: dkey_, addDays: addDays_, daysBetween: daysBetween_, round: round_, num: num_ },
  selfTest: selfTest, GOLDEN: GOLDEN
};
});
