/* =====================================================================
   다우세라믹앤석재 통합관리 — 앱 로직
   - Firebase 설정이 있으면: 클라우드 실시간 동기화(모든 기기 공유)
   - 설정이 비어있으면: 이 기기에서만 저장(미리보기 모드)
   ===================================================================== */

/* ---------- 0. 저장소(Store) : 클라우드/로컬 공통 인터페이스 ----------
   - firebase-config.js 가 있으면 window.FIREBASE_CONFIG 사용 → 클라우드 실시간 공유
   - 없으면 이 기기에만 저장(미리보기)
   - 데이터는 teams/{TEAM} 아래에 저장 (기존 Firestore 보안규칙과 호환) */
const FBCONF = (typeof window !== 'undefined' && window.FIREBASE_CONFIG) ? window.FIREBASE_CONFIG
  : (typeof FIREBASE_CONFIG !== 'undefined' ? FIREBASE_CONFIG : { apiKey: "" });
const CLOUD = !!(FBCONF && FBCONF.apiKey);
const TEAM = 'dawoo';
let db = null, auth = null;
if (CLOUD) {
  firebase.initializeApp(FBCONF);
  db = firebase.firestore();
  auth = firebase.auth();
  // 같은 기기에서 자동 로그인 유지(LOCAL): 로그아웃 전까지 세션 보관
  try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) { }
}
/* 저장해 둔 이메일을 로그인칸에 미리 채우기 */
function prefillEmail() {
  const saved = (() => { try { return localStorage.getItem('dws_email') || ''; } catch (e) { return ''; } })();
  const ei = el('lg-email'), ck = el('lg-remember');
  if (ei && saved) ei.value = saved;
  if (ck) ck.checked = !!saved;
}
function cref(name) { return db.collection('teams').doc(TEAM).collection(name); }

const COLLS = ['members', 'sites', 'inventory', 'holdings', 'transactions', 'specs', 'factories', 'teams', 'suppliers', 'clients', 'issues', 'restocks', 'basins', 'holdRequests', 'shipments', 'chulgoReqs', 'chulgoHandlers', 'quotes', 'clientPrices', 'priceList', 'appmeta', 'expenses'];
const CTYPES = ['유통', '대리점', '인테리어', '소비자', '별도'];   // 거래처 유형 (별도 = 예외 업체 단가)
function ctypeKey(t) { return t === '유통' ? 'dist' : (t === '대리점' ? 'agency' : (t === '인테리어' ? 'interior' : (t === '별도' ? 'special' : 'consumer'))); }
const QCATS = ['세라믹+세면대', '석재', '통관비용'];
const CUSTOMS_LINES = ['관세', '부가가치세', '지원가산세', '통관수수료', 'D/O CHG (선사비용)', '적출료', 'SHUTTLE CHG', '경과보관료', '제주선임', '운송료', '취급수수료', '기타경비'];
function itemCategory(name) {
  const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(name));
  if (pl && pl.cat) return pl.cat;
  const t = (name || '').replace(/\s/g, '');
  if (/통관|관세|clearance/i.test(t)) return '통관비용';
  if (/석재|대리석|화강|천연석|현무암|점판암/i.test(t)) return '석재';
  return '세라믹+세면대';
}
async function saveItemCat(name, cat) { const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(name)); if (pl) await Store.update('priceList', pl.id, { cat: cat }); else await Store.add('priceList', { itemName: name, cat: cat, dist: 0, agency: 0, interior: 0, consumer: 0 }); }

// 로컬(미리보기) 모드용 - 같은 기기의 다른 탭끼리 실시간 반영
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('dws') : null;

const Store = {
  _watchers: {},
  read(coll) {
    try { return JSON.parse(localStorage.getItem('dws_' + coll) || '[]'); }
    catch (e) { return []; }
  },
  _writeLocal(coll, arr) {
    localStorage.setItem('dws_' + coll, JSON.stringify(arr));
    if (bc) bc.postMessage(coll);
  },
  watch(coll, cb) {
    if (CLOUD) {
      cref(coll).onSnapshot(snap => {
        cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data())));
      }, err => console.warn('snapshot', coll, err));
    } else {
      this._watchers[coll] = cb;
      cb(this.read(coll));
    }
  },
  async add(coll, obj) {
    obj.createdAt = Date.now();
    if (CLOUD) { await cref(coll).add(obj); }
    else {
      const arr = this.read(coll);
      obj.id = 'L' + Date.now() + Math.floor(Math.random() * 1000);
      arr.push(obj); this._writeLocal(coll, arr);
      if (this._watchers[coll]) this._watchers[coll](arr);
    }
  },
  async update(coll, id, obj) {
    if (CLOUD) { await cref(coll).doc(id).update(obj); }
    else {
      const arr = this.read(coll);
      const i = arr.findIndex(x => x.id === id);
      if (i >= 0) { Object.assign(arr[i], obj); this._writeLocal(coll, arr); if (this._watchers[coll]) this._watchers[coll](arr); }
    }
  },
  async remove(coll, id) {
    if (CLOUD) { await cref(coll).doc(id).delete(); }
    else {
      let arr = this.read(coll).filter(x => x.id !== id);
      this._writeLocal(coll, arr); if (this._watchers[coll]) this._watchers[coll](arr);
    }
  },
  /* 지정 문서 id로 병합 업서트(다른 앱이 써넣은 필드는 보존) — 연동 브릿지용 */
  async setMerge(coll, id, obj) {
    if (CLOUD) { await cref(coll).doc(id).set(obj, { merge: true }); }
    else {
      const arr = this.read(coll); const i = arr.findIndex(x => x.id === id);
      if (i >= 0) Object.assign(arr[i], obj); else arr.push(Object.assign({ id }, obj));
      this._writeLocal(coll, arr); if (this._watchers[coll]) this._watchers[coll](arr);
    }
  }
};
if (bc) bc.onmessage = (e) => { const c = e.data; if (Store._watchers[c]) Store._watchers[c](Store.read(c)); };

/* ---------- 1. 전역 상태 ---------- */
const state = { members: [], sites: [], inventory: [], holdings: [], transactions: [], specs: [], factories: [], teams: [], suppliers: [], clients: [], issues: [], restocks: [], basins: [], holdRequests: [], shipments: [], chulgoReqs: [] };
let me = null;          // 로그인한 사용자
let tab = 'home';
let filters = { sites: 'all', stock: 'all', stockSearch: '', siteSearch: '', siteSearchField: 'all', holdArchive: false, holdDone: false, holdSearch: '', holdGroup: 'none', custSearch: '', shipSearch: '', basinSearch: '' };
let _holdLinkSite = null;   // 현장 저장 시 이 홀딩을 현장에 '연결'(소진 아님)
let _holdConfirm = null;    // 출고 저장 시 이 홀딩을 '확정' 처리
let _busy = false;          // 등록 버튼 연속 클릭(중복 저장) 방지
function openStockTab(filter) { filters.stock = filter || 'all'; filters.stockSearch = ''; go('stock'); }

/* ---------- 2. 유틸 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => (n || 0).toLocaleString('ko-KR');
const todayStr = () => new Date().toISOString().slice(0, 10);
function daysFromNow(d) { if (!d) return null; return Math.ceil((new Date(d + 'T00:00') - new Date(todayStr() + 'T00:00')) / 86400000); }
function initial(n) { return (n || '?').trim().slice(-2); }
function toast(msg) { const t = el('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }
function isAdmin() { return me && me.role === 'admin'; }
function isCustomerRole() { return me && me.role === 'customer'; }  // 고객(거래처) — 재고 조회 전용
function isCrewRole() { return me && me.role === 'crew'; }  // 시공팀 — 자기 시공 스케줄만
function isRestrictedRole() { return isCustomerRole() || isCrewRole(); }
/* ===== 메뉴 접근 권한 (직원별) ===== */
const TAB_LABELS = { home: '홈', sites: '현장', stock: '재고·입고', ship: '출고', chulgo: '출고관리', hold: '홀딩', basin: '세면대 발주', quote: '견적서', clients: '거래처', settle: '정산', settings: '설정' };
const TAB_ICONS = { sites: 'ti-building-community', stock: 'ti-packages', ship: 'ti-truck-delivery', chulgo: 'ti-clipboard-list', hold: 'ti-lock-square-rounded', basin: 'ti-bath', quote: 'ti-file-invoice', clients: 'ti-users', settle: 'ti-report-money' };
function menuPermAll(on) { document.querySelectorAll('.m-menu').forEach(c => { c.checked = !!on; }); }
const ALL_TABS = ['home', 'sites', 'stock', 'ship', 'chulgo', 'hold', 'basin', 'quote', 'clients', 'settle', 'settings'];
const ALWAYS_TABS = ['home', 'settings'];
const RESTRICTED_TABS = ['settle'];
function liveMe() { if (!me) return null; return (state.members || []).find(x => (x.email || '').toLowerCase() === (me.email || '').toLowerCase()) || me; }
function allowedTabs() {
  if (isAdmin()) return ALL_TABS.slice();
  const lm = liveMe() || {};
  const set = Array.isArray(lm.menus) ? lm.menus.slice() : ALL_TABS.filter(t => !RESTRICTED_TABS.includes(t));
  return ALL_TABS.filter(t => ALWAYS_TABS.includes(t) || set.includes(t));
}
function tabAllowed(t) { return allowedTabs().includes(t); }
function applyMenuPerms() {
  if (isRestrictedRole()) return;
  const allow = allowedTabs();
  document.querySelectorAll('.nav-i[data-tab],.side-i[data-tab],.drawer-i[data-tab]').forEach(b => { b.style.display = allow.includes(b.dataset.tab) ? '' : 'none'; });
}

/* 공장명 통일 규칙: 포함하면 대표명으로 정규화 */
const FACTORY_RULES = [['토마스', '동양'], ['동호', '동호엠엔지'], ['거봉', '거봉석재'], ['영진', '영진석재']];
function normFactory(name) { const n = String(name == null ? '' : name).trim(); if (!n) return n; for (const r of FACTORY_RULES) { if (n.includes(r[0])) return r[1]; } return n; }
/* 대한민국 법정공휴일(대체공휴일·명절 포함) — 인사혁신처 고시 기준(2026~2027) */
const HOLIDAYS = {
  '2026-01-01': '신정', '2026-02-16': '설날', '2026-02-17': '설날', '2026-02-18': '설날', '2026-03-01': '삼일절', '2026-03-02': '대체휴일', '2026-05-01': '근로자의날', '2026-05-05': '어린이날', '2026-05-24': '부처님오신날', '2026-05-25': '대체휴일', '2026-06-06': '현충일', '2026-07-17': '제헌절', '2026-08-15': '광복절', '2026-08-17': '대체휴일', '2026-09-24': '추석', '2026-09-25': '추석', '2026-09-26': '추석', '2026-10-03': '개천절', '2026-10-05': '대체휴일', '2026-10-09': '한글날', '2026-12-25': '성탄절',
  '2027-01-01': '신정', '2027-02-06': '설날', '2027-02-07': '설날', '2027-02-08': '설날', '2027-02-09': '대체휴일', '2027-03-01': '삼일절', '2027-05-01': '근로자의날', '2027-05-05': '어린이날', '2027-05-13': '부처님오신날', '2027-06-06': '현충일', '2027-07-17': '제헌절', '2027-08-15': '광복절', '2027-08-16': '대체휴일', '2027-09-14': '추석', '2027-09-15': '추석', '2027-09-16': '추석', '2027-10-03': '개천절', '2027-10-04': '대체휴일', '2027-10-09': '한글날', '2027-10-11': '대체휴일', '2027-12-25': '성탄절', '2027-12-27': '대체휴일'
};

const STATUS = {
  접수: 'p-gray', 견적전달: 'p-wait', 결제완료: 'p-prog', 확정: 'p-prog',
  실측대기: 'p-wait', 발주완료: 'p-prog', 가공중: 'p-prog', 시공대기: 'p-wait',
  시공중: 'p-prog', 완료: 'p-done', 보류: 'p-issue', 이슈: 'p-issue'
};
function pill(s) { return `<span class="pill ${STATUS[s] || 'p-gray'}">${esc(s || '-')}</span>`; }

/* ---------- 3. 매뉴얼 기반 자동추천 ---------- */
// 시공·발주 시스템 매뉴얼 v3.0 규칙
const METRO = ['서울', '경기', '인천'];           // 수도권 판별(주소 앞부분)
const TOMAS_STOCK = ['로마 팬텀 아이보리', '카무스 화이트', '트라버티노 아이보리'];

function recommendTeam(o) {
  // o: { region, address, constructionDate, jang, volume, workType }
  const addr = (o.address || '') + (o.region || '');
  const metro = METRO.some(m => addr.includes(m));
  if (!metro) {
    if (addr.includes('대전')) return { team: '록스타일', why: '대전 지역 담당' };
    if (addr.includes('부산')) return { team: '프로세라믹', why: '부산 지역 담당' };
    if (addr.includes('광주') || addr.includes('전남')) return { team: '현대코리안', why: '광주·전남 지역 담당' };
    if (addr.includes('시흥') || addr.includes('인천')) return { team: '아트라인', why: '시흥·인천 지역 담당' };
    return { team: '지역팀 확인 필요', why: '비수도권 — 해당 지역 협력팀 확인' };
  }
  const dleft = daysFromNow(o.constructionDate);
  if (dleft != null && dleft <= 3) return { team: 'JS테크', why: '긴급 일정(시공까지 3일 이하)' };
  if (o.workType === '세면대단독') return { team: 'JS테크', why: '세면대 단독 시공' };
  if (o.workType === '현장가공많음') return { team: '모든대리석', why: '현장 재단·타공 등 작업량 많음' };
  if (o.jang > 2700) {
    if (o.volume === '대형') return { team: '모든대리석', why: '기장 2700 초과 · 대형 물량(3~4인 이상)' };
    return { team: 'JS테크', why: '기장 2700 초과 · 소형 물량' };
  }
  return { team: 'JS테크', why: '기본 배정(B/D 조건)' };
}
function recommendFactory(o) {
  // o: { dueDate, materialName, complex(졸리컷많음/유광), simpleTop }
  const dleft = daysFromNow(o.dueDate);
  if (dleft != null && dleft <= 2) {
    if (o.complex) return { factory: '거봉석재', why: '긴급 납기(2일 이하) — 단, 졸리컷 많음/유광이면 동호엠엔지 일정 먼저 확인' };
    return { factory: '거봉석재', why: '긴급 납기(2일 이하)' };
  }
  if (o.simpleTop) return { factory: '영진석재', why: '단순 상판(졸리컷 없는 식탁·주방 상판)' };
  if (TOMAS_STOCK.some(t => (o.materialName || '').includes(t))) return { factory: '토마스 마블', why: '토마스 재고 운영 자재' };
  if (o.materialName) return { factory: '동호엠엔지', why: '토마스 미운영 자재(3일 이상 납기)' };
  return { factory: '동호엠엔지', why: '기본 배정' };
}
// 견적 도우미 (일반소비자·도면 있음 기준)
function estimateQuote(o) {
  // o:{ hebe, jang, region, allMarble }
  const hebe = +o.hebe || 0, jang = +o.jang || 0;
  const gagong = jang * 500000;                 // 가공비 장당 50만
  const measure = 250000;                        // 실측 25만
  let construct = o.allMarble ? (jang * 400000 + 100000) : (hebe * 100000 + 250000); // 시공: 모든대리석=품당40만+10만 / 기본 헤베10만 + 여유25만
  const local = METRO.some(m => (o.region || '').includes(m)) ? 0 : 200000; // 지방 출장비(예시)
  const total = gagong + measure + construct + local;
  return { gagong, measure, construct, local, total };
}

/* ---------- 4. 초기 구동 ---------- */
window.addEventListener('DOMContentLoaded', init);
let _subscribed = false;
function startSubscriptions() {
  if (_subscribed) return; _subscribed = true;
  COLLS.forEach(c => Store.watch(c, data => { state[c] = data; onData(c); }));
  loadAppConfig();   // 출고관리 연동 수신 주소 로드
}
function init() {
  if (!CLOUD) {
    // 미리보기(로컬) 모드: 인증 없이 이 기기에서만 동작
    el('sync').classList.add('local'); el('sync-t').textContent = '미리보기';
    startSubscriptions();
    seedIfEmpty();
    prefillEmail();
    return;
  }
  // 클라우드 모드: Firebase 인증으로 보호 — 로그인해야만 데이터에 접근 가능
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      await afterAuth(user);   // 역할 판별 후 역할별로 구독(고객은 재고+본인홀딩만)
    } else {
      me = null;
      document.body.classList.remove('cust-mode');
      el('app').style.display = 'none';
      el('login').style.display = 'flex';
      const e = el('login-err'); if (e) { e.style.color = ''; e.textContent = ''; }
      prefillEmail();
    }
  });
}
/* 로그인 성공 후: 직원 디렉터리에서 본인(이메일) 찾기 → 앱 진입 */
async function afterAuth(user) {
  const _email = (user.email || '').toLowerCase();
  // 고객(거래처) 우선 확인 — 직원 목록을 읽지 않고 '본인 역할 문서(roles/이메일)'만 확인
  if (CLOUD) {
    try {
      const rd = await cref('roles').doc(_email).get();
      const _r = rd.exists ? ((rd.data() || {}).role) : '';
      if (_r === 'customer' || _r === 'crew') {
        me = { name: (rd.data().name || _email.split('@')[0]), email: _email, role: _r };
        el('login').style.display = 'none';
        el('app').style.display = 'block';
        el('me-av').textContent = initial(me.name);
        el('me-nm').textContent = me.name;
        document.body.classList.add('cust-mode');
        if (_r === 'customer') startCustomerSubs(); else startCrewSites();
        go('stock');
        return;
      }
    } catch (e) { /* 역할 문서 읽기 실패 → 일반(직원) 흐름으로 진행 */ }
  }
  startSubscriptions();          // 직원/관리자: 전체 컬렉션 구독
  seedIfEmpty();                 // 규격/공장/팀 등 기본값(백그라운드)
  await whenMembersReady();       // 직원 목록 첫 로딩 대기
  let member = findMemberByEmail(user.email);
  if (!member) {
    // 이메일이 연결된 직원이 한 명도 없으면, 첫 로그인자를 관리자로 부트스트랩
    const anyLinked = state.members.some(m => m.email);
    const role = anyLinked ? 'staff' : 'admin';
    const name = (user.email || '사용자').split('@')[0];
    member = { name, email: (user.email || '').toLowerCase(), role };
    await Store.add('members', member);
  }
  me = member;
  el('login').style.display = 'none';
  el('app').style.display = 'block';
  el('me-av').textContent = initial(me.name);
  el('me-nm').textContent = me.name;
  document.body.classList.toggle('cust-mode', isRestrictedRole());  // 고객·시공팀: 전용 UI
  if (isRestrictedRole()) { go('stock'); }
  else { ensureStaffRoles(); render(); applyMenuPerms(); refreshPushToken(); }
}
/* 직원/관리자 권한 문서(roles/{이메일}) 자동 생성·동기화 — '승인된 직원만' 보안규칙용.
   관리자가 로그인하면 전 직원 roles 문서를 한 번에 생성(마이그레이션). */
async function ensureStaffRoles() {
  if (!CLOUD || !me || !me.email || me.role === 'customer') return;
  try {
    await cref('roles').doc(me.email.toLowerCase()).set({ role: me.role || 'staff', name: me.name || '' }, { merge: true });
    if (me.role === 'admin') {
      for (const m of state.members) {
        if (!m.email) continue;
        try { await cref('roles').doc(m.email.toLowerCase()).set({ role: m.role || 'staff', name: m.name || '' }, { merge: true }); } catch (e) { }
      }
    }
  } catch (e) { console.warn('ensureStaffRoles', e); }
}
/* 관리자용: members 전체를 roles 문서로 확실히 동기화(보안규칙 적용 전 1회 실행) */
async function syncAllRolesNow() {
  if (!CLOUD) { toast('클라우드 모드에서만 가능합니다'); return; }
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  let n = 0, skip = 0;
  for (const m of state.members) {
    if (!m.email) { skip++; continue; }
    try { await cref('roles').doc((m.email || '').toLowerCase()).set({ role: m.role || 'staff', name: m.name || '' }, { merge: true }); n++; } catch (e) { console.warn('syncRoles', e); }
  }
  toast('직원 권한 문서 ' + n + '개 동기화 완료' + (skip ? ' (이메일 없는 ' + skip + '명 제외)' : ''));
}
/* 마스터 컬렉션에서 똑같은 값(앞뒤 공백 정규화)이 여러 개면 하나만 남기고 삭제 */
async function dedupMasterExact(coll) {
  const seen = {}; let del = 0;
  for (const d of (state[coll] || [])) {
    const v = (d.value || '').trim();
    if (!v) { try { await Store.remove(coll, d.id); del++; } catch (e) { } continue; }
    if (seen[v]) { try { await Store.remove(coll, d.id); del++; } catch (e) { } }
    else seen[v] = true;
  }
  return del;
}
/* 관리자용: 공장명 대표명 통일 + 시공팀·발주처·규격 중복 정리 */
async function unifyFactories() {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  if (!confirm('공장명 통일 + 중복 정리를 실행할까요?\n· 공장명: 토마스→동양, 동호→동호엠엔지, 거봉→거봉석재, 영진→영진석재\n· 시공팀·발주처·규격의 똑같은 이름 중복도 하나로 정리됩니다')) return;
  let sN = 0;
  for (const s of state.sites) { const nf = normFactory(s.factory); if (s.factory && nf !== s.factory) { try { await Store.update('sites', s.id, { factory: nf }); sN++; } catch (e) { } } }
  // 공장 마스터: 대표명 기준으로 묶어서 그룹당 1개만 남기고 중복 삭제
  const groups = {};
  for (const f of (state.factories || [])) {
    const v = (f.value || '').trim();
    if (!v) { try { await Store.remove('factories', f.id); } catch (e) { } continue; }
    const canon = normFactory(v);
    (groups[canon] = groups[canon] || []).push(f);
  }
  let mDel = 0;
  for (const canon in groups) {
    const arr = groups[canon];
    // 값이 이미 대표명과 같은 문서를 우선 유지, 없으면 첫 번째를 대표로 승격
    const keep = arr.find(f => (f.value || '').trim() === canon) || arr[0];
    if ((keep.value || '').trim() !== canon) { try { await Store.update('factories', keep.id, { value: canon }); } catch (e) { } }
    for (const f of arr) { if (f.id !== keep.id) { try { await Store.remove('factories', f.id); mDel++; } catch (e) { } } }
  }
  // 대표명이 아예 없으면 추가
  for (const c of ['동양', '동호엠엔지', '거봉석재', '영진석재']) { if (!groups[c]) { try { await Store.add('factories', { value: c }); } catch (e) { } } }
  // 시공팀·발주처·규격 마스터의 똑같은 값 중복 정리
  const tDel = await dedupMasterExact('teams');
  const supDel = await dedupMasterExact('suppliers');
  const spDel = await dedupMasterExact('specs');
  toast('마스터 정리 완료 · 현장 ' + sN + '건 · 중복삭제 공장 ' + mDel + ' / 시공팀 ' + tDel + ' / 발주처 ' + supDel + ' / 규격 ' + spDel);
}
function findMemberByEmail(email) {
  if (!email) return null;
  const e = email.toLowerCase();
  return state.members.find(m => (m.email || '').toLowerCase() === e) || null;
}
let _membersLoaded = false, _membersWaiters = [];
function whenMembersReady() {
  return new Promise(res => { if (_membersLoaded) res(); else _membersWaiters.push(res); });
}
let _seeded = false;
async function seedIfEmpty() {
  setTimeout(async () => {
    if (_seeded) return; _seeded = true;
    // 미리보기(로컬) 모드에서만 기본 관리자 생성. 클라우드는 첫 로그인 시 자동 부트스트랩.
    if (!CLOUD && state.members.length === 0) {
      await Store.add('members', { name: '관리자', role: 'admin', email: 'admin@local' });
    }
    // 규격(언더바 선택용) 기본값 — 비어있으면 한 번만 추가
    // ⚠️ 클라우드에서는 시드 금지: 서버 데이터가 늦게 로드되면 '비었다'고 오인해
    //    기본값을 매번 다시 추가 → 중복 누적됨. 로컬 미리보기(!CLOUD)에서만 시드.
    if (!CLOUD && state.specs.length === 0) {
      for (const val of ['1600*3200*12', '1600*3200*20', '1200*2700*6', '1200*2700*9', '600*1200*9']) {
        await Store.add('specs', { value: val });
      }
    }
    // 가공 공장 기본값 (시공·발주 매뉴얼 기준)
    if (!CLOUD && state.factories.length === 0) {
      for (const val of ['거봉석재', '동호엠엔지', '토마스마블', '영진석재']) await Store.add('factories', { value: val });
    }
    // 시공팀 기본값
    if (!CLOUD && state.teams.length === 0) {
      for (const val of ['JS테크', '모든대리석', '록스타일', '프로세라믹', '현대코리안', '아트라인']) await Store.add('teams', { value: val });
    }
    // 입고 발주처(매입처) 기본값 — 다우세라믹앤석재(중국 직발주)가 기본
    if (!CLOUD && state.suppliers.length === 0) {
      for (const val of ['다우세라믹앤석재', '거봉석재', '토마스마블', '동호엠엔지', '영진석재']) await Store.add('suppliers', { value: val });
    }
    // 미리보기(로컬) 모드에서 비어있으면 샘플 데이터로 채워 '살아있는' 화면 제공
    if (!CLOUD && state.inventory.length === 0) await seedSample();
  }, CLOUD ? 1200 : 250);
}
async function seedSample() {
  if (state.members.length <= 1) {
    await Store.add('members', { name: '김민준', role: 'staff', pin: '1234' });
    await Store.add('members', { name: '이수진', role: 'staff', pin: '1234' });
  }
  // 품목: 규격(가로*세로*두께) → 장당 헤베 자동
  const items = [
    { name: '로마 팬텀 아이보리', spec: '1600*3200*20', vendor: '토마스마블', jang: 86, safeJang: 20, depot: '본사' },
    { name: '카무스 화이트', spec: '1600*3200*20', vendor: '토마스마블', jang: 4, safeJang: 12, depot: '본사' },
    { name: '트라버티노 아이보리', spec: '1600*3200*12', vendor: '토마스마블', jang: 33, safeJang: 15, depot: '본사' },
    { name: '비앙코 카라라', spec: '1200*2700*9', vendor: '동호엠엔지', jang: 2, safeJang: 8, depot: '제2창고' },
    { name: '포세린 그레이', spec: '600*1200*9', vendor: '거봉석재', jang: 140, safeJang: 40, depot: '본사' }
  ];
  for (const it of items) { it.hebePerJang = parseSpec(it.spec).hebePerJang; await Store.add('inventory', it); }
  // 현장
  await Store.add('sites', { name: '반포 자이 49평', client: '한샘인테리어', region: '서울 서초구', address: '반포동 18-1', manager: '김민준', orderType: '실측', stage: '발주', materialName: '카무스 화이트', qty: '14', unit: '장', measureDate: '2026-05-20', constructDate: '2026-06-02', factory: '거봉석재', team: 'JS테크', quoteAmount: '8200000', paid: true, confirmed: true, note: '주방+현관 상판', history: { '접수': '2026-05-12', '가견적': '2026-05-13', '실측': '2026-05-20', '견적': '2026-05-22', '결제': '2026-05-24', '발주': '2026-05-28' } });
  await Store.add('sites', { name: '대전 둔산 상가', client: '대전리모델링', region: '대전 서구', address: '둔산동 992', manager: '이수진', orderType: '도면', stage: '견적', materialName: '포세린 그레이', qty: '10', unit: '장', constructDate: '2026-06-09', factory: '영진석재', team: '록스타일', preQuote: '약 320만', note: '도면 발주(실측 없음)', history: { '접수': '2026-05-25', '가견적': '2026-05-26', '견적': '2026-05-29' } });
  await Store.add('sites', { name: '판교 카페', client: '미드센추리', region: '경기 성남 분당구', address: '판교로 234', manager: '김민준', orderType: '실측', stage: '실측', materialName: '비앙코 카라라', qty: '6', unit: '장', measureDate: '2026-05-27', constructDate: '2026-06-15', factory: '동호엠엔지', team: '모든대리석', note: '치수 재확인 필요', history: { '접수': '2026-05-23', '가견적': '2026-05-24', '실측': '2026-05-27' } });
  // 홀딩
  await Store.add('holdings', { vendor: '모든대리석', materialName: '카무스 화이트', jang: 12, hebe: 61.44, useDate: '2026-06-02', status: '홀딩', note: '반포 현장 예정' });
  await Store.add('holdings', { vendor: '거봉석재', materialName: '로마 팬텀 아이보리', jang: 8, hebe: 40.96, useDate: '2026-06-10', status: '홀딩' });
  // 출고 내역(월별/분석용)
  const outs = [
    { itemName: '로마 팬텀 아이보리', jang: 6, target: '현장', targetName: '강남 주택', date: '2026-03-12' },
    { itemName: '카무스 화이트', jang: 4, target: '현장', targetName: '반포 자이', date: '2026-04-18' },
    { itemName: '포세린 그레이', jang: 10, target: '공장', targetName: '영진석재', date: '2026-04-25' },
    { itemName: '트라버티노 아이보리', jang: 5, target: '거래처', targetName: '○○석재', date: '2026-05-08' },
    { itemName: '로마 팬텀 아이보리', jang: 8, target: '현장', targetName: '용인 상가', date: '2026-05-20' },
    { itemName: '카무스 화이트', jang: 3, target: '현장', targetName: '반포 자이', date: '2026-05-28' }
  ];
  for (const o of outs) { o.type = 'out'; o.hebe = +(o.jang * 5.12).toFixed(2); o.by = '김민준'; await Store.add('transactions', o); }
}
const _loadedColls = {};
function onData(coll) {
  _loadedColls[coll] = true;
  if (coll === 'members' && !_membersLoaded) {
    _membersLoaded = true;
    _membersWaiters.splice(0).forEach(fn => fn());
  }
  if (coll === 'sites' && me && !isCustomerRole()) autoAdvanceStages();
  if (coll === 'holdings' && me && !isCustomerRole()) { autoReleaseHolds(); maybeActivatePlanned(); }
  if (coll === 'inventory' && me && !isCustomerRole()) maybeActivatePlanned();   // 재고 변동(해제·입고·조정 등)으로 여유 생기면 예정홀딩 확보
  if (['holdings', 'inventory', 'transactions'].includes(coll) && me && !isCustomerRole()) scheduleAvailMirror();   // 고객 노출용 가용수량 미러 갱신(디바운스)
  if (coll === 'chulgoReqs') { refreshChulgoChatIfOpen(); if (me && !isCustomerRole()) chulgoAlertNew(); }   // 채팅 실시간 갱신 + 새 지시 소리 알림
  if (me) render();
}
/* 예정홀딩(및 일부 예정 품목)을 재고 여유가 생길 때 일정 빠른 순으로 자동 확보 — 재진입 방지 */
let _actPlanRun = false;
async function maybeActivatePlanned() {
  if (_actPlanRun || !me || isCustomerRole()) return;
  if (!_loadedColls.holdings || !_loadedColls.inventory) return;   // 로드 전 계산 금지(오배치 방지)
  const hasPlanned = (state.holdings || []).some(h => !['확정', '해제'].includes(h.status || '홀딩') && ((h.status === '예정') || holdItems(h).some(it => it.planned)));
  if (!hasPlanned) return;
  _actPlanRun = true;
  try {
    await activatePlannedHolds();     // ① 빈 재고를 일정 빠른 순으로 예정→활성
    await preemptForUrgent();          // ② 임박(3일 이내) 미충족 건이 3주+ 남은 홀딩 수량을 가져오고, 밀린 건은 예정으로
  } catch (e) { console.warn('reconcileHolds', e); }
  finally { setTimeout(() => { _actPlanRun = false; }, 500); }
}
/* 가용수량 미러: 고객은 자기 홀딩만 보이므로 전체 홀딩을 뺀 '가용'을 계산할 수 없음.
   직원 클라이언트가 inventory 문서에 availJang(=실재고−활성홀딩−파손)을 기록해 고객 화면에 노출.
   ★ 홀딩/재고 스냅샷 도착 순서에 따른 오계산(홀딩 로드 전 전체수량을 가용으로 기록)을 막기 위해
     디바운스로 마지막 상태에서 한 번만 계산하고, 홀딩·재고가 모두 로드된 뒤에만 기록. */
let _availTimer = null, _availBusy = false;
function scheduleAvailMirror() {
  if (!me || isCustomerRole() || !CLOUD) return;
  clearTimeout(_availTimer);
  _availTimer = setTimeout(runAvailMirror, 700);
}
async function runAvailMirror() {
  if (!me || isCustomerRole() || !CLOUD) return;
  if (_availBusy) { scheduleAvailMirror(); return; }               // 진행 중이면 뒤로 미룸(마지막 상태 반영)
  if (!_loadedColls.holdings || !_loadedColls.inventory) { scheduleAvailMirror(); return; }  // 로드 전 계산 금지
  _availBusy = true;
  try {
    for (const it of state.inventory) {
      const av = Math.max(0, availJang(it));
      const cur = (it.availJang == null) ? null : +it.availJang;
      if (cur !== av) { try { await Store.update('inventory', it.id, { availJang: av }); } catch (e) { } }
    }
  } finally { _availBusy = false; }
}

/* ===== 쉽먼트 확인(Material Shipment Confirmation) 연동 브릿지 =====
   같은 Firebase의 공용 컬렉션 teams/dawoo/shipments 를 두 앱이 공유.
   · 이 앱(재고): 세면대 수입발주 + 일반 출고를 shipments 문서로 '올림'(우리 소유 필드만 병합).
   · 확인 앱: 같은 문서에 confirmed/confirmedAt/confirmedBy/confirmNote 를 '써넣음'(우리는 읽기만).
   문서 id 규칙: 세면대 = 'B_'+basinId, 출고묶음 = 'S_'+shipId(없으면 txnId).
   스키마(우리가 쓰는 필드): { source:'dawoo-inventory', kind:'basin'|'out', refId, ref, vendor, items:[{name,qty,spec,orderNo}], date, dest, status, updatedAt } */
let _shipBridgeTimer = null, _shipBridgeBusy = false;
function scheduleShipmentBridge() {
  if (!me || isCustomerRole() || !CLOUD) return;
  clearTimeout(_shipBridgeTimer);
  _shipBridgeTimer = setTimeout(runShipmentBridge, 900);
}
function shipmentDocFor(rec) { return (state.shipments || []).find(s => s.id === rec); }
async function runShipmentBridge() {
  if (!me || isCustomerRole() || !CLOUD) return;
  if (_shipBridgeBusy) { scheduleShipmentBridge(); return; }
  if (!_loadedColls.basins || !_loadedColls.transactions || !_loadedColls.shipments) { scheduleShipmentBridge(); return; }
  _shipBridgeBusy = true;
  try {
    const want = {};   // 올려야 할 문서(우리 소유 필드)
    // 1) 세면대 수입 발주
    (state.basins || []).forEach(b => {
      const its = basinItems(b);
      want['B_' + b.id] = {
        source: 'dawoo-inventory', kind: 'basin', refId: b.id,
        ref: (b.vendor || '') + ' · ' + (its.map(x => x.stone).filter(Boolean).join('/') || '세면대'),
        vendor: b.vendor || '', orderDate: b.orderDate || '', date: b.shipDate || b.orderDate || '',
        address: b.address || '', status: b.stage || '견적',
        items: its.map(x => ({ name: x.stone || '', qty: +x.qty || 0, spec: x.spec || '', orderNo: x.orderNo || '', quoteNo: x.quoteNo || '' })),
        updatedAt: Date.now()
      };
    });
    // 2) 일반 출고(묶음)
    const outs = (state.transactions || []).filter(t => t.type === 'out');
    const gmap = {};
    outs.forEach(t => { const k = 'S_' + (t.shipId || t.id); (gmap[k] = gmap[k] || { key: k, t0: t, items: [] }).items.push(t); });
    Object.values(gmap).forEach(g => {
      const t = g.t0;
      want[g.key] = {
        source: 'dawoo-inventory', kind: 'out', refId: t.shipId || t.id,
        ref: (t.targetName || '') + ' · ' + g.items.map(x => x.itemName).filter(Boolean).join(', '),
        vendor: t.targetName || '', date: t.date || '', dest: t.dest || t.factory || '', status: '출고',
        items: g.items.map(x => ({ name: x.itemName || '', qty: +x.jang || 0, spec: x.spec || '', lot: x.lot || '' })),
        updatedAt: Date.now()
      };
    });
    // 변경분만 업서트(우리 필드 해시 비교 — 확인앱이 쓴 필드는 병합 보존)
    for (const id in want) {
      const cur = shipmentDocFor(id);
      const w = want[id];
      const sig = JSON.stringify([w.ref, w.status, w.date, w.dest, w.items]);
      const curSig = cur ? JSON.stringify([cur.ref, cur.status, cur.date, cur.dest, cur.items]) : null;
      if (sig !== curSig) { try { await Store.setMerge('shipments', id, w); } catch (e) { } }
    }
  } finally { _shipBridgeBusy = false; }
}
/* 특정 발주/출고의 확인 상태 조회 — 배지 표시용 */
function shipConfirm(kind, refId) { return (state.shipments || []).find(s => s.id === (kind === 'basin' ? 'B_' : 'S_') + refId) || null; }

/* ===== 출고관리 앱(dawoo-chulgo, 별도 Firebase) 연동 — 수신 창구(CF)로 전송 =====
   두 앱이 다른 Firebase라 직접 쓰기가 막혀 있어, 출고관리 앱에 만든 '수신 엔드포인트'로 POST 전송.
   전송 규격(payload): { source:'dawoo-tile-stone', kind:'outbound'|'basin', company, client, content, qty, sender, memo, dest, refId, refDate, status:'requested' } */
let _chulgoEndpoint = '';
async function loadAppConfig() {
  if (!CLOUD || !me || isCustomerRole()) return;
  try { const d = await cref('config').doc('app').get(); if (d.exists) _chulgoEndpoint = (d.data().chulgoEndpoint || '').trim(); } catch (e) { }
}
async function saveChulgoEndpoint() {
  const v = (el('chulgo-ep') && el('chulgo-ep').value || '').trim();
  try { await cref('config').doc('app').set({ chulgoEndpoint: v }, { merge: true }); _chulgoEndpoint = v; toast('수신 주소 저장됨'); }
  catch (e) { toast('저장 실패: ' + (e.message || e)); }
}
async function sendToChulgo(kind, refId) {
  if (!_chulgoEndpoint) { toast('출고관리 수신 주소가 아직 없습니다 (설정 → 출고관리 연동에서 입력)'); return; }
  let p;
  if (kind === 'basin') {
    const b = (state.basins || []).find(x => x.id === refId); if (!b) return;
    const its = basinItems(b);
    p = { kind: 'basin', client: b.vendor || '', content: its.map(x => `${x.stone || ''} ${x.spec || ''} ${x.qty || 0}개`).join(', '), qty: basinTotalQty(b), memo: b.note || '', dest: b.address || '', refDate: b.orderDate || '' };
  } else {
    const outs = (state.transactions || []).filter(t => t.type === 'out' && (t.shipId || t.id) === refId); if (!outs.length) return;
    const t0 = outs[0];
    p = { kind: 'outbound', client: t0.targetName || '', content: outs.map(x => `${x.itemName || ''} ${+x.jang || 0}장${x.lot ? ' 롯' + x.lot : ''}`).join(', '), qty: outs.reduce((a, b) => a + (+b.jang || 0), 0), memo: t0.note || '', dest: t0.dest || t0.factory || '', refDate: t0.date || '' };
  }
  const payload = Object.assign({ source: 'dawoo-tile-stone', company: '다우세라믹앤석재', sender: (me && me.name) || '', refId, sentAt: Date.now(), status: 'requested' }, p);
  try {
    const r = await fetch(_chulgoEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (kind === 'basin') { await Store.update('basins', refId, { sentChulgo: true, sentChulgoAt: Date.now() }); }
    else { for (const t of (state.transactions || []).filter(t => t.type === 'out' && (t.shipId || t.id) === refId)) { try { await Store.update('transactions', t.id, { sentChulgo: true }); } catch (e) { } } }
    toast('출고관리로 전송했습니다 ✓');
  } catch (e) { toast('전송 실패: ' + (e.message || e) + ' (수신 주소·CORS 확인)'); }
}

/* ---------- 5. 로그인 (이메일 + 비밀번호 / Firebase 인증) ---------- */
async function doLogin() {
  const email = (el('lg-email').value || '').trim();
  const pw = el('lg-pw').value || '';
  const err = el('login-err'); err.style.color = '';
  if (!email || !pw) { err.textContent = '이메일과 비밀번호를 입력하세요.'; return; }
  err.textContent = '';
  // 이메일 저장 옵션 처리
  try {
    if (el('lg-remember') && el('lg-remember').checked) localStorage.setItem('dws_email', email);
    else localStorage.removeItem('dws_email');
  } catch (e) { }
  if (!CLOUD) {
    // 미리보기 모드: 인증 없이 로컬 관리자
    me = state.members.find(m => m.role === 'admin') || state.members[0] || { name: '관리자', role: 'admin' };
    el('login').style.display = 'none'; el('app').style.display = 'block';
    el('me-av').textContent = initial(me.name); el('me-nm').textContent = me.name; render();
    return;
  }
  try {
    await auth.signInWithEmailAndPassword(email, pw);
    // 성공 시 onAuthStateChanged → afterAuth 에서 화면 전환
  } catch (e) {
    err.textContent = authErrMsg(e);
  }
}
function authErrMsg(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/invalid-email') return '이메일 형식이 올바르지 않습니다.';
  if (c === 'auth/user-disabled') return '정지된 계정입니다. 관리자에게 문의하세요.';
  if (c === 'auth/user-not-found' || c === 'auth/wrong-password' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials')
    return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (c === 'auth/too-many-requests') return '시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
  if (c === 'auth/network-request-failed') return '네트워크 연결을 확인하세요.';
  return '로그인 실패: ' + ((e && e.message) || c);
}
async function resetPw() {
  const email = (el('lg-email').value || '').trim();
  const err = el('login-err'); err.style.color = '';
  if (!email) { err.textContent = '재설정할 이메일을 위 칸에 입력한 뒤 눌러주세요.'; return; }
  if (!CLOUD) { err.textContent = '미리보기 모드에서는 사용할 수 없습니다.'; return; }
  try {
    await auth.sendPasswordResetEmail(email);
    err.style.color = 'var(--gd)';
    err.textContent = '재설정 메일을 보냈습니다. 메일함을 확인하세요.';
  } catch (e) { err.style.color = ''; err.textContent = authErrMsg(e); }
}
function logout() {
  if (CLOUD && auth) { auth.signOut().then(() => location.reload()).catch(() => location.reload()); }
  else { me = null; location.reload(); }
}

/* ---------- 푸시 알림 (FCM) ---------- */
const VAPID_KEY = 'BCr1tMNMANE8G8njYgfcoSzJqaRoSE-aG1pesn7mGb2SwBhxpZFWcI4cxwR06GjurPitv2JSNTXpeQfSFm8yEYM';
const PUSH_FN = 'https://dawoopushfn-297532467454.europe-west1.run.app';
/* 재고 0 → 전 직원 즉시 푸시 (Cloud Function 호출) */
async function notifyStockOut(name) {
  try {
    if (!CLOUD || !auth || !auth.currentUser || !name) return;
    const token = await auth.currentUser.getIdToken();
    await fetch(PUSH_FN + '?action=stockout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: name })
    });
  } catch (e) { }
}
/* 고객 홀딩 요청 → 전 직원 즉시 푸시 (Cloud Function 'holdreq' 액션) */
async function notifyHoldReq(summary) {
  try {
    if (!CLOUD || !auth || !auth.currentUser) return;
    const token = await auth.currentUser.getIdToken();
    await fetch(PUSH_FN + '?action=holdreq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ vendor: (me && me.name) || '', summary: summary || '' })
    });
  } catch (e) { }
}
let _pushReg = null, _pushMsg = null, _onMsgBound = false;
function pushSupported() {
  return CLOUD && ('serviceWorker' in navigator) && ('Notification' in window) && typeof firebase !== 'undefined' && !!firebase.messaging;
}
function pushStatus() {
  if (!('Notification' in window) || !pushSupported()) return 'unsupported';
  return Notification.permission; // default | granted | denied
}
function _wantChulgoPush() { try { return localStorage.getItem('wantChulgoPush') === '1'; } catch (e) { return false; } }
async function _saveToken(token) {
  const id = token.replace(/[\/#?]/g, '_').slice(0, 1400);
  await cref('pushTokens').doc(id).set({ token, name: me ? me.name : '', email: me ? me.email : '', ua: navigator.userAgent, wantChulgo: _wantChulgoPush(), updatedAt: Date.now() });
}
/* 출고 지시 → 옵트인한 기기에 푸시 (Cloud Function 'chulgo' 액션 필요) */
async function notifyChulgoDispatch(summary) {
  try {
    if (!CLOUD || !auth || !auth.currentUser) return;
    const token = await auth.currentUser.getIdToken();
    await fetch(PUSH_FN + '?action=chulgo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ summary: summary || '', by: (me && me.name) || '' }) });
  } catch (e) { }
}
function chulgoPushEnabled() { return _wantChulgoPush() && ('Notification' in window) && Notification.permission === 'granted'; }
async function toggleChulgoPush() {
  if (_wantChulgoPush()) {
    try { localStorage.setItem('wantChulgoPush', '0'); } catch (e) { }
    try { await refreshPushToken(); } catch (e) { }
    toast('휴대폰 출고 지시 알림 꺼짐'); try { renderChulgo(); } catch (e) { }
    return;
  }
  if (!pushSupported()) { toast('이 기기/브라우저는 알림 미지원 (아이폰은 홈 화면에 추가 후 사용)'); return; }
  try { localStorage.setItem('wantChulgoPush', '1'); } catch (e) { }
  if (Notification.permission === 'granted') { await refreshPushToken(); }
  else { await enablePush(); }
  if (chulgoPushEnabled()) toast('휴대폰 출고 지시 알림 켜짐 ✓ · 앱이 꺼져 있어도 알림이 옵니다');
  else { try { localStorage.setItem('wantChulgoPush', '0'); } catch (e) { } toast('알림 권한이 없어 켜지 못했습니다'); }
  try { renderChulgo(); } catch (e) { }
}
function bindForegroundPush() {
  if (_onMsgBound || !_pushMsg) return; _onMsgBound = true;
  _pushMsg.onMessage(payload => {
    const d = (payload && payload.data) || (payload && payload.notification) || {};
    toast('🔔 ' + (d.title || '알림') + (d.body ? ' · ' + d.body : ''));
    try { if (Notification.permission === 'granted' && _pushReg) _pushReg.showNotification(d.title || '다우세라믹앤석재', { body: d.body || '', icon: 'icon-192.png' }); } catch (e) { }
  });
}
async function enablePush() {
  if (!pushSupported()) { toast('이 기기/브라우저는 알림을 지원하지 않습니다 (아이폰은 홈 화면에 추가 후 사용)'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('알림 권한이 허용되지 않았습니다'); return; }
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    _pushReg = reg; await navigator.serviceWorker.ready;
    _pushMsg = firebase.messaging();
    const token = await _pushMsg.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) { toast('알림 토큰 발급 실패 — 다시 시도'); return; }
    await _saveToken(token);
    bindForegroundPush();
    toast('이 기기에서 알림을 받습니다 ✓');
    if (tab === 'settings') renderSettings();
  } catch (e) { toast('알림 설정 실패: ' + (e && (e.message || e.code) || '')); }
}
/* 이미 허용된 기기는 로그인 후 토큰 자동 갱신·저장 */
async function refreshPushToken() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    _pushReg = reg; await navigator.serviceWorker.ready;
    _pushMsg = firebase.messaging();
    const token = await _pushMsg.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) await _saveToken(token);
    bindForegroundPush();
  } catch (e) { }
}

/* ---------- 6. 네비게이션 ---------- */
/* ---------- 햄버거 드로어 ---------- */
function toggleDrawer() {
  const d = el('drawer');
  if (d.classList.contains('open')) closeDrawer();
  else {
    if (me) { el('dw-name').textContent = me.name; el('dw-role').textContent = isAdmin() ? '관리자' : '직원'; }
    document.querySelectorAll('.drawer-i[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
    d.classList.add('open'); el('drawer-ov').classList.add('open');
  }
}
function closeDrawer() { el('drawer').classList.remove('open'); el('drawer-ov').classList.remove('open'); }
function goD(t) { closeDrawer(); go(t); }

function go(t) {
  if (isRestrictedRole()) t = 'stock';   // 고객·시공팀은 전용 화면만
  else if (!tabAllowed(t)) t = 'home';   // 접근 권한 없는 메뉴 차단
  filters.costEdit = '';   // 원가 입력 폼은 메뉴 이동 시 항상 닫기
  if (t !== 'quote') { filters.quoteEdit = ''; filters.quoteSettings = false; filters.taxEdit = ''; }   // 견적 화면 상태 초기화
  if (t !== 'clients') filters.clientDetail = '';
  tab = t;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-i').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  document.querySelectorAll('.drawer-i[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  document.querySelectorAll('.side-i[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  el('pg-' + t).classList.add('active');
  el('fab').style.display = (!isRestrictedRole() && (t === 'sites' || t === 'stock' || t === 'hold' || t === 'basin')) ? 'flex' : 'none';
  applyMenuPerms();
  render();
  window.scrollTo(0, 0);
}
function fabAction() {
  if (tab === 'sites') openSiteForm();
  else if (tab === 'stock') openStockForm();
  else if (tab === 'ship') openShipForm();
  else if (tab === 'hold') openHoldForm();
  else if (tab === 'basin') openBasinForm();
}
let _renderTimer = null;
/* ================= 거래처 관리 (유형 · 사업자정보 · 미수/매출 장부) ================= */
function clientStats(name) {
  const qs = (state.quotes || []).filter(q => _normName(q.client) === _normName(name));
  const total = qs.reduce((a, b) => a + (+b.total || 0), 0);
  const unpaid = qs.reduce((a, b) => a + Math.max(0, (+b.total || 0) - (+b.paidAmount || 0)), 0);
  const paidSum = qs.reduce((a, b) => a + Math.min(+b.total || 0, +b.paidAmount || 0), 0);
  const noTax = qs.filter(q => !q.taxInvoice).length;
  return { count: qs.length, total: total, unpaid: unpaid, paidSum: paidSum, noTax: noTax };
}
function downloadClientLedger(id) {
  const c = (state.clients || []).find(x => x.id === id); if (!c) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const qs = (state.quotes || []).filter(x => _normName(x.client) === _normName(c.value)).sort((a, b) => (+a.createdAt || 0) - (+b.createdAt || 0));
  const head = ['날짜', '견적번호', '품목', '공급가액', '부가세', '합계', '입금액', '미수', '결제', '결제일', '세금계산서', '승인번호'];
  const rows = qs.map(q => { const names = (q.items || []).map(it => it.name).filter(Boolean).slice(0, 3).join(', ') + ((q.items || []).length > 3 ? (' 외 ' + ((q.items || []).length - 3)) : ''); const _t = +q.total || 0; const _p = Math.min(_t, +q.paidAmount || 0); return [qDate(q), q.docNo || '', names, +q.supply || 0, +q.vat || 0, _t, _p, Math.max(0, _t - _p), (_t > 0 && _p >= _t) ? '완료' : (_p > 0 ? '일부' : '미결제'), q.paidDate || '', q.taxInvoice ? '발행' : '미발행', q.ntsConfirmNum || '']; });
  const supplySum = qs.reduce((a, b) => a + (+b.supply || 0), 0); const vatSum = qs.reduce((a, b) => a + (+b.vat || 0), 0); const total = qs.reduce((a, b) => a + (+b.total || 0), 0); const unpaid = qs.filter(q => !q.paid).reduce((a, b) => a + (+b.total || 0), 0);
  const ti = c.taxInfo || {};
  const aoa = [['거래처 원장 · ' + c.value], ['출력일 ' + todayStr() + (ti.bizNo ? (' · 사업자 ' + ti.bizNo) : '') + (c.ctype ? (' · 유형 ' + c.ctype) : '')], [], head].concat(rows);
  const paidSum = qs.reduce((a, b) => a + Math.min(+b.total || 0, +b.paidAmount || 0), 0);
  aoa.push([]); aoa.push(['', '', '합계', supplySum, vatSum, total, paidSum, unpaid, '', '', '', '']);
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 32 }, { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 11 }, { wch: 22 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '원장');
  XLSX.writeFile(wb, '거래처원장_' + (c.value || '').replace(/\s/g, '') + '_' + todayStr() + '.xlsx');
  toast('원장 엑셀 다운로드');
}
function openClientDetail(id) { filters.clientDetail = id; renderClients(); if (el('pg-clients')) el('pg-clients').scrollIntoView({ block: 'start' }); }
function clientsBack() { filters.clientDetail = ''; renderClients(); }
function clientsFilter(v) { filters.clientSearch = v; const box = el('cl-list'); if (box) box.innerHTML = clientRowsHtml(); else renderClients(); }
async function addClientQuick() { const inpEl = el('cl-new'); const v = (inpEl && inpEl.value || '').trim(); if (!v) return; if ((state.clients || []).some(c => _normName(c.value) === _normName(v))) { toast('이미 있는 거래처'); return; } await Store.add('clients', { value: v }); if (inpEl) inpEl.value = ''; toast('거래처 등록됨'); setTimeout(renderClients, 300); }
function salesRepPhoneOf(name) { const m = (state.members || []).find(x => _normName(x.name) === _normName(name || '')); return (m && m.phone) || ''; }
async function saveClientSalesRep(id, name) { try { await Store.update('clients', id, { salesRep: (name || '').trim() }); toast('영업담당자 저장됨'); } catch (e) { } setTimeout(renderClients, 200); }
async function saveClientBizInfo(id) {
  const c = (state.clients || []).find(x => x.id === id); if (!c) return;
  const g = k => { const e = el('cb-' + k); return e ? e.value.trim() : ''; };
  const taxInfo = { bizNo: g('bizno'), corpName: g('corp') || c.value, ceo: g('ceo'), addr: g('addr'), bizType: g('biztype'), bizClass: g('bizclass'), contact: g('contact'), email: g('email') };
  const patch = { taxInfo: taxInfo };
  const ct = classifyCtype(taxInfo.bizType, taxInfo.bizClass, taxInfo.corpName);
  if ((c.ctype || '') !== ct && (taxInfo.bizType || taxInfo.bizClass)) patch.ctype = ct;
  await Store.update('clients', id, patch); toast('거래처 정보 저장됨'); setTimeout(renderClients, 300);
}
async function lookupClientBiz(id) {
  const c = (state.clients || []).find(x => x.id === id); if (!c) return;
  const corpNum = (el('cb-bizno') ? el('cb-bizno').value : '').replace(/[^0-9]/g, '');
  if (corpNum.length !== 10) { toast('사업자번호 10자리를 입력하세요'); return; }
  const co = companyInfo(); toast('사업자 정보 조회 중…');
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(PUSH_FN + '?action=bizinfo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ corpNum: corpNum, memberCorpNum: co.bizno }) });
    const j = await r.json().catch(() => ({}));
    if (!(r.ok && j.ok)) { toast('조회 실패: ' + ((j && j.error) || ('HTTP ' + r.status))); return; }
    if (j.corpName && el('cb-corp')) el('cb-corp').value = j.corpName;
    if (j.ceo && el('cb-ceo')) el('cb-ceo').value = j.ceo;
    if (j.addr && el('cb-addr')) el('cb-addr').value = j.addr;
    if (j.bizType && el('cb-biztype')) el('cb-biztype').value = j.bizType;
    if (j.bizClass && el('cb-bizclass')) el('cb-bizclass').value = j.bizClass;
    const ct = classifyCtype(j.bizType, j.bizClass, j.corpName);
    const warn = (+j.closeDownState === 2) ? ' · ⚠폐업' : ((+j.closeDownState === 3) ? ' · ⚠휴업' : '');
    toast('조회완료 · 유형: ' + ct + warn + ' — 저장을 눌러 반영하세요');
  } catch (e) { toast('조회 오류: ' + ((e && e.message) || e)); }
}
/* 사업자등록증 이미지 OCR (Tesseract) → 사업자번호 등 자동 인식 */
function scanBizCert(input) {
  const f = input.files && input.files[0]; if (!f) return; input.value = '';
  toast('사업자등록증 인식 중… 10~30초');
  const run = async () => {
    try {
      const worker = await Tesseract.createWorker('kor+eng');
      const res = await worker.recognize(f); await worker.terminate();
      parseBizCert((res && res.data && res.data.text) || '');
    } catch (e) { toast('인식 실패 — 사업자번호만 직접 입력해 주세요'); }
  };
  if (window.Tesseract) run();
  else { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; sc.onload = run; sc.onerror = () => toast('OCR 모듈 로딩 실패'); document.head.appendChild(sc); }
}
function parseBizCert(text) {
  const setV = (id, v) => { const e = el(id); if (e && v) e.value = v; };
  const num = text.match(/(\d{3})\s*[-‐–]?\s*(\d{2})\s*[-‐–]?\s*(\d{5})/);
  if (num) setV('cb-bizno', num[1] + '-' + num[2] + '-' + num[3]);
  const grab = labels => { for (const lb of labels) { const m = text.match(new RegExp(lb + '\\s*[:：)]?\\s*([^\\n]+)')); if (m) { let v = m[1].trim().split(/\s{2,}|\||\(|（/)[0].trim(); if (v) return v; } } return ''; };
  setV('cb-corp', grab(['법\\s*인\\s*명\\s*\\(?\\s*단체명\\s*\\)?', '상\\s*호', '법\\s*인\\s*명']));
  setV('cb-ceo', grab(['성\\s*명', '대\\s*표\\s*자']));
  setV('cb-addr', grab(['사업장\\s*소재지', '사업장소재지', '소\\s*재\\s*지', '주\\s*소']));
  setV('cb-biztype', grab(['업\\s*태']));
  setV('cb-bizclass', grab(['종\\s*목']));
  const bt = el('cb-biztype') ? el('cb-biztype').value : ''; const bc = el('cb-bizclass') ? el('cb-bizclass').value : ''; const nm = el('cb-corp') ? el('cb-corp').value : '';
  const ct = classifyCtype(bt, bc, nm);
  toast('스캔 완료 · 유형: ' + ct + ' — 내용 확인 후 저장하세요');
}
async function importClientsFull(input) {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const f = input.files && input.files[0]; if (!f) return; input.value = '';
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  toast('거래처 파일 읽는 중…');
  try {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 2) { toast('데이터가 없습니다'); return; }
    const head = (rows[0] || []).map(h => String(h == null ? '' : h).trim());
    const ci = n => head.indexOf(n);
    const cName = ci('거래처명(최대35자)'), cCorp = ci('상호명'), cBiz = ci('사업자(주민)번호'), cCeo = ci('대표자명'), cType = ci('업태'), cCls = ci('종목'), cAddr = ci('사업장주소(동)'), cAddr2 = ci('상세주소'), cTel = ci('전화'), cMob = ci('휴대전화'), cMail = ci('대표담당자 메일');
    if (cName < 0 && cCorp < 0) { toast('거래처명 열을 찾지 못했습니다 — 표준 양식인지 확인하세요'); return; }
    const gv = (r, i) => i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '';
    const nk = x => _normName(x).replace(/\s+/g, '').replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, '');
    const byBiz = {}, byName = {};
    (state.clients || []).forEach(c => { const b = ((c.taxInfo && c.taxInfo.bizNo) || '').replace(/[^0-9]/g, ''); if (b.length === 10) byBiz[b] = c; byName[nk(c.value)] = c; });
    const coll = cref('clients');
    let added = 0, updated = 0, skipped = 0, ops = 0; let batch = db.batch(); const commits = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; const name = gv(r, cName) || gv(r, cCorp);
      if (!name) { skipped++; continue; }
      const bizD = gv(r, cBiz).replace(/[^0-9]/g, '');
      const bizFmt = bizD.length === 10 ? (bizD.slice(0, 3) + '-' + bizD.slice(3, 5) + '-' + bizD.slice(5)) : gv(r, cBiz);
      const addr = (gv(r, cAddr) + ' ' + gv(r, cAddr2)).trim();
      const bizType = gv(r, cType), bizClass = gv(r, cCls);
      const ti = { bizNo: bizFmt, corpName: gv(r, cCorp) || name, ceo: gv(r, cCeo), addr: addr, bizType: bizType, bizClass: bizClass, contact: gv(r, cTel) || gv(r, cMob), email: gv(r, cMail) };
      const ct = classifyCtype(bizType, bizClass, name);
      const match = (bizD.length === 10 && byBiz[bizD]) || byName[nk(name)];
      if (match) {
        const ex = match.taxInfo || {}; const merged = {};
        ['bizNo', 'corpName', 'ceo', 'addr', 'bizType', 'bizClass', 'contact', 'email'].forEach(k => { merged[k] = ti[k] || ex[k] || ''; });
        const patch = { taxInfo: merged }; if (bizType || bizClass) patch.ctype = ct;
        batch.update(coll.doc(match.id), patch); updated++; ops++;
      } else {
        const ref = coll.doc(); batch.set(ref, { value: name, ctype: ct, taxInfo: ti });
        const stub = { id: ref.id, value: name, taxInfo: ti }; byName[nk(name)] = stub; if (bizD.length === 10) byBiz[bizD] = stub; added++; ops++;
      }
      if (ops >= 400) { commits.push(batch.commit()); batch = db.batch(); ops = 0; toast('반영 중… 신규 ' + added + ' / 갱신 ' + updated); }
    }
    if (ops > 0) commits.push(batch.commit());
    await Promise.all(commits);
    toast('거래처 반영 완료 ✓ 신규 ' + added + ' · 갱신(대치) ' + updated + (skipped ? (' · 이름없음 ' + skipped) : ''));
    setTimeout(renderClients, 800);
  } catch (e) { toast('업로드 실패: ' + ((e && e.message) || e)); }
}
async function delClientC(id) { if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; } const c = (state.clients || []).find(x => x.id === id); if (!c) return; if (!confirm((c.value || '') + ' 거래처를 삭제할까요?')) return; const _box = el('cl-list'); const _sc = _box ? _box.scrollTop : 0; await Store.remove('clients', id); filters.clientDetail = ''; toast('삭제됨'); setTimeout(() => { render(); const b = el('cl-list'); if (b) b.scrollTop = _sc; }, 300); }
function clientRowsHtml() {
  const q = (filters.clientSearch || '').trim().toLowerCase();
  let list = (state.clients || []).slice().sort((a, b) => (a.value || '').localeCompare(b.value || ''));
  if (q) list = list.filter(c => (c.value || '').toLowerCase().includes(q));
  return list.length ? list.map(c => {
    const st = clientStats(c.value); const ti = c.taxInfo || {};
    return `<div class="card" style="margin-bottom:8px;padding:11px 13px;cursor:pointer" onclick="openClientDetail('${c.id}')">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="min-width:0"><div style="font-weight:700;font-size:14.5px">${esc(c.value)}</div>
          <div style="font-size:11px;color:var(--t3);margin-top:2px">${ti.bizNo ? esc(ti.bizNo) + ' · ' : '<span style="color:#c0341d">사업자정보 미등록 · </span>'}${st.count}건 · 매출 ${fmtWon(st.total)}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex:none" onclick="event.stopPropagation()">
          <select onchange="setClientTypeSetting('${c.id}',this.value)" style="font-size:12.5px;padding:5px 7px;border:1.5px solid var(--bd2);border-radius:8px">${CTYPES.map(t => `<option ${((c.ctype) || '소비자') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <div style="text-align:right;min-width:74px"><div style="font-size:14px;font-weight:800;color:${st.unpaid > 0 ? 'var(--red-t)' : 'var(--t3)'}">${fmtWon(st.unpaid)}</div><div style="font-size:9.5px;color:var(--t3)">미수금</div></div>
          ${isAdmin() ? `<i class="ti ti-trash" onclick="delClientC('${c.id}')" title="거래처 삭제" style="color:#c0341d;cursor:pointer;font-size:16px"></i>` : ''}
          <i class="ti ti-chevron-right" style="color:var(--t3)"></i>
        </div>
      </div></div>`;
  }).join('') : `<div class="empty"><i class="ti ti-users"></i>${q ? '검색 결과가 없습니다' : '거래처가 없습니다'}</div>`;
}
function renderClients() {
  if (filters.clientDetail) { renderClientDetail(); return; }
  const allUnpaid = (state.clients || []).reduce((a, c) => a + clientStats(c.value).unpaid, 0);
  const rows = clientRowsHtml();
  el('pg-clients').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-users"></i>거래처 관리</h2><p>유형 · 사업자정보 · 미수/매출</p></div></div>
    <div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:12px">
      <div class="stat"><div class="ic b"><i class="ti ti-users"></i></div><div class="v">${(state.clients || []).length}</div><div class="l">거래처</div></div>
      <div class="stat"><div class="ic r"><i class="ti ti-cash-off"></i></div><div class="v" style="font-size:19px">${fmtWon(allUnpaid)}</div><div class="l">총 미수금</div></div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input id="cl-new" lang="ko" placeholder="새 거래처명" autocomplete="off" style="flex:1;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:9px">
      <button class="btn btn-sm btn-pri" onclick="addClientQuick()"><i class="ti ti-plus"></i>추가</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
      <button class="btn btn-sm" onclick="el('ct-file2').click()"><i class="ti ti-upload"></i> 유형 엑셀 업로드</button>
      <button class="btn btn-sm" onclick="clientTypeTemplate()"><i class="ti ti-download"></i> 양식</button>
      <input type="file" id="ct-file2" accept=".xlsx,.xls,.csv" style="display:none" onchange="clientTypeImport(this)">
      <button class="btn btn-sm btn-pri" onclick="el('cl-fullfile').click()"><i class="ti ti-file-upload"></i> 거래처 일괄 등록·대치</button>
      <input type="file" id="cl-fullfile" accept=".xlsx,.xls" style="display:none" onchange="importClientsFull(this)">
    </div>
    <div class="search-box" style="margin-bottom:10px"><i class="ti ti-search"></i><input id="cl-search" placeholder="거래처 검색" value="${esc(filters.clientSearch || '')}" oninput="clientsFilter(this.value)" autocomplete="off" lang="ko"></div>
    <div data-keepscroll id="cl-list" style="max-height:58vh;overflow:auto;padding-right:2px">${rows}</div>`;
}
function renderClientDetail() {
  const c = (state.clients || []).find(x => x.id === filters.clientDetail); if (!c) { filters.clientDetail = ''; renderClients(); return; }
  const ti = c.taxInfo || {}; const st = clientStats(c.value);
  const inp = 'width:100%;font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:9px';
  const fld = (k, label, val, ph) => `<div class="fld" style="flex:1;min-width:150px;margin:0"><label>${label}</label><input id="cb-${k}" lang="ko" value="${esc(val || '')}" placeholder="${ph || ''}" style="${inp}"></div>`;
  const qs = (state.quotes || []).filter(x => _normName(x.client) === _normName(c.value)).sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const ledger = qs.length ? qs.map(qq => {
    const when = qDate(qq);
    const _p = +qq.paidAmount || 0; const _t = +qq.total || 0;
    const paidPill = (_t > 0 && _p >= _t) ? `<button class="pill p-done" style="border:none;cursor:pointer" onclick="quoteMarkPaid('${qq.id}')">결제완료</button>` : (_p > 0 ? `<button class="pill p-prog" style="border:none;cursor:pointer" onclick="quoteMarkPaid('${qq.id}')">입금 ${fmtWon(_p)}·미수 ${fmtWon(_t - _p)}</button>` : `<button class="pill p-wait" style="border:none;cursor:pointer" onclick="quoteMarkPaid('${qq.id}')">미결제</button>`);
    const taxPill = qq.taxInvoice ? `<span class="pill p-prog">계산서발행</span>` : `<span class="pill p-gray">계산서미발행</span>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 2px;border-bottom:1px solid var(--bd)">
      <div style="min-width:0"><div style="font-size:12.5px;font-weight:600">${esc(qq.docNo || '')} <span style="color:var(--t3);font-weight:400">· ${esc(when)}</span></div>
        <div style="display:flex;gap:4px;margin-top:3px">${paidPill}${taxPill}</div></div>
      <div style="text-align:right;flex:none"><div style="font-weight:800;font-size:14px;color:${qq.paid ? 'var(--t2)' : 'var(--red-t)'}">${fmtWon(qq.total)}</div>
        <button class="btn btn-sm" style="padding:2px 8px;font-size:11px;margin-top:2px" onclick="filters.quoteEdit='';filters.taxEdit='';go('quote');setTimeout(()=>openQuoteInline('${qq.id}'),50)">견적보기</button></div>
    </div>`;
  }).join('') : '<div class="empty" style="padding:16px">견적 내역이 없습니다</div>';
  el('pg-clients').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-user"></i>${esc(c.value)}</h2><p>거래처 상세</p></div>
      <button class="btn btn-sm" onclick="clientsBack()"><i class="ti ti-arrow-left"></i> 목록</button></div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
      <div class="stat"><div class="v" style="font-size:18px">${fmtWon(st.total)}</div><div class="l">총 매출</div></div>
      <div class="stat"><div class="v" style="font-size:18px;color:var(--gd)">${fmtWon(st.paidSum)}</div><div class="l">입금액</div></div>
      <div class="stat"><div class="v" style="font-size:18px;color:${st.unpaid > 0 ? 'var(--red-t)' : ''}">${fmtWon(st.unpaid)}</div><div class="l">미수금</div></div>
      <div class="stat"><div class="v">${st.noTax}</div><div class="l">계산서 미발행</div></div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:12px 16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0;font-size:14px;white-space:nowrap"><i class="ti ti-user-star"></i> 영업 담당자</h3>
        <select onchange="saveClientSalesRep('${c.id}',this.value)" style="font-size:14px;padding:7px 10px;border:1.5px solid var(--bd2);border-radius:9px;flex:1;min-width:150px">
          <option value="">(지정 안 함)</option>
          ${(state.members || []).filter(m => ['admin', 'staff'].includes(m.role || 'staff')).map(m => `<option ${_normName(c.salesRep || '') === _normName(m.name) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
        <span style="font-size:12.5px;color:var(--t3);white-space:nowrap">${c.salesRep ? esc(salesRepPhoneOf(c.salesRep) || '연락처 미등록') : ''}</span>
      </div>
      <div style="font-size:11px;color:var(--t3);margin-top:6px">견적서에서 <b>영업담당자로 표기</b>를 켜면 견적 담당자 대신 이 담당자의 이름·연락처가 표시됩니다.</div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:0;overflow:hidden">
      <div onclick="const _b=el('cb-body');_b.style.display=(_b.style.display==='none'?'block':'none')" style="cursor:pointer;padding:13px 16px;display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0;font-size:15px"><i class="ti ti-id-badge-2"></i> 사업자 정보 · 유형 확인</h3><i class="ti ti-chevron-down" style="color:var(--t3)"></i></div>
      <div id="cb-body" style="display:none;padding:0 16px 14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><label style="font-size:12.5px;color:var(--t2)">거래처 유형</label>
        <select onchange="setClientTypeSetting('${c.id}',this.value)" style="font-size:13px;padding:6px 9px;border:1.5px solid var(--bd2);border-radius:8px">${CTYPES.map(t => `<option ${((c.ctype) || '소비자') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span style="font-size:11px;color:var(--t3)">사업자정보 조회 시 자동 분류됩니다</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <div class="fld" style="flex:1;min-width:180px;margin:0"><label>사업자등록번호</label><div style="display:flex;gap:6px"><input id="cb-bizno" inputmode="numeric" value="${esc(ti.bizNo || '')}" placeholder="000-00-00000" style="${inp}"><button class="btn btn-sm btn-pri" style="flex:none;white-space:nowrap" onclick="lookupClientBiz('${c.id}')"><i class="ti ti-search"></i>조회</button></div></div>
        ${fld('corp', '상호', ti.corpName || c.value)}
      </div>
      <div style="margin-bottom:9px"><button class="btn btn-sm" onclick="el('bizcert-file').click()"><i class="ti ti-scan"></i> 사업자등록증 스캔(사진)</button><input type="file" id="bizcert-file" accept="image/*" style="display:none" onchange="scanBizCert(this)"><span style="font-size:10.5px;color:var(--t3);margin-left:8px">사진 올리면 자동 인식</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">${fld('ceo', '대표자', ti.ceo)}${fld('contact', '담당자', ti.contact)}</div>
      <div class="fld full" style="margin-bottom:8px"><label>주소</label><input id="cb-addr" lang="ko" value="${esc(ti.addr || '')}" style="${inp}"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">${fld('biztype', '업태', ti.bizType)}${fld('bizclass', '종목', ti.bizClass)}</div>
      <div class="fld full" style="margin-bottom:11px"><label>담당자 이메일 <span style="color:var(--t3);font-weight:500">(세금계산서 발행 메일)</span></label><input id="cb-email" lang="en" value="${esc(ti.email || '')}" placeholder="name@company.com" style="${inp}"></div>
      <div class="frm-foot">${isAdmin() ? `<button class="btn" style="color:var(--red-t);flex:none" onclick="delClientC('${c.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn btn-pri" style="flex:1" onclick="saveClientBizInfo('${c.id}')"><i class="ti ti-check"></i>저장</button></div>
      </div>
    </div>
    <div class="card" style="padding:14px 16px">
      <div class="card-h"><h3><i class="ti ti-book"></i>거래 장부</h3><div style="display:flex;align-items:center;gap:8px"><button class="btn btn-sm" onclick="downloadClientLedger('${c.id}')"><i class="ti ti-file-spreadsheet"></i>엑셀</button><span style="font-size:11px;color:var(--t3)">미수 ${fmtWon(st.unpaid)}원</span></div></div>
      <div style="max-height:52vh;overflow:auto">${ledger}</div>
    </div>`;
}
function render() {
  if (!me) return;
  // 입력 중(검색창·폼 포커스)에는 전체 재렌더를 미뤄 한글 입력·검색 끊김 방지
  const _ae = document.activeElement;
  if (_ae && (_ae.tagName === 'INPUT' || _ae.tagName === 'TEXTAREA' || _ae.isContentEditable)) {
    if (!_renderTimer) _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 600);
    return;
  }
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  // 스크롤 위치 보존(재렌더로 스크롤이 위로 튕기는 것 방지) — data-keepscroll + id 붙은 요소
  const _keep = {};
  document.querySelectorAll('[data-keepscroll]').forEach(e => { if (e.id && e.scrollTop > 0) _keep[e.id] = e.scrollTop; });
  if (Object.keys(_keep).length) requestAnimationFrame(() => { for (const id in _keep) { const e = el(id); if (e) e.scrollTop = _keep[id]; } });
  if (isCustomerRole()) { renderCustomerStock(); return; }   // 고객: 재고 조회 전용
  if (isCrewRole()) { renderCrewSchedule(); return; }        // 시공팀: 시공 스케줄 전용
  applyMenuPerms();
  if (tab === 'home') renderHome();
  else if (tab === 'sites') renderSites();
  else if (tab === 'stock') renderStock();
  else if (tab === 'ship') renderShip();
  else if (tab === 'hold') renderHold();
  else if (tab === 'basin') renderBasin();
  else if (tab === 'chulgo') renderChulgo();
  else if (tab === 'quote') renderQuote();
  else if (tab === 'clients') renderClients();
  else if (tab === 'settle') renderSettle();
  else if (tab === 'settings') renderSettings();
}
/* ---------- 고객(거래처) 재고 조회 전용 화면 (읽기 전용) ---------- */
function custStockList() {
  const q = (filters.custSearch || '').trim().toLowerCase();
  let l = state.inventory.filter(i => catIsCeramicLike(itemCat(i))).sort((a, b) => (a.name || '').localeCompare(b.name || ''));   // 부자재는 직원용 — 고객엔 세라믹·석재만
  if (q) l = l.filter(i => (i.name || '').toLowerCase().includes(q) || (i.spec || '').toLowerCase().includes(q));
  return l;
}
/* 고객에게 보이는 수량 = 가용수량(전체 홀딩 제외). 미러 필드 availJang 사용, 없으면 실재고로 대체 */
function custAvail(i) { return (i.availJang == null) ? Math.max(0, +i.jang || 0) : Math.max(0, +i.availJang || 0); }
function custStockBody(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-search-off"></i>해당하는 자재가 없습니다</div>`;
  const rows = list.map(i => {
    const jang = custAvail(i);
    const inStock = jang > 0;
    const dot = inStock ? 'background:#1D9E75;--pc:rgba(29,158,117,.6)' : 'background:#E23B3B;--pc:rgba(226,59,59,.75)';
    const lbl = inStock ? '<span style="font-size:11.5px;font-weight:600;color:#0F6E56">있음</span>' : '<span style="font-size:11.5px;font-weight:600;color:#A32D2D">품절</span>';
    let restock = '';
    if (i.restockDate) { const p = String(i.restockDate).split('-'); if (p.length === 3) { const rcol = inStock ? '#2f6fed' : 'var(--amber-t)'; restock = `<div style="font-size:11px;color:${rcol};margin-top:3px;font-weight:600"><i class="ti ti-truck-delivery" style="font-size:12px;vertical-align:-1px"></i> 재입고 예정 ${+p[1]}/${+p[2]}</div>`; } }
    return `<tr>
      <td><div style="font-weight:600;color:var(--t1);word-break:keep-all">${esc(i.name)}</div>${i.spec ? `<div style="color:var(--t3);font-size:11px;margin-top:2px">${esc(i.spec)}</div>` : ''}${restock}</td>
      <td style="text-align:right;white-space:nowrap"><div style="font-weight:700;color:${inStock ? 'var(--t1)' : 'var(--t3)'}">${jang}장</div></td>
      <td><span style="display:inline-flex;align-items:center;gap:6px"><span class="live-dot" style="${dot}"></span>${lbl}</span></td>
    </tr>`;
  }).join('');
  return `<div style="border:0.5px solid var(--bd);border-radius:12px;overflow:hidden;margin-top:2px">
    <div id="cust-stock-wrap" data-keepscroll style="max-height:calc(100vh - 250px);min-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <table class="cust-tbl"><thead><tr><th>자재명 · 규격</th><th style="text-align:right;width:70px">가용재고</th><th style="width:62px">상태</th></tr></thead><tbody>${rows}</tbody></table>
    </div></div>`;
}
function filterCustStock() {
  filters.custSearch = el('cust-search') ? el('cust-search').value : '';
  if (el('cust-body')) el('cust-body').innerHTML = custStockBody(custStockList());
  const x = el('cust-search-x'); if (x) x.style.display = (filters.custSearch || '').trim() ? '' : 'none';
}
function clearCustStock() { filters.custSearch = ''; if (el('cust-search')) el('cust-search').value = ''; filterCustStock(); const i = el('cust-search'); if (i) i.focus(); }
/* 고객 본인(업체) 홀딩 — vendor 가 계정명과 같은 것만. 서버 규칙으로도 제한됨 */
function custMyHolds() {
  return (state.holdings || []).filter(h => h.status !== '해제' && _normName(h.vendor) === _normName(me.name))
    .sort((a, b) => (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'));
}
/* 고객 지난 홀딩 — 기간 경과 등으로 해제된 것 */
function custMyPastHolds() {
  return (state.holdings || []).filter(h => h.status === '해제' && _normName(h.vendor) === _normName(me.name))
    .sort((a, b) => (b.useDate || '0000-00-00').localeCompare(a.useDate || '0000-00-00'));
}
function custHoldCard(h, isPast) {
  const st = isPast ? '지난 · 해제' : holdStatusText(h);
  const cls = holdStatusText(h) === '출고완료' ? 'p-done' : (holdStatusText(h) === '예정' ? 'p-wait' : 'p-hold');
  const items = holdItems(h).map(it => `<div style="color:var(--t2);font-size:12.5px;margin-top:2px;word-break:keep-all">· <b style="color:${isPast ? 'var(--t2)' : 'var(--t1)'}">${esc(it.materialName || '-')}</b> ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}${it.lot ? ` · 롯트 ${esc(it.lot)}` : ''}</div>`).join('');
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px${isPast ? ';opacity:.85;background:var(--soft)' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="font-size:12.5px;color:var(--t3)"><i class="ti ti-calendar" style="font-size:12px"></i> ${h.useDate ? '사용예정 ' + esc(h.useDate) : '예정일 미정'}</div>
        ${isPast ? `<span class="pill" style="flex:none;background:var(--bd2);color:var(--t3)">${esc(st)}</span>` : `<span class="pill ${cls}" style="flex:none">${esc(st)}</span>`}</div>
      <div style="margin-top:6px">${items}</div>
      ${h.note ? `<div style="margin-top:7px;padding-top:7px;border-top:1px dashed var(--bd2);font-size:12.5px;color:var(--t2);word-break:break-all"><i class="ti ti-note" style="font-size:12px;color:var(--t3)"></i> ${esc(h.note)}</div>` : ''}
    </div>`;
}
/* 고객 홀딩을 상태별 3그룹으로 분리: 진행중(홀딩·예정) / 출고완료(확정) / 해제 */
function custHoldGroups() {
  const mine = (state.holdings || []).filter(h => _normName(h.vendor) === _normName(me.name));
  const active = mine.filter(h => !['확정', '해제'].includes(h.status || '홀딩')).sort((a, b) => (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'));
  const done = mine.filter(h => (h.status || '') === '확정').sort((a, b) => (b.useDate || '0000-00-00').localeCompare(a.useDate || '0000-00-00'));
  const released = mine.filter(h => (h.status || '') === '해제').sort((a, b) => (b.useDate || '0000-00-00').localeCompare(a.useDate || '0000-00-00'));
  return { active, done, released };
}
/* 검색어 매칭: 자재명·롯트·비고 */
function custHoldMatch(h, q) {
  if (!q) return true;
  const inItems = holdItems(h).some(it => (it.materialName || '').toLowerCase().includes(q) || (it.lot || '').toLowerCase().includes(q));
  return inItems || (h.note || '').toLowerCase().includes(q);
}
/* 현재 선택된 뷰의 카드 목록 HTML (검색 반영) */
function custHoldListHtml() {
  const g = custHoldGroups();
  const view = filters.custHoldView || 'active';
  const q = (filters.custHoldSearch || '').trim().toLowerCase();
  const cur = view === 'done' ? g.done : (view === 'released' ? g.released : g.active);
  const filtered = cur.filter(h => custHoldMatch(h, q));
  if (!filtered.length) return `<div style="font-size:12.5px;color:var(--t3);padding:16px 6px;text-align:center">${q ? '검색 결과가 없습니다' : '해당 내역이 없습니다'}</div>`;
  return filtered.map(h => custHoldCard(h, view === 'released')).join('');
}
function custHoldsBody() {
  const g = custHoldGroups();
  const view = filters.custHoldView || 'active';
  const q = filters.custHoldSearch || '';
  const note = `<div style="font-size:12px;color:var(--t2);margin-top:12px;line-height:1.55;background:var(--soft);border-radius:10px;padding:11px 13px"><i class="ti ti-info-circle" style="font-size:13px;color:var(--blue)"></i> 지난(해제) 홀딩의 <b>활성화(재홀딩)·기간 연장</b>이 필요하시면 담당자에게 <b>직접 문의</b>해 주세요.</div>`;
  if (!g.active.length && !g.done.length && !g.released.length) return `<div class="empty"><i class="ti ti-lock-off"></i>등록된 홀딩이 없습니다</div>${note}`;
  const chip = (v, label, ic, n) => `<button class="chip ${view === v ? 'active' : ''}" onclick="goCustHoldView('${v}')"><i class="ti ${ic}"></i> ${label}${n ? ` (${n})` : ''}</button>`;
  let html = `<div class="chips" style="margin:2px 0 9px">${chip('active', '진행중', 'ti-lock', g.active.length)}${chip('done', '출고완료', 'ti-circle-check', g.done.length)}${chip('released', '해제', 'ti-history', g.released.length)}</div>`;
  html += `<div class="search-box" style="margin-bottom:9px">
      <i class="ti ti-search"></i>
      <input id="custhold-search" placeholder="자재명·롯트·비고 검색" value="${esc(q)}" oninput="filterCustHold()" autocomplete="off" lang="ko">
      <button class="search-x" id="custhold-search-x" style="${q.trim() ? '' : 'display:none'}" onclick="clearCustHold()"><i class="ti ti-x"></i></button>
    </div>`;
  html += `<div id="custhold-list" data-keepscroll style="max-height:58vh;min-height:160px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${custHoldListHtml()}</div>`;
  html += note;
  return html;
}
function goCustHoldView(v) { filters.custHoldView = v; filters.custHoldSearch = ''; renderCustomerStock(); }
function filterCustHold() {
  filters.custHoldSearch = el('custhold-search') ? el('custhold-search').value : '';
  const box = el('custhold-list'); if (box) box.innerHTML = custHoldListHtml();
  const x = el('custhold-search-x'); if (x) x.style.display = (filters.custHoldSearch || '').trim() ? '' : 'none';
}
function clearCustHold() { filters.custHoldSearch = ''; if (el('custhold-search')) el('custhold-search').value = ''; filterCustHold(); const i = el('custhold-search'); if (i) i.focus(); }
function goCustTab(v) { filters.custTab = v; renderCustomerStock(); }
/* 고객 로그인 시: 재고(읽기 허용) + 본인 업체 홀딩만 구독. 나머지 컬렉션은 구독하지 않음(권한 없음·충돌 방지) */
function startCustomerSubs() {
  if (!CLOUD || !me || me.role !== 'customer') return;
  try {
    cref('inventory').onSnapshot(snap => {
      state.inventory = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'customer' && (filters.custTab || 'stock') === 'stock') renderCustomerStock();
    }, err => console.warn('cust inv', err));
  } catch (e) { console.warn(e); }
  startCustomerHoldings();
  startCustomerHoldReqs();
}
function startCustomerHoldReqs() {
  if (!CLOUD || !me || me.role !== 'customer' || !me.name) return;
  try {
    cref('holdRequests').where('vendor', '==', me.name).onSnapshot(snap => {
      state.holdRequests = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'customer' && (filters.custTab || 'stock') === 'req') renderCustomerStock();
    }, err => console.warn('cust holdreq', err));
  } catch (e) { console.warn(e); }
}
function startCustomerHoldings() {
  if (!CLOUD || !me || me.role !== 'customer' || !me.name) return;
  try {
    cref('holdings').where('vendor', '==', me.name).onSnapshot(snap => {
      state.holdings = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'customer') renderCustomerStock();   // 홀딩 로드되면 탭 상관없이 갱신(배지 반영)
    }, err => console.warn('cust holds', err));
  } catch (e) { console.warn(e); }
}
function renderCustomerStock() {
  const tab = filters.custTab || 'stock';
  const list = custStockList();
  const custInv = state.inventory.filter(i => catIsCeramicLike(itemCat(i)));
  const inN = custInv.filter(i => custAvail(i) > 0).length;
  const outN = custInv.length - inN;
  const myHolds = custMyHolds();
  const stockSec = `
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px"><span class="live-dot" style="background:#1D9E75;--pc:rgba(29,158,117,.6);width:7px;height:7px;display:inline-block;vertical-align:middle;margin-right:5px"></span>실시간 · 재고있음 ${inN} · 품절 ${outN}</div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="cust-search" placeholder="자재명·규격 검색" value="${esc(filters.custSearch || '')}" oninput="filterCustStock()" autocomplete="off" lang="ko">
      <button class="search-x" id="cust-search-x" style="${(filters.custSearch || '').trim() ? '' : 'display:none'}" onclick="clearCustStock()"><i class="ti ti-x"></i></button>
    </div>
    <div id="cust-body">${custStockBody(list)}</div>
    ${state.inventory.some(i => i.restockDate) ? `<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5;background:var(--soft);border-radius:9px;padding:9px 11px"><i class="ti ti-info-circle" style="font-size:12px;vertical-align:-1px"></i> 재입고 일정은 통관사·선사 스케줄에 따라 변동될 수 있습니다.</div>` : ''}`;
  const holdsSec = `<div style="font-size:12px;color:var(--t3);margin:2px 0 8px">우리 업체 홀딩 내역 · 상태별로 확인하세요</div>${custHoldsBody()}`;
  const myReqs = (state.holdRequests || []).slice().sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const reqPending = myReqs.filter(r => (r.status || '대기') === '대기').length;
  const reqSec = `
    <div class="card" style="padding:13px 15px;margin-bottom:12px">
      <div style="font-weight:600;font-size:14px;margin-bottom:10px"><i class="ti ti-lock-plus" style="color:var(--blue)"></i> 홀딩 요청 보내기</div>
      <div class="fld" style="margin-bottom:8px"><label style="font-size:12px;color:var(--t2)">자재명 <span style="color:var(--red-t)">*</span></label>${searchBox('creq-mat', '자재명 검색·선택', '', 'invNames', '')}</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">장수 <span style="color:var(--red-t)">*</span></label><input id="creq-jang" inputmode="numeric" placeholder="장수" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        <div class="fld" style="flex:1.2"><label style="font-size:12px;color:var(--t2)">사용 예정일 <span style="color:var(--red-t)">*</span></label><input type="date" id="creq-usedate" style="width:100%;font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">현장명 <span style="color:var(--red-t)">*</span></label><input id="creq-site" lang="ko" placeholder="예: ○○현장" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">담당자명 <span style="color:var(--red-t)">*</span></label><input id="creq-manager" lang="ko" placeholder="예: 김과장" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      </div>
      <button class="btn btn-pri btn-block" onclick="submitHoldReq()"><i class="ti ti-send"></i> 요청 보내기</button>
      <div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5"><i class="ti ti-info-circle" style="font-size:12px"></i> 모든 항목은 필수입니다. 요청을 보내면 담당자에게 알림이 가고, 확인 후 확정됩니다.</div>
    </div>
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px">내 요청 내역 · 총 ${myReqs.length}건${reqPending ? ` · 대기 ${reqPending}` : ''}</div>
    ${custReqBody(myReqs)}`;
  el('pg-stock').innerHTML = `
    <div style="max-width:680px;margin:0 auto">
    <div class="ph"><div><h2><i class="ti ti-packages"></i>${esc(me.name)}</h2><p><span class="live-dot" style="background:#1D9E75;--pc:rgba(29,158,117,.6);width:7px;height:7px;display:inline-block;vertical-align:middle;margin-right:5px"></span>실시간 조회</p></div>
      <button class="btn btn-sm" onclick="logout()"><i class="ti ti-logout"></i>로그아웃</button></div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${tab === 'stock' ? 'active' : ''}" onclick="goCustTab('stock')"><i class="ti ti-packages"></i> 재고 조회</button>
      <button class="chip ${tab === 'holds' ? 'active' : ''}" onclick="goCustTab('holds')"><i class="ti ti-lock"></i> 내 홀딩${myHolds.length ? ` (${myHolds.length})` : ''}</button>
      <button class="chip ${tab === 'req' ? 'active' : ''}" onclick="goCustTab('req')"><i class="ti ti-lock-plus"></i> 홀딩 요청${reqPending ? ` (${reqPending})` : ''}</button>
    </div>
    ${tab === 'stock' ? stockSec : (tab === 'req' ? reqSec : holdsSec)}
    </div>`;
}
/* 고객 본인 홀딩 요청 내역 카드 */
function custReqBody(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>보낸 요청이 없습니다</div>`;
  return list.map(r => {
    const st = r.status || '대기';
    const col = st === '승인' ? { bg: 'var(--gl2,#e8f7f0)', c: '#0F6E56' } : (st === '취소' ? { bg: 'var(--soft)', c: 'var(--t3)' } : { bg: '#fef3e2', c: '#9a6a12' });
    const items = (r.items || []).map(it => `<b style="color:var(--t1)">${esc(it.materialName || '-')}</b> ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}`).join(', ');
    const when = r.createdAt ? new Date(+r.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '';
    return `<div class="card" style="margin-bottom:8px;padding:11px 13px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="font-size:13.5px;word-break:keep-all">${items}</div>
        <span style="flex:none;font-size:11px;font-weight:700;background:${col.bg};color:${col.c};border-radius:999px;padding:3px 10px">${esc(st)}</span>
      </div>
      <div style="font-size:11.5px;color:var(--t3);margin-top:5px">${r.useDate ? '사용예정 ' + esc(r.useDate) + ' · ' : ''}요청 ${when}${r.note ? ' · ' + esc(r.note) : ''}</div>
      ${st === '취소' && r.rejectReason ? `<div style="font-size:12px;color:var(--red-t);margin-top:6px;background:#fff2f0;border-radius:8px;padding:7px 10px"><i class="ti ti-message-2" style="font-size:13px"></i> 취소 사유: ${esc(r.rejectReason)}</div>` : ''}
    </div>`;
  }).join('');
}
async function submitHoldReq() {
  const mat = (el('creq-mat') && el('creq-mat').value || '').trim();
  const jang = parseFloat(el('creq-jang') && el('creq-jang').value) || 0;
  const useDate = el('creq-usedate') ? el('creq-usedate').value : '';
  const site = (el('creq-site') && el('creq-site').value || '').trim();
  const manager = (el('creq-manager') && el('creq-manager').value || '').trim();
  if (!mat) { toast('자재를 선택하세요'); return; }
  if (jang <= 0) { toast('장수를 입력하세요'); return; }
  if (!useDate) { toast('사용 예정일을 선택하세요'); return; }
  if (!site) { toast('현장명을 입력하세요'); return; }
  if (!manager) { toast('담당자명을 입력하세요'); return; }
  const note = '현장 ' + site + ' · 담당 ' + manager;
  if (_busy) return; _busy = true;
  try {
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat));
    const hebe = it ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
    await Store.add('holdRequests', { vendor: me.name, items: [{ materialName: mat, jang: jang, hebe: hebe }], useDate: useDate, site: site, manager: manager, note: note, status: '대기', createdAt: Date.now(), by: me.name });
    notifyHoldReq(mat + ' ' + jang + '장 · ' + site);
    toast('홀딩 요청을 보냈습니다 ✓');
    if (el('creq-mat')) el('creq-mat').value = '';
    if (el('creq-jang')) el('creq-jang').value = '';
    if (el('creq-usedate')) el('creq-usedate').value = '';
    if (el('creq-site')) el('creq-site').value = '';
    if (el('creq-manager')) el('creq-manager').value = '';
  } catch (e) { toast('요청 전송 실패 — 잠시 후 다시 시도하세요'); } finally { _busy = false; }
}

/* ---------- 시공팀(crew) 시공 스케줄 전용 화면 (읽기 전용 · 자기 팀 현장만) ---------- */
function crewSites() {
  return (state.sites || []).filter(s => _normName(s.team) === _normName(me.name))
    .sort((a, b) => (a.constructDate || '9999-99-99').localeCompare(b.constructDate || '9999-99-99'));
}
function startCrewSites() {
  if (!CLOUD || !me || me.role !== 'crew' || !me.name) return;
  try {
    cref('sites').where('team', '==', me.name).onSnapshot(snap => {
      state.sites = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'crew') render();
    }, err => console.warn('crew sites', err));
  } catch (e) { console.warn(e); }
}
function crewSiteCard(s) {
  const d = daysFromNow(s.constructDate);
  const dtag = d != null ? (d < 0 ? '지남' : (d === 0 ? '오늘' : 'D-' + d)) : '';
  const dcol = d != null && d >= 0 && d <= 3 ? 'var(--red-t)' : 'var(--gd)';
  const items = s.matPending ? `<span style="display:inline-block;background:#fdf3d6;border:0.5px solid #f0d38a;color:#8a5a00;border-radius:8px;padding:2px 8px;margin-top:3px;font-size:11.5px;font-weight:600"><i class="ti ti-help-circle" style="font-size:12px"></i> 자재 미정</span>` : siteItems(s).map(it => `<span style="display:inline-block;background:var(--soft,#f6f8f7);border:0.5px solid var(--bd);border-radius:8px;padding:2px 7px;margin:3px 3px 0 0;font-size:11.5px;word-break:keep-all">${esc(it.name)}${it.qty ? ' ' + it.qty : ''}</span>`).join('');
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0"><div style="font-size:15px;font-weight:700;word-break:keep-all">${esc(s.name || s.client || '-')}</div>${s.client && s.name ? `<div style="font-size:11.5px;color:var(--t3);margin-top:1px">${esc(s.client)}</div>` : ''}</div>
      <span class="pill p-prog" style="flex:none">${esc(s.stage || '접수')}</span>
    </div>
    ${(s.address || s.region) ? `<div style="font-size:12.5px;color:var(--t2);margin-top:6px;word-break:keep-all"><i class="ti ti-map-pin" style="font-size:12px"></i> ${esc(s.address || s.region)}</div>` : ''}
    <div style="display:flex;gap:14px;margin-top:8px;font-size:12.5px;flex-wrap:wrap">
      <div><span style="color:var(--t3)">시공</span> <b style="color:${dcol}">${esc(s.constructDate || '미정')}${dtag ? ' · ' + dtag : ''}</b></div>
      ${s.measureDate ? `<div><span style="color:var(--t3)">실측</span> <b>${esc(s.measureDate)}</b></div>` : ''}
      ${s.factory ? `<div><span style="color:var(--t3)">공장</span> <b>${esc(s.factory)}</b></div>` : ''}
      ${s.manager ? `<div><span style="color:var(--t3)">담당</span> <b>${esc(s.manager)}</b></div>` : ''}
    </div>
    ${items ? `<div style="margin-top:6px">${items}</div>` : ''}
    ${s.crewNote ? `<div style="margin-top:9px;background:var(--gl2,#e8f7f0);border:0.5px solid var(--gbd,#b8e6d3);border-radius:9px;padding:8px 10px;color:#0F6E56;word-break:keep-all"><b style="font-size:11px;display:block;margin-bottom:2px"><i class="ti ti-message-2" style="font-size:12px"></i> 전달사항</b><span style="font-size:12.5px">${esc(s.crewNote)}</span></div>` : ''}
  </div>`;
}
function crewListBody(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-calendar-off"></i>예정된 시공이 없습니다</div>`;
  return list.map(crewSiteCard).join('');
}
function crewCalendarHtml() {
  const ym = filters.crewMonth || todayStr().slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);
  const startDow = new Date(Y, M - 1, 1).getDay();
  const daysInMonth = new Date(Y, M, 0).getDate();
  const byDay = {};
  const monthSites = crewSites().filter(s => (s.constructDate || '').startsWith(ym)).sort((a, b) => (a.constructDate || '').localeCompare(b.constructDate || ''));
  monthSites.forEach(s => { const dd = +s.constructDate.slice(8, 10); (byDay[dd] = byDay[dd] || []).push(s); });
  const today = todayStr(), sel = filters.crewDay || '';
  const dow = ['일', '월', '화', '수', '목', '금', '토'];
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div></div>`;
  for (let dd = 1; dd <= daysInMonth; dd++) {
    const ds = `${ym}-${String(dd).padStart(2, '0')}`;
    const has = byDay[dd], isToday = ds === today, isSel = ds === sel;
    const dowIdx = (startDow + dd - 1) % 7;
    const hol = HOLIDAYS[ds];
    const col = (dowIdx === 0 || hol) ? '#d64545' : (dowIdx === 6 ? '#2f6fed' : 'var(--t1)');
    const chips = (has || []).map(s => { const tc = calTeamColor(s.team); return `<span style="font-size:9.5px;line-height:1.25;background:${isSel ? 'rgba(255,255,255,.22)' : tc + '22'};color:${isSel ? '#fff' : tc};border-radius:4px;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;display:block;margin-top:2px" title="${esc(s.team || '')}">${esc(s.name || s.client || '현장')}</span>`; }).join('');
    cells += `<button onclick="crewPickDay('${ds}')" style="min-height:52px;border:${isSel ? '0' : '0.5px solid var(--bd)'};background:${isSel ? 'var(--g)' : (isToday ? 'var(--gl2,#e8f7f0)' : '#fff')};border-radius:9px;display:flex;flex-direction:column;align-items:stretch;cursor:pointer;padding:4px 3px;overflow:hidden">
      <span style="font-size:12px;font-weight:${has ? '700' : '500'};color:${isSel ? '#fff' : col};text-align:left;line-height:1">${dd}</span>
      ${hol ? `<span style="font-size:8.5px;color:${isSel ? '#fff' : '#d64545'};font-weight:600;line-height:1.1;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hol}</span>` : ''}
      ${chips}
    </button>`;
  }
  const selList = sel ? crewSites().filter(s => s.constructDate === sel) : [];
  let below;
  if (sel) {
    below = `<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 8px"><div style="font-size:12.5px;color:var(--t2)"><b>${+sel.slice(5, 7)}/${+sel.slice(8, 10)}</b> 시공 ${selList.length}건</div><button class="btn btn-sm" style="padding:2px 10px" onclick="crewPickDay('${sel}')"><i class="ti ti-calendar"></i> 이달 목록</button></div>${crewListBody(selList)}`;
  } else if (monthSites.length) {
    const rows = monthSites.map(s => `<div onclick="crewPickDay('${s.constructDate}')" style="display:flex;gap:8px;align-items:center;padding:9px 10px;border-top:0.5px solid var(--bd);cursor:pointer">
      <div style="font-size:12px;font-weight:700;color:var(--gd);min-width:36px">${+s.constructDate.slice(5, 7)}/${+s.constructDate.slice(8, 10)}</div>
      <div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:600;word-break:keep-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name || s.client || '-')}</div>${s.address || s.region ? `<div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.address || s.region)}</div>` : ''}</div>
      <span class="pill p-prog" style="flex:none;font-size:10px">${esc(s.stage || '접수')}</span>
    </div>`).join('');
    below = `<div style="font-size:12px;color:var(--t3);margin:2px 0 4px">이달 시공 ${monthSites.length}건 · 날짜 또는 항목을 누르면 상세</div><div style="background:#fff;border:0.5px solid var(--bd);border-radius:12px;overflow:hidden">${rows}</div>`;
  } else {
    below = `<div class="empty"><i class="ti ti-calendar-off"></i>이달 예정된 시공이 없습니다</div>`;
  }
  return `<div style="background:#fff;border:0.5px solid var(--bd);border-radius:14px;padding:10px 6px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:0 4px">
      <button class="btn btn-sm" onclick="crewMonthShift(-1)" aria-label="이전달"><i class="ti ti-chevron-left"></i></button>
      <b style="font-size:16px">${Y}년 ${M}월</b>
      <button class="btn btn-sm" onclick="crewMonthShift(1)" aria-label="다음달"><i class="ti ti-chevron-right"></i></button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:6px">${dow.map((w, i) => `<div style="text-align:center;font-size:12px;font-weight:600;color:${i === 0 ? '#d64545' : (i === 6 ? '#2f6fed' : 'var(--t3)')}">${w}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px">${cells}</div>
  </div>
  <div style="margin-top:10px">${below}</div>`;
}
function crewMonthShift(delta) {
  const ym = filters.crewMonth || todayStr().slice(0, 7);
  let [Y, M] = ym.split('-').map(Number);
  M += delta; if (M < 1) { M = 12; Y--; } else if (M > 12) { M = 1; Y++; }
  filters.crewMonth = `${Y}-${String(M).padStart(2, '0')}`; render();
}
function crewPickDay(ds) { filters.crewDay = (filters.crewDay === ds ? '' : ds); render(); }
function goCrewTab(v) { filters.crewTab = v; render(); }
function renderCrewSchedule() {
  const tab = filters.crewTab || 'cal';
  const list = crewSites();
  const upcoming = list.filter(s => { const d = daysFromNow(s.constructDate); return d != null && d >= 0; });
  el('pg-stock').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-tools"></i>${esc(me.name)}</h2><p><i class="ti ti-calendar-event" style="font-size:12px"></i> 시공 스케줄 · 예정 ${upcoming.length}건</p></div>
      <button class="btn btn-sm" onclick="logout()"><i class="ti ti-logout"></i>로그아웃</button></div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${tab === 'cal' ? 'active' : ''}" onclick="goCrewTab('cal')"><i class="ti ti-calendar"></i> 캘린더</button>
      <button class="chip ${tab === 'list' ? 'active' : ''}" onclick="goCrewTab('list')"><i class="ti ti-list"></i> 목록${list.length ? ` (${list.length})` : ''}</button>
    </div>
    ${tab === 'cal' ? crewCalendarHtml() : crewListBody(list)}`;
}

/* ===================================================================
   화면 렌더링
   =================================================================== */

/* 현장 진행 단계 정의 (날짜 타임라인) */
const SITE_STAGES = ['접수', '가견적', '실측', '견적', '결제', '발주', '시공', '완료'];
function siteStageIndex(s) { return Math.max(0, SITE_STAGES.indexOf(s.stage || '접수')); }

/* 규격 파싱: "1600*3200*12" → {w,h,t,hebePerJang}.  장당 헤베 = 가로(m)×세로(m) */
function parseSpec(s) {
  if (!s) return { w: 0, h: 0, t: 0, hebePerJang: 0 };
  const n = String(s).split(/[*xX×]/).map(x => parseFloat(x) || 0);
  const w = n[0] || 0, h = n[1] || 0, t = n[2] || 0;
  return { w, h, t, hebePerJang: +((w * h) / 1e6).toFixed(3) };
}
/* 장당 헤베(㎡/장) 자동환산: 장수 × 장당헤베 = 헤베 */
function itemHebe(it) { return +(((+it.jang || 0) * (+it.hebePerJang || 0)).toFixed(2)); }
function jangToHebe(jang, it) { return +(((+jang || 0) * (+(it && it.hebePerJang) || 0)).toFixed(2)); }
/* 규격 select 옵션 (언더바) */
function specOptions(sel) {
  return '<option value="">규격 선택…</option>' +
    state.specs.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(sp =>
      `<option value="${esc(sp.value)}" ${sel === sp.value ? 'selected' : ''}>${esc(sp.value)}</option>`).join('') +
    '<option value="__add">+ 새 규격 추가…</option>';
}
async function addSpecValue(val) {
  val = (val || '').trim().replace(/\s+/g, '');
  if (!/^\d+[*xX×]\d+([*xX×]\d+)?$/.test(val)) { toast('형식: 가로*세로*두께 (예 1600*3200*12)'); return null; }
  val = val.replace(/[xX×]/g, '*');
  if (!state.specs.some(s => s.value === val)) await Store.add('specs', { value: val });
  return val;
}
/* 공장/시공팀 등 마스터 select 옵션 (언더바 + 새 항목 추가) */
function masterOptions(coll, sel) {
  return '<option value="">선택…</option>' +
    state[coll].slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(m =>
      `<option value="${esc(m.value)}" ${sel === m.value ? 'selected' : ''}>${esc(m.value)}</option>`).join('') +
    '<option value="__add">+ 새 항목 추가…</option>';
}
function onMasterChange(selId, coll) {
  const sel = el(selId), box = el(selId + '-add');
  if (sel.value === '__add') { if (box) box.classList.remove('hidden'); setTimeout(() => el(selId + '-new') && el(selId + '-new').focus(), 50); }
  else if (box) box.classList.add('hidden');
}
async function commitMaster(selId, coll) {
  const val = (el(selId + '-new').value || '').trim();
  if (!val) { toast('이름을 입력하세요'); return; }
  if (!state[coll].some(m => m.value === val)) await Store.add(coll, { value: val });
  el(selId).innerHTML = masterOptions(coll, val);
  el(selId + '-add').classList.add('hidden');
  toast('추가됨: ' + val);
}
/* select에 값 세팅(없으면 옵션 추가) — 자동추천 적용용 */
function setSelectValue(selId, coll, val) {
  if (!val) return;
  const sel = el(selId); if (!sel) return;
  if (![...sel.options].some(o => o.value === val)) {
    const o = document.createElement('option'); o.value = val; o.textContent = val;
    sel.insertBefore(o, sel.options[sel.options.length - 1]);
  }
  sel.value = val;
}
/* 홀딩의 자재 목록 (다자재 지원, 구버전 단일자재 호환) */
function holdItems(h) {
  if (h && h.items && h.items.length) return h.items.map(x => ({ materialName: x.materialName || x.name || '', jang: +x.jang || +x.qty || 0, hebe: +x.hebe || 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned }));
  return [{ materialName: (h && h.materialName) || '', jang: +(h && h.jang) || 0, hebe: +(h && h.hebe) || 0, lot: (h && h.lot) || '', pattern: (h && h.pattern) || '', planned: false }];
}
/* 현장의 자재 목록 (다자재 지원, 구버전 호환) */
function siteItems(s) {
  if (s && s.items && s.items.length) return s.items.map(x => ({ name: x.name || x.materialName || '', qty: x.qty != null ? x.qty : (x.jang || ''), lot: x.lot || '' }));
  return (s && s.materialName) ? [{ name: s.materialName, qty: s.qty || '', lot: s.lot || '' }] : [];
}
/* 활성 홀딩(예약 중 '홀딩')으로 잡힌 장수 합계 — 자재명 기준(다자재 합산) */
function heldJangFor(name) {
  if (!name) return 0; const key = _normName(name); let s = 0;
  state.holdings.forEach(h => { if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(it => { if (_normName(it.materialName) === key && !it.planned) s += (+it.jang || 0); }); });
  return s;
}
/* 가용재고 = 실재고 − 활성홀딩 */
function availJang(it) { return (+it.jang || 0) - heldJangFor(it.name) - Math.max(0, damagedStock(it.name)); }
/* 롯트별 재고: 입고(+) − 출고(−). 자재명 기준(띄어쓰기 무시). 롯트 미입력은 '(미지정)' */
function lotStock(name) {
  if (!name) return [];
  const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    const lot = (t.lot || '').trim() || '(미지정)';
    if (!m[lot]) m[lot] = { lot, inQty: 0, outQty: 0, adjQty: 0 };
    if (t.type === 'in') m[lot].inQty += (+t.jang || 0);
    else if (t.type === 'out') m[lot].outQty += (+t.jang || 0);
    else if (t.type === 'adjust') m[lot].adjQty += (+t.jang || 0);   // 재고 조정(±)
  });
  return Object.values(m).map(x => ({ lot: x.lot, inQty: x.inQty, outQty: x.outQty, remain: x.inQty - x.outQty + x.adjQty }))
    .filter(x => x.inQty > 0 || x.adjQty !== 0 || x.remain !== 0)
    .sort((a, b) => b.remain - a.remain);
}
/* 폼용 롯트 select 옵션(잔여 있는 실제 롯트만). 롯트가 하나만 남으면 자동 선택 */
function soleLot(name) {
  const ls = lotStock(name).filter(l => l.lot !== '(미지정)' && l.remain > 0);
  return ls.length === 1 ? ls[0].lot : '';
}
function lotSelectHtml(name, current) {
  const lots = lotStock(name).filter(l => l.lot !== '(미지정)' && l.remain > 0);
  const sel = current || (lots.length === 1 ? lots[0].lot : '');   // 롯트 하나면 자동 선택
  let html = '<option value="">롯트 선택 (선택사항)</option>';
  lots.forEach(l => { html += `<option value="${esc(l.lot)}" ${sel === l.lot ? 'selected' : ''}>${esc(l.lot)} · 잔여 ${l.remain}장</option>`; });
  if (sel && !lots.some(l => l.lot === sel)) html += `<option value="${esc(sel)}" selected>${esc(sel)}</option>`;
  return html;
}
function lotBreakdownText(name) {
  const lots = lotStock(name);
  if (!lots.length) return '';
  return '롯트별 잔여: ' + lots.map(l => `${esc(l.lot)} <b style="color:${l.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${l.remain}장</b>`).join(' · ');
}
/* 자재별 패턴 목록: 입고 기록의 patterns 에서 수집 */
function patternList(name) {
  if (!name) return []; const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (t.type !== 'in' || _normName(t.itemName) !== key) return;
    (t.patterns || []).forEach(p => { const nm = (p.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) + (+p.jang || 0); });
  });
  return Object.keys(m).map(k => ({ pattern: k, qty: m[k] })).sort((a, b) => b.qty - a.qty);
}
/* 패턴별 잔여 재고 (입고 patterns − 출고 pattern) */
function patternStock(name) {
  if (!name) return []; const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    if (t.type === 'in') { (t.patterns || []).forEach(p => { const nm = (p.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) + (+p.jang || 0); }); }
    else if (t.type === 'out') { const nm = (t.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) - (+t.jang || 0); }
    else if (t.type === 'adjust') { const nm = (t.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) + (+t.jang || 0); }   // 재고 조정(±)
  });
  return Object.keys(m).map(k => ({ pattern: k, remain: m[k] })).filter(x => x.remain !== 0).sort((a, b) => b.remain - a.remain);
}
/* 재고 표 셀용: 패턴별 잔여 요약 */
function patternStockCell(name) {
  const ps = patternStock(name);
  if (!ps.length) return '<span style="color:var(--t3)">-</span>';
  return ps.map(p => `<div style="white-space:nowrap">${esc(p.pattern)} <b style="color:${p.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${p.remain}</b>장</div>`).join('');
}
/* 창고별 재고: 입고(+) − 출고(−) + 조정(±). 창고 미기록건은 품목 기본창고로 귀속. 자재명 기준 */
function depotStock(name) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(name));
  const def = (it && it.depot) ? it.depot : '본사';
  const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    const dep = (t.depot || '').trim() || def;
    if (!m[dep]) m[dep] = { depot: dep, inQty: 0, outQty: 0, adjQty: 0 };
    if (t.type === 'in') m[dep].inQty += (+t.jang || 0);
    else if (t.type === 'out') m[dep].outQty += (+t.jang || 0);
    else if (t.type === 'adjust') m[dep].adjQty += (+t.jang || 0);
  });
  return Object.values(m).map(x => ({ depot: x.depot, inQty: x.inQty, outQty: x.outQty, remain: x.inQty - x.outQty + x.adjQty }))
    .filter(x => x.inQty > 0 || x.remain !== 0)
    .sort((a, b) => b.remain - a.remain);
}
function depotOptions() { return [...new Set((state.inventory || []).map(i => i.depot).filter(Boolean).concat((state.transactions || []).map(t => (t.depot || '').trim()).filter(Boolean)))].sort(); }
/* 자재행 창고 선택칸 옵션 — 창고 2곳 이상(창고별 재고 있는 자재)만 목록 표시, 아니면 빈 문자열 반환(칸 숨김) */
function depotSelectHtml(name, current) {
  const ds = depotStock(name).filter(d => d.remain > 0);
  if (ds.length <= 1) return '';   // 창고 한 곳뿐 → 선택 불필요
  const cur = (current || '').trim();
  let html = '<option value="">창고 선택 (창고별 재고)</option>';
  ds.forEach(d => { html += `<option value="${esc(d.depot)}" ${cur === d.depot ? 'selected' : ''}>${esc(d.depot)} · 잔여 ${d.remain}장</option>`; });
  if (cur && !ds.some(d => d.depot === cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  return html;
}
/* 파손 재고: 입고 비고에 '파손' 포함(+) − 출고 비고에 '파손' 포함(−). 자재명 기준 */
function damagedStock(name) {
  if (!name) return 0;
  const key = _normName(name); let n = 0;
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    if (t.type === 'damage') { n += (+t.jang || 0); return; }   // 파손 처리(+)/복구(−)
    // '파손 자재'로 표시된 입·출고만 반영. damaged 플래그 우선, 없으면(구버전) note '파손'으로 판단
    const dmgFlag = (t.damaged === true) || (t.damaged === undefined && /파손/.test(t.note || ''));
    if (!dmgFlag) return;
    if (t.type === 'in') n += (+t.jang || 0);
    else if (t.type === 'out') n -= (+t.jang || 0);   // 파손 자재 출고 → 파손 재고에서 차감(폐기·반품)
  });
  return n;
}
function patternSelectHtml(name, current) {
  // 품목에 정의된 패턴 + 입고 이력 패턴을 모두 표시 (입고에 패턴이 없어도 지정 가능)
  const qtyMap = {}; patternStock(name).forEach(p => { qtyMap[p.pattern] = p.remain; });
  patternList(name).forEach(p => { if (qtyMap[p.pattern] == null) qtyMap[p.pattern] = p.qty; });
  const names = []; const seen = new Set();
  matPatternDefs(name).forEach(pn => { pn = (pn || '').trim(); if (pn && pn !== '-' && !seen.has(pn)) { seen.add(pn); names.push(pn); } });
  Object.keys(qtyMap).forEach(pn => { if (pn && pn !== '-' && !seen.has(pn)) { seen.add(pn); names.push(pn); } });
  let html = '<option value="">패턴 선택 (선택)</option>';
  names.forEach(pn => { const q = qtyMap[pn]; html += `<option value="${esc(pn)}" ${current === pn ? 'selected' : ''}>${esc(pn)}${q != null ? ` · ${q}장` : ''}</option>`; });
  if (current && !seen.has(current)) html += `<option value="${esc(current)}" selected>${esc(current)}</option>`;
  return html;
}
/* ===== 예정 입고(재입고 예정) ===== */
/* 특정 자재의 활성(미완료) 예정입고 — 예정일 빠른 순 */
function restocksForItem(name) {
  const key = _normName(name);
  return (state.restocks || []).filter(r => !r.done && _normName(r.itemName) === key)
    .sort((a, b) => (a.expectedDate || '9999-99-99').localeCompare(b.expectedDate || '9999-99-99'));
}
/* 자재의 가장 이른 재입고 예정일 (없으면 '') */
function restockDateForItem(name) { const r = restocksForItem(name)[0]; return r ? (r.expectedDate || '') : ''; }
/* 자재의 예정입고 총 장수(미완료 합계) */
function plannedJangFor(name) { return restocksForItem(name).reduce((a, r) => a + (+r.jang || 0), 0); }
/* 예정입고 변경 후: inventory.restockDate 를 최신 예정일로 동기화(고객 화면 노출용) */
async function syncItemRestock(name) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(name));
  if (!it) return;
  const d = restockDateForItem(name);
  if ((it.restockDate || '') !== d) { try { await Store.update('inventory', it.id, { restockDate: d }); } catch (e) { } }
}
/* 입고 등록 시: 해당 자재의 활성 예정입고를 완료 처리 + 미러 동기화 */
async function clearRestocksOnIn(name) {
  for (const r of restocksForItem(name)) { try { await Store.update('restocks', r.id, { done: true, doneDate: todayStr() }); } catch (e) { } }
  await syncItemRestock(name);
}
/* 재고 부족 판정 (가용재고 기준 안전재고) */
function stockState(it) {
  const avail = availJang(it), safe = +it.safeJang || 0;
  if (avail <= 0) return { k: '없음', cls: 'p-issue' };
  if (safe > 0 && avail < safe) return { k: '부족', cls: 'p-wait' };
  if (safe > 0 && avail < safe * 1.5) return { k: '임박', cls: 'p-wait' };
  return { k: '정상', cls: 'p-prog' };
}
/* 입고 후: 예정홀딩을 검사해 '자재가 전부 가용 범위에 들면' 오래된 순으로 자동 활성화(다자재) */
async function activatePlannedHolds(name, physJang) {
  // 대상: 예정 홀딩 + '홀딩'인데 일부 품목이 예정(planned)인 건
  const cand = state.holdings.filter(h => !['확정', '해제'].includes(h.status || '홀딩') && ((h.status === '예정') || holdItems(h).some(it => it.planned)))
    .sort((a, b) => (a.useDate || '9999').localeCompare(b.useDate || '9999') || (a.createdAt || 0) - (b.createdAt || 0));
  if (!cand.length) return 0;
  const extra = {};
  function physOf(mat) {
    if (name && _normName(mat) === _normName(name) && physJang != null) return physJang;
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); return it ? +it.jang || 0 : 0;
  }
  function availOf(mat) { return physOf(mat) - heldJangFor(mat) - (extra[_normName(mat)] || 0) - Math.max(0, damagedStock(mat)); }
  let count = 0;
  for (const h of cand) {
    const items = holdItems(h);
    let changed = false;
    const newItems = items.map(it => {
      const needsStock = it.planned || (h.status === '예정');   // '예정' 홀딩은 플래그가 없어도 전 품목을 예정으로 간주
      if (needsStock && availOf(it.materialName) >= (+it.jang || 0)) {   // 이제 재고 확보 → 활성화
        extra[_normName(it.materialName)] = (extra[_normName(it.materialName)] || 0) + (+it.jang || 0);
        changed = true;
        return Object.assign({}, it, { planned: false });
      }
      return needsStock ? Object.assign({}, it, { planned: true }) : it;   // 재고 못 잡으면 예정 유지
    });
    if (changed) {
      const newStatus = newItems.every(x => x.planned) ? '예정' : '홀딩';
      const patch = { items: newItems, status: newStatus };
      if (!newItems.some(x => x.planned) && h.autoDemoted) patch.autoDemoted = false;   // 다시 전부 확보되면 강등표시 해제
      await Store.update('holdings', h.id, patch);
      count++;
    }
  }
  return count;
}
/* ── 임박 홀딩 선점(preemption) ──
   가용이 없을 때: 사용일이 3일 이내로 임박했지만 재고를 못 잡은(예정) 품목이,
   3주(21일) 이상 남은 기존 활성 홀딩의 같은 자재 수량을 가져온다.
   밀려난(먼) 홀딩은 그만큼 예정홀딩으로 내려간다. 물리 재고 총량은 불변(재배치만).
   정책: 완전 자동 / 트리거 3일 이내 / 보호 3주 이상 / 알림은 직원에게만. */
const PREEMPT_URGENT_DAYS = 3, PREEMPT_FAROUT_DAYS = 21;
async function preemptForUrgent() {
  if (!me || isCustomerRole() || !CLOUD) return 0;
  // 확정·해제 아닌 활성 홀딩만, 품목 클론(불변 원본 보존)
  const work = state.holdings
    .filter(h => !['확정', '해제'].includes(h.status || '홀딩'))
    .map(h => ({ h, items: holdItems(h).map(x => ({ materialName: x.materialName, jang: +x.jang || 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned })) }));
  if (!work.length) return 0;
  const mats = new Set();
  work.forEach(w => w.items.forEach(it => { if (it.materialName) mats.add(_normName(it.materialName)); }));
  const changed = new Set();
  const moves = [];
  for (const matKey of mats) {
    let guard = 0;
    while (guard++ < 300) {
      // 임박 미충족(planned) 품목: 사용일 today~+3(지난 것 포함), 이른 순
      let U = null;
      for (const w of work.slice().sort((a, b) => (a.h.useDate || '9999-99-99').localeCompare(b.h.useDate || '9999-99-99'))) {
        const d = daysFromNow(w.h.useDate);
        if (d == null || d > PREEMPT_URGENT_DAYS) continue;
        const it = w.items.find(x => _normName(x.materialName) === matKey && x.planned && x.jang > 0);
        if (it) { U = { w, it }; break; }
      }
      if (!U) break;
      // 기증 후보: 사용일 21일 이상 남고, 활성(non-planned) 재고 보유. 가장 멀리 남은 것부터
      let D = null;
      for (const w of work.slice().sort((a, b) => (b.h.useDate || '0000-00-00').localeCompare(a.h.useDate || '0000-00-00'))) {
        const d = daysFromNow(w.h.useDate);
        if (d == null || d < PREEMPT_FAROUT_DAYS) continue;
        if (w === U.w) continue;
        const it = w.items.find(x => _normName(x.materialName) === matKey && !x.planned && x.jang > 0);
        if (it) { D = { w, it }; break; }
      }
      if (!D) break;
      const x = Math.min(U.it.jang, D.it.jang);
      if (x <= 0) break;
      // U: planned → active (x장 확보)
      U.it.jang -= x;
      const uAct = U.w.items.find(y => _normName(y.materialName) === matKey && !y.planned);
      if (uAct) uAct.jang += x; else U.w.items.push({ materialName: U.it.materialName, jang: x, lot: U.it.lot, pattern: U.it.pattern, planned: false });
      // D: active → planned (x장 강등)
      D.it.jang -= x;
      const dPl = D.w.items.find(y => _normName(y.materialName) === matKey && y.planned);
      if (dPl) dPl.jang += x; else D.w.items.push({ materialName: D.it.materialName, jang: x, lot: D.it.lot, pattern: D.it.pattern, planned: true });
      changed.add(U.w); changed.add(D.w);
      moves.push({ donor: D.w.h.vendor || '', mat: D.it.materialName, x, urgent: U.w.h.vendor || '', useDate: U.w.h.useDate || '' });
    }
  }
  if (!changed.size) return 0;
  for (const w of changed) {
    const items = w.items.filter(x => x.jang > 0).map(x => {
      const inv = state.inventory.find(i => _normName(i.name) === _normName(x.materialName));
      return { materialName: x.materialName, jang: x.jang, hebe: inv ? +((x.jang) * (+inv.hebePerJang || 0)).toFixed(2) : 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned };
    });
    if (!items.length) continue;
    const status = items.every(x => x.planned) ? '예정' : '홀딩';
    const first = items[0];
    const patch = { items, status, materialName: first.materialName, jang: first.jang, hebe: first.hebe, lot: first.lot || '' };
    const hadPlanned = holdItems(w.h).some(x => x.planned);
    if (!hadPlanned && items.some(x => x.planned)) { patch.autoDemoted = true; patch.autoDemotedAt = Date.now(); }   // 강등 표시(직원 홈 알림용)
    try { await Store.update('holdings', w.h.id, patch); } catch (e) { }
  }
  // 직원에게만 알림: 현재 세션 토스트 + 홈 화면 '자동조정' 배지(autoDemoted). 고객에겐 조용히 '예정'으로만 표시.
  try { toast('홀딩 자동조정 ' + moves.length + '건: 임박 건에 재고 배정, 먼 건은 예정으로'); } catch (e) { }
  return changed.size;
}
/* 수동 당겨오기: 이 홀딩의 부족분(예정)을 다른 홀딩(가장 먼 일정부터)에서 강제로 당겨온다.
   3일/21일 조건 무관 — 직원이 직접 판단해 재배치. 물리 재고 총량 불변. */
async function pullStockForHold(id) {
  const target = state.holdings.find(h => h.id === id); if (!target) return;
  const tItems = holdItems(target).map(x => ({ materialName: x.materialName, jang: +x.jang || 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned }));
  const needs = tItems.filter(x => x.planned && x.jang > 0 && x.materialName);
  if (!needs.length) { toast('이 홀딩은 부족분(예정)이 없습니다'); return; }
  const donors = state.holdings.filter(h => h.id !== id && !['확정', '해제'].includes(h.status || '홀딩'))
    .map(h => ({ h, items: holdItems(h).map(x => ({ materialName: x.materialName, jang: +x.jang || 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned })) }));
  const moves = []; const changedDonors = new Set();
  for (const need of needs) {
    let remaining = need.jang; const key = _normName(need.materialName);
    const sorted = donors.slice().sort((a, b) => (b.h.useDate || '0000-00-00').localeCompare(a.h.useDate || '0000-00-00'));   // 먼 일정 우선
    for (const d of sorted) {
      if (remaining <= 0) break;
      const di = d.items.find(x => _normName(x.materialName) === key && !x.planned && x.jang > 0);
      if (!di) continue;
      const x = Math.min(remaining, di.jang);
      di.jang -= x;
      const dPl = d.items.find(y => _normName(y.materialName) === key && y.planned);
      if (dPl) dPl.jang += x; else d.items.push({ materialName: di.materialName, jang: x, lot: di.lot, pattern: di.pattern, planned: true });
      remaining -= x; changedDonors.add(d); moves.push({ donor: d.h.vendor || '', x });
    }
    const got = need.jang - remaining;
    if (got > 0) { need.jang -= got; const tAct = tItems.find(x => _normName(x.materialName) === key && !x.planned); if (tAct) tAct.jang += got; else tItems.push({ materialName: need.materialName, jang: got, lot: need.lot, pattern: need.pattern, planned: false }); }
  }
  const total = moves.reduce((a, b) => a + b.x, 0);
  if (!total) { toast('당겨올 다른 홀딩 재고가 없습니다 (전부 부족·예정 상태)'); return; }
  if (!confirm(`다른 홀딩에서 ${total}장을 이 홀딩으로 당겨올까요?\n· 먼 일정 홀딩이 그만큼 '예정'으로 내려갑니다\n· 실물 재고 총량은 그대로입니다`)) return;
  const writeHold = (h, items) => {
    const clean = items.filter(x => x.jang > 0).map(x => { const inv = state.inventory.find(i => _normName(i.name) === _normName(x.materialName)); return { materialName: x.materialName, jang: x.jang, hebe: inv ? +((x.jang) * (+inv.hebePerJang || 0)).toFixed(2) : 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned }; });
    if (!clean.length) return null;
    const status = clean.every(x => x.planned) ? '예정' : '홀딩'; const first = clean[0];
    return { items: clean, status, materialName: first.materialName, jang: first.jang, hebe: first.hebe, lot: first.lot || '' };
  };
  try {
    const tp = writeHold(target, tItems);
    if (tp) { if (!tp.items.some(x => x.planned) && target.autoDemoted) tp.autoDemoted = false; await Store.update('holdings', target.id, tp); }
    for (const d of changedDonors) { const dp = writeHold(d.h, d.items); if (dp) { const hadPlanned = holdItems(d.h).some(x => x.planned); if (!hadPlanned && dp.items.some(x => x.planned)) { dp.autoDemoted = true; dp.autoDemotedAt = Date.now(); } await Store.update('holdings', d.h.id, dp); } }
    toast('당겨오기 완료 · ' + total + '장 재배정 (먼 일정은 예정으로)');
  } catch (e) { toast('당겨오기 실패'); }
}
/* ===== 자재 여러 줄 입력 컴포넌트 (현장/홀딩 공용) ===== */
let _mrowN = 0, _mrowPattern = false, _mrowDepot = false;   // _mrowPattern: 패턴 선택칸 표시 / _mrowDepot: 출고 폼에서 true → 창고별 재고 선택칸 표시
function matRowHtml(d, qtyPh) {
  d = d || {}; const i = _mrowN++; const nm = d.name || d.materialName || '';
  const selStyle = 'width:100%;margin-top:6px;font-size:14px;padding:8px;border:1.5px solid var(--bd2);border-radius:9px';
  return `<div class="mrow" style="margin-bottom:8px;border:1px solid var(--bd2);border-radius:10px;padding:8px 9px">
    <div style="display:flex;gap:6px;align-items:center">
      <div style="flex:2.2">${searchBox('mrow-' + i, '자재명 검색·입력', nm, 'matNames', 'mrowLotRefresh')}</div>
      <input class="m-qty" style="flex:1;min-width:54px;font-size:16px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px" inputmode="decimal" placeholder="${qtyPh || '수량'}" value="${esc(d.qty || d.jang || '')}" oninput="mrowLotRefresh()">
      <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.mrow').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
    </div>
    <select class="m-lot" style="${selStyle}">${lotSelectHtml(nm, d.lot || '')}</select>
    ${_mrowPattern ? `<select class="m-pattern" style="${selStyle}">${patternSelectHtml(nm, d.pattern || '')}</select>` : ''}
    ${_mrowDepot ? `<select class="m-depot" style="${selStyle};display:none"></select>` : ''}
    <div class="m-info" style="font-size:11px;color:var(--t3);margin-top:4px"></div>
  </div>`;
}
function matRowsHtml(items, qtyPh) {
  const arr = (items && items.length) ? items : [{}];
  return `<div id="mat-rows">${arr.map(it => matRowHtml(it, qtyPh)).join('')}</div>
    <button type="button" class="btn btn-ghost btn-sm btn-block" style="margin-bottom:6px" onclick="addMaterialRow({}, '${qtyPh || '수량'}')"><i class="ti ti-plus"></i>자재 추가</button>`;
}
function addMaterialRow(d, qtyPh) {
  const box = el('mat-rows'); if (!box) return;
  box.insertAdjacentHTML('beforeend', matRowHtml(d, qtyPh)); mrowLotRefresh();
}
function mrowLotRefresh() {
  document.querySelectorAll('#mat-rows .mrow').forEach(row => {
    const inp = row.querySelector('input.sb-in'); if (!inp) return;
    const mat = (inp.value || '').trim();
    const lotSel = row.querySelector('select.m-lot');
    if (lotSel) { const cur = lotSel.value; lotSel.innerHTML = lotSelectHtml(mat, cur); }
    const patSel = row.querySelector('select.m-pattern');
    if (patSel) { const cur = patSel.value; patSel.innerHTML = patternSelectHtml(mat, cur); }
    const depSel = row.querySelector('select.m-depot');
    if (depSel) { const cur = depSel.value; const h = depotSelectHtml(mat, cur); depSel.innerHTML = h; depSel.style.display = h ? '' : 'none'; }
    const info = row.querySelector('.m-info');
    if (info) {
      const it = state.inventory.find(x => x.name === mat); const q = parseFloat(row.querySelector('.m-qty').value) || 0;
      info.innerHTML = it ? ('가용 <b style="color:' + (availJang(it) <= 0 ? 'var(--red-t)' : 'var(--gd)') + '">' + availJang(it) + '장</b> / 실재고 ' + (+it.jang || 0) + '장' + (q > 0 ? ' · 헤베 ' + (q * (+it.hebePerJang || 0)).toFixed(2) + '㎡' : '')) : (mat ? '<span style="color:var(--amber-t)">재고에 없는 자재 (입고 시 자동 전환)</span>' : '');
    }
  });
}
function collectMaterialRows() {
  const rows = [];
  document.querySelectorAll('#mat-rows .mrow').forEach(row => {
    const inp = row.querySelector('input.sb-in'); const name = inp ? (inp.value || '').trim() : '';
    const qty = parseFloat(row.querySelector('.m-qty').value) || 0;
    const lot = (row.querySelector('select.m-lot').value || '').trim();
    const patSel = row.querySelector('select.m-pattern');
    const pattern = patSel ? (patSel.value || '').trim() : '';
    const depSel = row.querySelector('select.m-depot');
    const depot = depSel ? (depSel.value || '').trim() : '';
    if (name && qty > 0) rows.push({ name: name, qty: qty, lot: lot, pattern: pattern, depot: depot });
  });
  return rows;
}
/* 발주 + 시공일 도래 → 자동 '시공' 전환 */
let _autoStageRun = false;
async function autoAdvanceStages() {
  if (_autoStageRun) return;
  const due = state.sites.filter(s => s.stage === '발주' && s.constructDate && daysFromNow(s.constructDate) <= 0);
  if (!due.length) return;
  _autoStageRun = true;
  for (const s of due) {
    const hist = Object.assign({}, s.history || {}); if (!hist['시공']) hist['시공'] = todayStr();
    try { await Store.update('sites', s.id, { stage: '시공', history: hist }); } catch (e) { }
  }
  setTimeout(() => { _autoStageRun = false; }, 5000);
}
/* 사용예정일 지난 홀딩 → 자동 '해제'(삭제 아님, 지난·해제 내역으로 이동) */
let _autoRelRun = false;
async function autoReleaseHolds() {
  if (_autoRelRun) return;
  const due = state.holdings.filter(h => (h.status === '홀딩' || h.status === '예정') && h.useDate && daysFromNow(h.useDate) < 0);
  if (!due.length) return;
  _autoRelRun = true;
  for (const h of due) {
    try { await Store.update('holdings', h.id, { status: '해제', releasedAuto: true, releasedDate: todayStr() }); } catch (e) { }
  }
  setTimeout(() => { _autoRelRun = false; }, 5000);
}
/* 활성 홀딩 목록 (현장/출고에서 골라쓰기용) */
function activeHoldings() { return state.holdings.filter(h => (h.status || '홀딩') === '홀딩'); }
/* 현장에서 불러올 수 있는 홀딩 (진행 홀딩 + 예정홀딩) */
function holdingsForSite() { return state.holdings.filter(h => ['홀딩', '예정'].includes(h.status || '홀딩')); }
function holdingOptions() {
  const list = holdingsForSite();
  if (!list.length) return '';
  return list.sort((a, b) => {
    const pa = a.status === '예정' ? 1 : 0, pb = b.status === '예정' ? 1 : 0;   // 진행 홀딩 먼저, 예정은 뒤
    if (pa !== pb) return pa - pb;
    return (a.useDate || '').localeCompare(b.useDate || '');
  }).map(h =>
    `<option value="${esc(h.id)}">${h.status === '예정' ? '[예정] ' : ''}${esc(h.vendor || '')} · ${esc(h.materialName || '')} · ${+h.jang || 0}장${h.useDate ? ' · ' + esc(h.useDate) : ''}</option>`).join('');
}
/* 현장 목록 옵션 (홀딩에서 골라쓰기용) */
function siteOptions(sel) {
  return state.sites.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(s =>
    `<option value="${esc(s.id)}" ${sel === s.id ? 'selected' : ''}>${esc(s.name || '(이름없음)')}${s.client ? ' · ' + esc(s.client) : ''}${s.materialName ? ' · ' + esc(s.materialName) : ''}${s.constructDate ? ' · 시공 ' + esc(s.constructDate) : ''}</option>`).join('');
}
/* 등록된 품목 select 옵션 */
function itemOptions(sel) {
  return '<option value="">자재 선택…</option>' + state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(i => `<option value="${esc(i.id)}" ${sel === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.spec || '')} · 재고 ${+i.jang || 0}장)</option>`).join('');
}

/* ---------- 홈 ---------- */
function renderHome() {
  const lowItems = state.inventory.filter(i => { const s = stockState(i).k; return s === '부족' || s === '없음'; });
  const activeSites = state.sites.filter(s => s.stage !== '완료');
  const soonConstruct = state.sites.filter(s => { const d = daysFromNow(s.constructDate); return s.stage !== '완료' && d != null && d >= 0 && d <= 3; });
  const soonHold = state.holdings.filter(h => { const d = daysFromNow(h.useDate); return (h.status || '홀딩') === '홀딩' && d != null && d >= 0 && d <= 3; });
  const plannedHolds = state.holdings.filter(h => h.status === '예정');
  const waitQuote = state.sites.filter(s => ['접수', '가견적', '견적'].includes(s.stage));

  const alerts = buildAlerts();
  const _adism = getAlertDismissed();
  const visible = alerts.filter(a => !_adism.includes(a.key));

  el('pg-home').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-layout-dashboard"></i>주요 현황</h2><p>${new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} 기준 · 실시간 공유</p></div></div>

    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bolt"></i>빠른 작업</h3></div>
      <div class="qa-grid">
        <button class="qa" onclick="go('stock');setTimeout(openStockForm,50)"><span class="qi ic g"><i class="ti ti-login"></i></span><span><b>입고 등록</b><small>자재 입고</small></span></button>
        <button class="qa" onclick="go('ship');setTimeout(openShipForm,50)"><span class="qi ic b"><i class="ti ti-logout"></i></span><span><b>출고 등록</b><small>현장·공장</small></span></button>
        <button class="qa" onclick="go('sites');setTimeout(openSiteForm,50)"><span class="qi ic a"><i class="ti ti-building-community"></i></span><span><b>현장 등록</b><small>신규 현장</small></span></button>
        <button class="qa" onclick="go('hold');setTimeout(openHoldForm,50)"><span class="qi ic r"><i class="ti ti-lock-plus"></i></span><span><b>홀딩 등록</b><small>자재 홀딩</small></span></button>
      </div>
    </div>

    <div class="stat-grid">
      <button class="stat tap" onclick="openStockTab('all')"><div class="ic g"><i class="ti ti-packages"></i></div><div class="v">${state.inventory.length}</div><div class="l">재고 품종 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">실재고 ${state.inventory.reduce((a, b) => a + (+b.jang || 0), 0)}장 · 가용 ${state.inventory.reduce((a, b) => a + availJang(b), 0)}장</div></button>
      <button class="stat tap" onclick="openStockTab('low')"><div class="ic r"><i class="ti ti-alert-triangle"></i></div><div class="v" style="color:${lowItems.length ? 'var(--red-t)' : 'inherit'}">${lowItems.length}</div><div class="l">재고 부족 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">${lowItems.length ? '입고 필요' : '정상 운영'}</div></button>
      <button class="stat tap" onclick="filters.sites='all';go('sites')"><div class="ic b"><i class="ti ti-building-community"></i></div><div class="v">${activeSites.length}</div><div class="l">진행 현장 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">시공임박 ${soonConstruct.length}</div></button>
      <button class="stat tap" onclick="go('hold')"><div class="ic a"><i class="ti ti-lock"></i></div><div class="v">${state.holdings.filter(h => (h.status || '홀딩') === '홀딩').length}</div><div class="l">홀딩 건수 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">임박 ${soonHold.length} · 예정 ${plannedHolds.length}</div></button>
    </div>

    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bell-ringing"></i>긴급 알림</h3><span class="more tap" onclick="openAlerts()" style="cursor:pointer">${visible.length}건${visible.length > 8 ? ' · 전체보기' : ''} <i class="ti ti-chevron-right"></i></span></div>
      <div id="home-alerts">
        ${visible.length ? visible.slice(0, 8).map(alertRowHtml).join('') : `<div class="empty"><i class="ti ti-circle-check"></i>처리할 긴급 항목이 없습니다</div>`}
      </div>
      ${visible.length > 8 ? `<button class="btn btn-ghost btn-block" style="margin-top:8px" onclick="openAlerts()"><i class="ti ti-list"></i>전체 ${visible.length}건 보기</button>` : ''}
      ${_adism.length ? `<button class="btn btn-ghost btn-sm btn-block" style="margin-top:6px;color:var(--t3)" onclick="clearAlertDismiss()"><i class="ti ti-rotate"></i>확인한 알림 다시 보기 (${_adism.length})</button>` : ''}
    </div>`;
}
/* ---------- 긴급 알림: 생성 + 기기별 '확인(숨김)' ---------- */
function buildAlerts() {
  const alerts = [];
  const lowItems = state.inventory.filter(i => { const s = stockState(i).k; return s === '부족' || s === '없음'; });
  const soonConstruct = state.sites.filter(s => { const d = daysFromNow(s.constructDate); return s.stage !== '완료' && d != null && d >= 0 && d <= 3; });
  const soonHold = state.holdings.filter(h => { const d = daysFromNow(h.useDate); return (h.status || '홀딩') === '홀딩' && d != null && d >= 0 && d <= 3; });
  const plannedHolds = state.holdings.filter(h => h.status === '예정');
  const waitQuote = state.sites.filter(s => ['접수', '가견적', '견적'].includes(s.stage));
  const openIssues = state.issues.filter(i => i.status !== '처리완료');
  const holdReqs = (state.holdRequests || []).filter(r => (r.status || '대기') === '대기');
  holdReqs.forEach(r => { const items = (r.items || []).map(it => `${it.materialName} ${+it.jang || 0}장`).join(', '); alerts.push({ key: 'holdreq|' + r.id, c: 'a', ic: 'ti-lock-plus', t: `${r.vendor || ''} 홀딩 요청`, s: items + (r.useDate ? ` · 사용 ${r.useDate}` : '') + (r.note ? ` · ${r.note}` : ''), tag: '홀딩요청' }); });
  lowItems.forEach(i => alerts.push({ key: 'low|' + i.name, c: 'r', ic: 'ti-alert-triangle', t: `${i.name} 입고 필요`, s: `가용 ${availJang(i)}장 · 안전재고 ${(+i.safeJang || 0)}장 미만`, tag: '재고부족' }));
  openIssues.forEach(i => alerts.push({ key: 'issue|' + (i.id || i.reason), c: 'r', ic: 'ti-alert-triangle', t: `${i.siteName || '현장'} 이슈 미해결`, s: (i.reason || '').slice(0, 40), tag: '이슈' }));
  plannedHolds.forEach(h => alerts.push({ key: 'plan|' + h.id, c: 'a', ic: 'ti-clock-pause', t: `${h.materialName || '-'} 입고 대기`, s: `${h.vendor || ''} · ${(+h.jang || 0)}장 예약(예정홀딩) · 입고 시 자동 전환`, tag: '예정홀딩' }));
  const demoted = state.holdings.filter(h => h.autoDemoted && !['확정', '해제'].includes(h.status || '홀딩') && holdItems(h).some(x => x.planned));
  demoted.forEach(h => alerts.push({ key: 'demote|' + h.id, c: 'a', ic: 'ti-transfer', t: `${h.vendor || ''} 홀딩 자동 조정됨`, s: `임박 건에 재고 양보 → 일부 예정홀딩 전환 · 사용예정 ${h.useDate || '-'}`, tag: '자동조정' }));
  soonConstruct.forEach(s => alerts.push({ key: 'const|' + s.id + '|' + s.constructDate, c: 'a', ic: 'ti-tools', t: `${s.name} 시공 임박`, s: `${s.constructDate} 시공 예정 · ${s.team || '시공팀 미정'}`, tag: 'D-' + daysFromNow(s.constructDate) }));
  soonHold.forEach(h => alerts.push({ key: 'hold|' + h.id + '|' + h.useDate, c: 'b', ic: 'ti-lock', t: `${h.vendor} 홀딩 사용 임박`, s: `${h.materialName} ${(+h.hebe || 0).toFixed(1)}㎡ · ${h.useDate} 사용`, tag: '홀딩' }));
  waitQuote.forEach(s => alerts.push({ key: 'quote|' + s.id + '|' + s.stage, c: 'a', ic: 'ti-file-invoice', t: `${s.name} 견적 진행 필요`, s: `현재 단계: ${s.stage} · ${s.client || ''}`, tag: s.stage }));
  const _recency = a => {
    const k = a.key || '';
    if (k.indexOf('holdreq|') === 0) { const x = (state.holdRequests || []).find(r => 'holdreq|' + r.id === k); return x ? +x.createdAt || 0 : 0; }
    if (k.indexOf('low|') === 0) { const it = state.inventory.find(i => 'low|' + i.name === k); return it ? +it.createdAt || 0 : 0; }
    if (k.indexOf('issue|') === 0) { const x = state.issues.find(i => 'issue|' + (i.id || i.reason) === k); return x ? +x.createdAt || 0 : 0; }
    if (k.indexOf('plan|') === 0 || k.indexOf('hold|') === 0) { const x = state.holdings.find(h => k.indexOf('|' + h.id) > -1); return x ? +x.createdAt || 0 : 0; }
    const x = state.sites.find(s => k.indexOf('|' + s.id + '|') > -1); return x ? +x.createdAt || 0 : 0;
  };
  return alerts.sort((a, b) => _recency(b) - _recency(a));   // 최근 등록 항목 알림이 앞에
}
function getAlertDismissed() { try { return JSON.parse(localStorage.getItem('dws_alertDismiss') || '[]'); } catch (e) { return []; } }
function _akey(k) { return String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function alertRowHtml(a) {
  return `<div class="alert-i ${a.c}">
    <div class="ai"><i class="ti ${a.ic}"></i></div>
    <div class="at"><b>${esc(a.t)}</b><span>${esc(a.s)}</span></div>
    <span class="tag">${esc(a.tag)}</span>
    <button onclick="dismissAlert('${_akey(a.key)}')" title="확인(이 기기에서 숨김)" style="flex:none;background:none;border:none;color:var(--t3);padding:6px;margin-left:2px;cursor:pointer"><i class="ti ti-check" style="font-size:18px"></i></button>
  </div>`;
}
function _alertBodyHtml(list) {
  return list.length ? list.map(alertRowHtml).join('') : `<div class="empty"><i class="ti ti-circle-check"></i>확인할 긴급 항목이 없습니다</div>`;
}
function dismissAlert(key) {
  const d = getAlertDismissed(); if (!d.includes(key)) { d.push(key); localStorage.setItem('dws_alertDismiss', JSON.stringify(d)); }
  const mb = el('alerts-modal-body');
  if (mb) mb.innerHTML = _alertBodyHtml(buildAlerts().filter(a => !getAlertDismissed().includes(a.key)));
  if (tab === 'home') renderHome();
}
function clearAlertDismiss() {
  localStorage.removeItem('dws_alertDismiss'); toast('확인한 알림을 다시 표시합니다');
  const mb = el('alerts-modal-body');
  if (mb) mb.innerHTML = _alertBodyHtml(buildAlerts());
  if (tab === 'home') renderHome();
}
function openAlerts() {
  const visible = buildAlerts().filter(a => !getAlertDismissed().includes(a.key));
  const dcount = getAlertDismissed().length;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-bell-ringing"></i>긴급 알림 ${visible.length}건</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:12.5px;color:var(--t3);margin:-4px 0 10px"><i class="ti ti-info-circle"></i> 확인(체크)한 알림은 <b>이 기기에서만</b> 사라집니다. 다른 직원 화면에는 그대로 보여요.</div>
    <div id="alerts-modal-body" style="max-height:62vh;overflow:auto">${_alertBodyHtml(visible)}</div>
    ${dcount ? `<button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="clearAlertDismiss()"><i class="ti ti-rotate"></i>확인한 알림 다시 보기 (${dcount})</button>` : ''}`);
}

/* ===================================================================
   모달 헬퍼
   =================================================================== */
function openModal(html) { el('sheet').innerHTML = html; el('modal').classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeModal() { el('modal').classList.remove('open'); document.body.style.overflow = ''; _holdLinkSite = null; _holdConfirm = null; }
el('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
// Esc 키: 자동완성 팝업 먼저, 없으면 모달 닫기
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const p = el('sb-pop'); if (p && p.style.display !== 'none') { p.style.display = 'none'; return; }
  const m = el('modal'); if (m && m.classList.contains('open')) closeModal();
});

/* 자재명 datalist (입고/출고/홀딩 공통) */
function itemDatalist(id) {
  return `<datalist id="${id}">${state.inventory.map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>`;
}
/* 자재명 추천: 재고 + 홀딩 자재명 합쳐서 (없는 자재도 자유 입력 가능) */
function matDatalistCombined(id) {
  const names = new Set();
  state.inventory.forEach(i => i.name && names.add(i.name));
  state.holdings.forEach(h => h.materialName && names.add(h.materialName));
  return `<datalist id="${id}">${[...names].map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
}
/* ===== 검색형 자동완성 (부분검색) ===== */
function matNames() {
  const s = new Set();
  state.inventory.forEach(i => i.name && s.add(i.name));
  state.holdings.forEach(h => h.materialName && s.add(h.materialName));
  state.sites.forEach(x => x.materialName && s.add(x.materialName));
  return [...s].sort((a, b) => a.localeCompare(b));
}
function companyNames() {
  // 업체/거래처 검색은 '거래처 관리'에 등록된 거래처만 표시
  const s = new Set();
  (state.clients || []).forEach(c => c.value && s.add(c.value));
  return [...s].sort((a, b) => a.localeCompare(b));
}
/* 폼에서 입력한 거래처명이 목록에 없으면 '거래처 관리'에 자동 등록 (현장·출고·홀딩·세면대 공용) */
async function ensureClient(name) {
  const v = (name || '').trim();
  if (!v) return;
  if ((state.clients || []).some(c => _normName(c.value) === _normName(v))) return;   // 이미 있으면 통과
  try { await Store.add('clients', { value: v }); } catch (e) { }
}
/* 입고 자재 검색 후보: 재고에 등록된 품목명만 */
function invNames() {
  return [...new Set(state.inventory.map(i => i.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
/* 자재별 '고정 패턴' 정의 — 품목에 저장된 patterns 우선, 없으면 기존 입고 이력에서 자동 도출 */
function matPatternDefs(name) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(name));
  if (it && Array.isArray(it.patterns) && it.patterns.length) return it.patterns.slice();
  return patternList(name).map(p => p.pattern);
}
/* 품목 수정 화면의 패턴 정의 편집 행 */
function ipatDefRow(name) {
  const inp = 'font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px';
  return `<div class="ipat-row" style="display:flex;gap:8px;margin-bottom:6px">
    <input class="ipat-name" lang="ko" placeholder="예: 1번(좌상)" value="${esc(name || '')}" style="flex:1;min-width:0;${inp}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.ipat-row').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
  </div>`;
}
function addIpatDef() { const c = el('ipat-defs'); if (c) c.insertAdjacentHTML('beforeend', ipatDefRow('')); }
/* searchBox: 입력하면 부분일치 후보가 아래에 뜨고 클릭 선택. id는 그대로 유지(폼 제출 시 사용). */
function searchBox(id, placeholder, value, listFn, pickFn) {
  return `<input id="${id}" class="sb-in" lang="ko" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value || '')}" oninput="sbFilter('${id}','${listFn}','${pickFn || ''}')" onfocus="sbFilter('${id}','${listFn}','${pickFn || ''}')" onkeydown="sbKey(event,'${id}','${pickFn || ''}')" onblur="setTimeout(sbHide,180)">`;
}
function sbEnsurePop() { let p = el('sb-pop'); if (!p) { p = document.createElement('div'); p.id = 'sb-pop'; p.className = 'sb-pop'; document.body.appendChild(p); } return p; }
function sbFilter(id, listFn, pickFn) {
  const inp = el(id); if (!inp) return;
  const q = (inp.value || '').trim().toLowerCase();
  const all = (typeof window[listFn] === 'function') ? window[listFn]() : [];
  const uniq = [...new Set(all.filter(Boolean).map(String))];
  let m = q ? uniq.filter(n => n.toLowerCase().includes(q)) : uniq;
  m = m.slice(0, 14);
  const p = sbEnsurePop();
  if (!m.length) { p.style.display = 'none'; if (pickFn && window[pickFn]) window[pickFn](); return; }
  const r = inp.getBoundingClientRect();
  p.style.left = r.left + 'px'; p.style.top = (r.bottom + 3) + 'px'; p.style.width = r.width + 'px';
  p.innerHTML = m.map(n => `<div class="sb-item" data-v="${esc(n)}">${esc(n)}</div>`).join('');
  p.style.display = 'block';
  [...p.children].forEach(c => { c.onmousedown = (e) => { e.preventDefault(); inp.value = c.dataset.v; p.style.display = 'none'; if (pickFn && window[pickFn]) window[pickFn](); }; });
  if (pickFn && window[pickFn]) window[pickFn]();
}
function sbHide() { const p = el('sb-pop'); if (p) p.style.display = 'none'; }
/* 키보드: 아래/위 방향키로 후보 이동, Enter로 선택, Esc로 닫기 */
function sbKey(e, id, pickFn) {
  const p = el('sb-pop'); if (!p || p.style.display === 'none') return;
  const items = [...p.querySelectorAll('.sb-item')]; if (!items.length) return;
  let idx = items.findIndex(it => it.classList.contains('hl'));
  if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; }
  else if (e.key === 'Enter') { if (idx >= 0) { e.preventDefault(); el(id).value = items[idx].dataset.v; p.style.display = 'none'; if (pickFn && window[pickFn]) window[pickFn](); } return; }
  else if (e.key === 'Escape') { p.style.display = 'none'; return; }
  else return;
  items.forEach((it, i) => it.classList.toggle('hl', i === idx));
  if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
}

/* 업체명 추천: 과거 출고처 + 거래처(현장) + 공장/공급처 */
function companyDatalist(id) {
  const names = new Set();
  state.transactions.forEach(t => t.targetName && names.add(t.targetName));
  state.sites.forEach(s => s.client && names.add(s.client));
  state.holdings.forEach(h => h.vendor && names.add(h.vendor));
  state.inventory.forEach(i => i.vendor && names.add(i.vendor));
  state.factories.forEach(f => f.value && names.add(f.value));
  return `<datalist id="${id}">${[...names].map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
}

/* ===================================================================
   현장 관리
   =================================================================== */
/* ---------- 이슈(현장별 문제) ---------- */
function siteIssues(id) { return state.issues.filter(i => i.siteId === id); }
function siteOpenIssues(id) { return state.issues.filter(i => i.siteId === id && i.status !== '처리완료'); }
function issuesSorted() {
  return state.issues.slice().sort((a, b) => {
    const ua = a.status !== '처리완료' ? 0 : 1, ub = b.status !== '처리완료' ? 0 : 1;
    if (ua !== ub) return ua - ub;                 // 미해결 먼저
    return (b.createdAt || 0) - (a.createdAt || 0); // 그다음 최신순
  });
}
function renderIssues() {
  const f = 'issue';
  const list = issuesSorted();
  const open = list.filter(i => i.status !== '처리완료').length;
  el('pg-sites').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-alert-triangle"></i>현장 이슈</h2><p>미해결 <b style="color:#f04438">${open}건</b> · 이슈를 처리 완료해야 현장을 완료할 수 있어요</p></div>
      <button class="btn btn-pri btn-sm" onclick="openIssueForm()"><i class="ti ti-plus"></i>이슈 등록</button></div>
    <div class="chips">
      ${chip('all', '전체', f)}${chip('wait', '견적·결제', f)}${chip('construct', '발주·시공', f)}${chip('done', '완료', f)}${chip('issue', '이슈', f)}
    </div>
    <div class="site-grid">${list.length ? list.map(issueCard).join('') : `<div class="empty" style="grid-column:1/-1"><i class="ti ti-shield-check"></i>등록된 이슈가 없습니다<br><button class="btn btn-pri btn-sm" style="margin-top:12px" onclick="openIssueForm()"><i class="ti ti-plus"></i>이슈 등록하기</button></div>`}</div>`;
}
function issueCard(i) {
  const done = i.status === '처리완료';
  const isBasin = i.kind === 'basin';
  const site = isBasin ? null : state.sites.find(x => x.id === i.siteId);
  const basin = isBasin ? (state.basins || []).find(x => x.id === i.basinId) : null;
  const stageTxt = isBasin ? (basin ? (basin.stage || '') : '삭제된 발주') : (site ? (site.stage || '') : '삭제된 현장');
  const kindBadge = isBasin ? `<span class="pill p-hold" style="flex:none;margin-right:6px;font-size:10px">세면대</span>` : '';
  return `<div class="site" style="border-left:4px solid ${done ? '#12b76a' : '#f04438'}">
    <div class="site-top">
      <div><div class="nm">${kindBadge}${esc(i.siteName || (isBasin ? '세면대 발주' : '현장'))}</div><div class="ad"><i class="ti ti-calendar-event" style="font-size:13px"></i>${i.createdAt ? new Date(i.createdAt).toLocaleDateString('ko-KR') : ''} · ${esc(i.by || '')} 등록${stageTxt ? ' · 현재 ' + esc(stageTxt) : ''}</div></div>
      <span class="pill ${done ? 'p-done' : 'p-issue'}">${done ? '처리완료' : '미해결'}</span>
    </div>
    <div style="margin-top:9px;font-size:13.5px;color:var(--t1);white-space:pre-wrap;line-height:1.6">${esc(i.reason || '')}</div>
    ${done
      ? `<div style="margin-top:9px;font-size:12px;color:var(--t3)"><i class="ti ti-check"></i> ${esc(i.resolvedDate || '')} ${esc(i.resolvedBy || '')} 처리 완료</div>`
      : `<button class="btn btn-pri btn-block" style="margin-top:10px" onclick="resolveIssue('${i.id}')"><i class="ti ti-circle-check"></i>처리 완료</button>`}
    <div class="frm-foot" style="margin-top:8px">
      ${isBasin
      ? (basin ? `<button class="btn btn-sm" style="flex:1" onclick="openBasinForm('${i.basinId}')"><i class="ti ti-bath"></i>세면대 발주 보기</button>` : '')
      : (site ? `<button class="btn btn-sm" style="flex:1" onclick="openSiteDetail('${i.siteId}')"><i class="ti ti-building-community"></i>현장 보기</button>` : '')}
      ${isAdmin() ? `<button class="btn btn-danger btn-sm" onclick="delIssue('${i.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>
  </div>`;
}
function openIssueForm(preSiteId) {
  const sites = state.sites.filter(s => s.stage !== '완료')
    .sort((a, b) => (a.constructDate || '9999-99-99').localeCompare(b.constructDate || '9999-99-99'));
  if (!sites.length) { toast('진행중인 현장이 없습니다'); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-alert-triangle"></i>이슈 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>현장 선택 <span class="req">*</span> <span style="color:var(--t3);font-weight:500">(진행중 현장)</span></label>
        <select id="i-site"><option value="">— 현장을 선택하세요 —</option>${sites.map(s => `<option value="${s.id}" ${preSiteId === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.client || '')}${s.constructDate ? ' · 시공 ' + s.constructDate : ''}</option>`).join('')}</select></div>
      <div class="fld full"><label>이슈가 생긴 이유 <span class="req">*</span></label>
        <textarea id="i-reason" placeholder="현장에 생긴 문제를 자세히 적어주세요" style="min-height:130px"></textarea></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitIssue()"><i class="ti ti-check"></i>이슈 등록</button>
    </div>`);
}
async function submitIssue() {
  if (_busy) return;
  const siteId = el('i-site').value;
  const reason = el('i-reason').value.trim();
  if (!siteId) { toast('현장을 선택하세요'); return; }
  if (!reason) { toast('이슈 이유를 입력하세요'); return; }
  const s = state.sites.find(x => x.id === siteId);
  _busy = true;
  try {
    await Store.add('issues', { kind: 'site', siteId, siteName: s ? s.name : '', reason, status: '미해결', by: me.name, createdAt: Date.now() });
    toast('이슈 등록됨'); closeModal();
  } finally { setTimeout(() => { _busy = false; }, 800); }
}
async function resolveIssue(id) {
  if (!confirm('이 이슈를 처리 완료로 표시할까요?')) return;
  await Store.update('issues', id, { status: '처리완료', resolvedBy: me.name, resolvedDate: todayStr() });
  toast('처리 완료');
}
async function delIssue(id) {
  if (!confirm('이 이슈 기록을 삭제할까요?')) return;
  await Store.remove('issues', id); toast('삭제됨');
}
/* 세면대(발주) 이슈 등록 */
function basinIssueLabel(b) { return `${b.vendor || '(업체미정)'} · ${basinItems(b).map(it => it.stone).filter(Boolean).join('/') || '세면대'}`; }
function openBasinIssueForm(preBasinId) {
  const all = (state.basins || []).slice().sort((a, b) => (b.orderDate || '0000').localeCompare(a.orderDate || '0000'));
  if (!all.length) { toast('등록된 세면대 발주가 없습니다'); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-alert-triangle"></i>세면대 이슈 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>세면대 발주 선택 <span class="req">*</span></label>
        <select id="bi-basin"><option value="">— 발주를 선택하세요 —</option>${all.map(b => `<option value="${b.id}" ${preBasinId === b.id ? 'selected' : ''}>${esc(basinIssueLabel(b))}${b.orderDate ? ' · ' + b.orderDate : ''}</option>`).join('')}</select></div>
      <div class="fld full"><label>이슈 내용 <span class="req">*</span></label>
        <textarea id="bi-reason" placeholder="세면대 관련 문제(파손·납기지연·규격오류·컬러상이 등)를 자세히 적어주세요" style="min-height:130px"></textarea></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitBasinIssue()"><i class="ti ti-check"></i>이슈 등록</button>
    </div>`);
}
async function submitBasinIssue() {
  if (_busy) return;
  const basinId = el('bi-basin').value;
  const reason = el('bi-reason').value.trim();
  if (!basinId) { toast('세면대 발주를 선택하세요'); return; }
  if (!reason) { toast('이슈 내용을 입력하세요'); return; }
  const b = (state.basins || []).find(x => x.id === basinId);
  _busy = true;
  try {
    await Store.add('issues', { kind: 'basin', basinId, siteName: b ? basinIssueLabel(b) : '세면대 발주', reason, status: '미해결', by: me.name, createdAt: Date.now() });
    toast('세면대 이슈 등록됨'); closeModal();
  } finally { setTimeout(() => { _busy = false; }, 800); }
}
function sitesFilteredList() {
  const f = filters.sites;
  let list = state.sites.slice();
  if (f === 'wait') list = list.filter(s => ['접수', '가견적', '견적', '결제'].includes(s.stage));
  else if (f === 'construct') list = list.filter(s => ['발주', '시공'].includes(s.stage));
  else if (f === 'done') list = list.filter(s => s.stage === '완료');
  else if (f === 'issue') list = []; // 이슈는 renderIssues() 전용 화면에서 처리
  else list = list.filter(s => s.stage !== '완료'); // 전체(기본): 완료 현장 숨김
  // 시공일 임박순 정렬 (시공일 없는 건 맨 뒤). 이슈 보기는 그대로 임박순.
  list.sort((a, b) => (a.constructDate || '9999-99-99').localeCompare(b.constructDate || '9999-99-99'));
  const q = (filters.siteSearch || '').trim().toLowerCase();
  if (q) {
    const fld = filters.siteSearchField || 'all';
    list = list.filter(s => {
      const team = (s.team || '').toLowerCase();
      const client = (s.client || '').toLowerCase();
      const mat = (s.materialName || '').toLowerCase();
      const dates = [s.measureDate, s.constructDate].filter(Boolean).join(' ').toLowerCase();
      const name = (s.name || '').toLowerCase();
      if (fld === 'team') return team.includes(q);
      if (fld === 'client') return client.includes(q);
      if (fld === 'material') return mat.includes(q);
      if (fld === 'date') return dates.includes(q);
      return team.includes(q) || client.includes(q) || mat.includes(q) || dates.includes(q) || name.includes(q);
    });
  }
  return list;
}
function siteGridHtml(list) {
  return list.length ? list.map(siteCard).join('') : `<div class="empty" style="grid-column:1/-1"><i class="ti ti-building"></i>해당하는 현장이 없습니다<br><button class="btn btn-pri btn-sm" style="margin-top:12px" onclick="openSiteForm()"><i class="ti ti-building-community"></i>현장 등록하기</button></div>`;
}
function chipSF(v, label) { return `<button class="chip ${(filters.siteSearchField || 'all') === v ? 'active' : ''}" onclick="setSiteSearchField('${v}')">${label}</button>`; }
function setSiteSearchField(fld) { filters.siteSearchField = fld; renderSites(); setTimeout(() => { const i = el('site-search'); if (i) i.focus(); }, 30); }
function filterSites() {
  filters.siteSearch = el('site-search') ? el('site-search').value : '';
  const list = sitesFilteredList();
  if (el('sites-grid')) el('sites-grid').innerHTML = siteGridHtml(list);
  if (el('sites-count')) el('sites-count').textContent = list.length + '건';
}
function renderSites() {
  const f = filters.sites;
  if (f === 'issue') { renderIssues(); return; } // 이슈는 전용 화면
  const list = sitesFilteredList();
  const view = filters.siteView || 'list';
  el('pg-sites').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-building-community"></i>시공 현장</h2><p>진행 단계를 한눈에 · 탭하면 상세</p></div>
      <button class="btn btn-pri btn-sm" onclick="openSiteForm()"><i class="ti ti-plus"></i>현장 등록</button></div>
    <div class="chips">
      ${chip('all', '전체', f)}${chip('wait', '견적·결제', f)}${chip('construct', '발주·시공', f)}${chip('done', '완료', f)}${chip('issue', '이슈', f)}
    </div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="site-search" placeholder="현장·시공팀·업체·자재·날짜 검색" value="${esc(filters.siteSearch || '')}" oninput="filterSites()" autocomplete="off">
      ${filters.siteSearch ? `<button class="search-x" onclick="el('site-search').value='';filterSites()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div class="chips" style="margin-bottom:8px">
      <button class="chip ${view === 'cal' ? '' : 'active'}" onclick="filters.siteView='list';renderSites()"><i class="ti ti-list"></i> 목록</button>
      <button class="chip ${view === 'cal' ? 'active' : ''}" onclick="filters.siteView='cal';renderSites()"><i class="ti ti-calendar"></i> 캘린더</button>
      <button class="chip" style="margin-left:auto" onclick="downloadSiteStatsXls()"><i class="ti ti-file-spreadsheet"></i> 통계 엑셀</button>
    </div>
    ${view === 'cal' ? staffCalendarHtml(list) : `<div style="font-size:12px;color:var(--t3);margin:2px 0 8px">검색 결과 <b id="sites-count" style="color:var(--t1)">${list.length}건</b></div><div class="site-grid" id="sites-grid">${siteGridHtml(list)}</div>`}`;
}
function chip(v, label, cur) { return `<button class="chip ${cur === v ? 'active' : ''}" onclick="filters.sites='${v}';renderSites()">${label}</button>`; }
/* 직원용 현장 캘린더 (전체 현장 · 공휴일 빨강 · 탭하면 상세) */
function staffMonthShift(delta) { const ym = filters.siteMonth || todayStr().slice(0, 7); let [Y, M] = ym.split('-').map(Number); M += delta; if (M < 1) { M = 12; Y--; } else if (M > 12) { M = 1; Y++; } filters.siteMonth = `${Y}-${String(M).padStart(2, '0')}`; renderSites(); }
function staffPickDay(ds) { filters.siteDay = (filters.siteDay === ds ? '' : ds); renderSites(); }
/* 시공팀별 색상 — 자체시공은 그레이톤, 나머지 팀은 대비 강한 색으로 눈에 확 띄게 */
const TEAM_PALETTE = ['#1e5eff', '#ff5a1f', '#12b76a', '#a03cff', '#e11d48', '#0891b2', '#ca8a04', '#7c3aed'];   // 강한 대비 색
const TEAM_GRAY = '#8a8f98';   // 자체시공 등 자체팀
function isSelfTeam(team) { return /자체/.test(String(team || '')); }
function calTeamList() {
  return [...new Set([...(state.teams || []).map(t => t.value || t), ...state.sites.map(s => s.team)].filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}
function calTeamColor(team) {
  if (!team) return TEAM_GRAY;
  if (isSelfTeam(team)) return TEAM_GRAY;   // 자체시공: 그레이톤
  const list = calTeamList().filter(t => !isSelfTeam(t));   // 자체팀 제외하고 순서 매핑 → 나머지 팀이 강한 색 앞순위
  const i = list.findIndex(t => _normName(t) === _normName(team));
  return TEAM_PALETTE[(i < 0 ? 0 : i) % TEAM_PALETTE.length];
}
/* 캘린더에서 시공팀 색상 범례 클릭 → 해당 팀만 보기(토글) */
function goCalTeam(t) { filters.calTeam = (filters.calTeam === t) ? '' : t; renderSites(); }
function staffCalendarHtml(list) {
  const ym = filters.siteMonth || todayStr().slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);
  const startDow = new Date(Y, M - 1, 1).getDay();
  const daysInMonth = new Date(Y, M, 0).getDate();
  const teamFilter = filters.calTeam || '';
  const flist = teamFilter ? list.filter(s => _normName(s.team) === _normName(teamFilter)) : list;
  const monthAll = list.filter(s => (s.constructDate || '').startsWith(ym));
  const legendTeams = [...new Set(monthAll.map(s => s.team).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
  const byDay = {};
  const monthSites = flist.filter(s => (s.constructDate || '').startsWith(ym)).sort((a, b) => (a.constructDate || '').localeCompare(b.constructDate || ''));
  monthSites.forEach(s => { const dd = +s.constructDate.slice(8, 10); (byDay[dd] = byDay[dd] || []).push(s); });
  const today = todayStr(), sel = filters.siteDay || '';
  const dow = ['일', '월', '화', '수', '목', '금', '토'];
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div></div>`;
  for (let dd = 1; dd <= daysInMonth; dd++) {
    const ds = `${ym}-${String(dd).padStart(2, '0')}`;
    const has = byDay[dd], isToday = ds === today, isSel = ds === sel;
    const dowIdx = (startDow + dd - 1) % 7;
    const hol = HOLIDAYS[ds];
    const col = (dowIdx === 0 || hol) ? '#d64545' : (dowIdx === 6 ? '#2f6fed' : 'var(--t1)');
    const chips = (has || []).map(s => { const tc = calTeamColor(s.team); const slf = isSelfTeam(s.team); return `<span style="font-size:11px;line-height:1.3;background:${isSel ? 'rgba(255,255,255,.22)' : (slf ? tc + '1c' : tc + '26')};color:${isSel ? '#fff' : tc};border-radius:5px;padding:2px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:${slf ? '600' : '700'};display:block;margin-top:3px;border-left:3px solid ${isSel ? 'rgba(255,255,255,.6)' : tc}" title="${esc(s.team || '')}">${esc(s.name || s.client || '현장')}</span>`; }).join('');
    cells += `<button onclick="staffPickDay('${ds}')" style="min-height:76px;border:${isSel ? '0' : '0.5px solid var(--bd)'};background:${isSel ? 'var(--g)' : (isToday ? 'var(--gl2,#e8f7f0)' : '#fff')};border-radius:10px;display:flex;flex-direction:column;align-items:stretch;cursor:pointer;padding:6px 5px;overflow:hidden">
      <span style="font-size:14px;font-weight:${has ? '700' : '500'};color:${isSel ? '#fff' : col};text-align:left;line-height:1.05">${dd}</span>
      ${hol ? `<span style="font-size:9.5px;color:${isSel ? '#fff' : '#d64545'};font-weight:600;line-height:1.15;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hol}</span>` : ''}
      ${chips}
    </button>`;
  }
  const rowFn = s => `<div onclick="openSiteDetail('${s.id}')" style="display:flex;gap:8px;align-items:center;padding:9px 10px;border-top:0.5px solid var(--bd);cursor:pointer">
    <div style="font-size:12px;font-weight:700;color:var(--gd);min-width:36px">${+s.constructDate.slice(5, 7)}/${+s.constructDate.slice(8, 10)}</div>
    <div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:600;word-break:keep-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name || s.client || '-')}</div><div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.team ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${calTeamColor(s.team)};margin-right:4px;vertical-align:middle"></span>` : ''}${esc(s.team || '')}${s.address ? ' · ' + esc(s.address) : ''}</div></div>
    <span class="pill p-prog" style="flex:none;font-size:10px">${esc(s.stage || '접수')}</span></div>`;
  const sel2 = sel ? flist.filter(s => s.constructDate === sel) : [];
  const legend = legendTeams.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin:0 4px 10px;align-items:center">
      <span style="font-size:11px;color:var(--t3);font-weight:600;margin-right:2px"><i class="ti ti-palette" style="font-size:12px;vertical-align:-1px"></i> 시공팀</span>
      <button onclick="goCalTeam('')" style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;border:1px solid ${!teamFilter ? 'var(--t1)' : 'var(--bd2)'};background:${!teamFilter ? 'var(--t1)' : '#fff'};color:${!teamFilter ? '#fff' : 'var(--t2)'};cursor:pointer">전체</button>
      ${legendTeams.map(t => { const c = calTeamColor(t); const on = _normName(teamFilter) === _normName(t); return `<button onclick="goCalTeam('${_akey(t)}')" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;border:1px solid ${on ? c : 'var(--bd2)'};background:${on ? c : '#fff'};color:${on ? '#fff' : 'var(--t2)'};cursor:pointer"><span style="width:9px;height:9px;border-radius:50%;background:${on ? '#fff' : c};display:inline-block"></span>${esc(t)}</button>`; }).join('')}
    </div>` : '';
  let below;
  if (sel) below = `<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 8px"><div style="font-size:12.5px;color:var(--t2)"><b>${+sel.slice(5, 7)}/${+sel.slice(8, 10)}</b> 시공 ${sel2.length}건</div><button class="btn btn-sm" style="padding:2px 10px" onclick="staffPickDay('${sel}')"><i class="ti ti-calendar"></i> 이달 목록</button></div><div style="background:#fff;border:0.5px solid var(--bd);border-radius:12px;overflow:hidden">${sel2.length ? sel2.map(rowFn).join('') : '<div class="empty" style="padding:14px">시공 없음</div>'}</div>`;
  else if (monthSites.length) below = `<div style="font-size:12px;color:var(--t3);margin:2px 0 4px">이달 시공 ${monthSites.length}건 · 날짜/항목 누르면 상세</div><div style="background:#fff;border:0.5px solid var(--bd);border-radius:12px;overflow:hidden">${monthSites.map(rowFn).join('')}</div>`;
  else below = `<div class="empty"><i class="ti ti-calendar-off"></i>이달 예정된 시공이 없습니다</div>`;
  return `<div style="background:#fff;border:0.5px solid var(--bd);border-radius:14px;padding:10px 6px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:0 4px">
      <button class="btn btn-sm" onclick="staffMonthShift(-1)" aria-label="이전달"><i class="ti ti-chevron-left"></i></button>
      <b style="font-size:16px">${Y}년 ${M}월</b>
      <button class="btn btn-sm" onclick="staffMonthShift(1)" aria-label="다음달"><i class="ti ti-chevron-right"></i></button>
    </div>
    ${legend}
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:6px">${dow.map((w, i) => `<div style="text-align:center;font-size:12px;font-weight:600;color:${i === 0 ? '#d64545' : (i === 6 ? '#2f6fed' : 'var(--t3)')}">${w}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px">${cells}</div>
  </div>
  <div style="margin-top:10px">${below}</div>`;
}

function siteCard(s) {
  const idx = siteStageIndex(s);
  const skip = s.orderType === '도면';
  const tnodes = SITE_STAGES.map((st, i) => {
    let cls = i < idx ? 'done' : (i === idx ? 'cur' : '');
    if (skip && st === '실측') cls = 'skip';
    const date = (s.history || {})[st] ? (s.history[st]).slice(5) : '';
    return `<div class="tnode ${cls}"><span class="c">${i < idx ? '<i class=\'ti ti-check\'></i>' : ''}</span><span class="lb">${st}</span><span class="dt">${date}</span></div>`;
  }).join('');
  const dM = daysFromNow(s.measureDate), dC = daysFromNow(s.constructDate);
  const openIss = siteOpenIssues(s.id);
  const tc = calTeamColor(s.team);   // 시공팀 색상 (자체시공=그레이)
  return `<div class="site" onclick="openSiteDetail('${s.id}')" style="border-top:3px solid ${tc}"${s.team ? ` title="시공팀: ${esc(s.team)}"` : ''}>
    <div class="site-top">
      <div><div class="nm">${esc(s.name)}</div><div class="ad"><i class="ti ti-map-pin" style="font-size:13px"></i>${esc(s.region || '')} ${esc(s.address || '')}</div></div>
      <div style="text-align:right;flex:none">${pill(s.stage || '접수')}${openIss.length ? `<div style="margin-top:5px"><span class="pill p-issue"><i class="ti ti-alert-triangle"></i> 이슈 ${openIss.length}</span></div>` : ''}</div>
    </div>
    <div class="site-meta">
      <div class="mi"><i class="ti ti-user-circle"></i><span class="k">담당</span><b>${esc(s.manager || '-')}</b></div>
      <div class="mi"><i class="ti ti-briefcase"></i><span class="k">업체</span><b>${esc(s.client || '-')}</b></div>
      <div class="mi"><i class="ti ti-building-factory-2"></i><span class="k">공장</span><b>${esc(s.factory || '-')}</b></div>
      <div class="mi"><i class="ti ti-users"></i><span class="k">시공팀</span><b>${esc(s.team || '-')}</b></div>
    </div>
    <div class="date-row">
      <div class="db ${skip ? '' : (dM != null && dM >= 0 && dM <= 3 ? 'soon' : '')}"><div class="k">실측일</div><div class="v">${skip ? '도면발주' : (s.measureDate || '미정')}</div></div>
      <div class="db ${dC != null && dC >= 0 && dC <= 3 ? 'soon' : ''}"><div class="k">시공일</div><div class="v">${s.constructDate || '미정'}${dC != null && dC >= 0 && dC <= 7 && s.stage !== '완료' ? ` <small style="font-weight:600;color:var(--amber-t)">D-${dC}</small>` : ''}</div></div>
    </div>
    <div class="tline">${tnodes}</div>
    ${openIss.length ? `<div style="margin-top:9px;font-size:12.5px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:9px;padding:8px 10px;line-height:1.5"><b><i class="ti ti-alert-triangle"></i> 미해결 이슈</b> · ${esc(openIss[0].reason)}${openIss.length > 1 ? ` <span style="color:var(--t3)">외 ${openIss.length - 1}건</span>` : ''}</div>` : ''}
  </div>`;
}

function openSiteDetail(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const skip = s.orderType === '도면';
  const linkedHold = state.holdings.find(h => h.status !== '해제' && (h.forSiteId === s.id || (s.name && h.forSiteName === s.name)));
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-community"></i>${esc(s.name)}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="margin-bottom:12px">${pill(s.stage || '접수')}${s.confirmed ? ' <span class="pill p-done">확정</span>' : ''}</div>
    <div class="dl">
      <div class="df"><div class="k">현장 담당자</div><div class="v">${esc(s.manager || '-')}</div></div>
      <div class="df"><div class="k">업체(거래처)</div><div class="v">${esc(s.client || '-')}</div></div>
      <div class="df full"><div class="k">현장 주소</div><div class="v">${esc(s.region || '')} ${esc(s.address || '-')}</div></div>
      <div class="df"><div class="k">발주 유형</div><div class="v">${esc(s.orderType || '-')}${skip ? ' (실측없음)' : ''}</div></div>
      <div class="df full"><div class="k">자재 / 수량</div><div class="v">${siteItems(s).length ? siteItems(s).map(it => esc(it.name) + ' · ' + esc(it.qty) + '장' + (it.lot ? ' <span style="color:var(--t3)">(롯트 ' + esc(it.lot) + ')</span>' : '')).join('<br>') : '-'}</div></div>
      <div class="df"><div class="k">가공 공장</div><div class="v">${esc(s.factory || '-')}</div></div>
      <div class="df"><div class="k">시공팀</div><div class="v">${esc(s.team || '-')}</div></div>
      <div class="df"><div class="k">실측일</div><div class="v">${skip ? '도면발주' : (s.measureDate || '미정')}</div></div>
      <div class="df"><div class="k">시공일</div><div class="v">${s.constructDate || '미정'}</div></div>
      ${s.preQuote ? `<div class="df"><div class="k">가견적</div><div class="v">${esc(s.preQuote)}</div></div>` : ''}
      ${s.quoteAmount ? `<div class="df"><div class="k">견적 금액</div><div class="v">${won(+s.quoteAmount)}원</div></div>` : ''}
      ${s.note ? `<div class="df full"><div class="k">특이사항</div><div class="v" style="font-weight:500">${esc(s.note)}</div></div>` : ''}
    </div>
    ${(() => { const iss = siteIssues(s.id); return `
    <div class="sec-label" style="display:flex;justify-content:space-between;align-items:center"><span><i class="ti ti-alert-triangle" style="color:#f04438"></i> 현장 이슈 ${iss.length ? `(${siteOpenIssues(s.id).length}건 미해결)` : ''}</span><button class="btn btn-ghost btn-sm" onclick="openIssueForm('${s.id}')"><i class="ti ti-plus"></i>이슈</button></div>
    ${iss.length ? iss.slice().sort((a, b) => { const ua = a.status !== '처리완료' ? 0 : 1, ub = b.status !== '처리완료' ? 0 : 1; return ua !== ub ? ua - ub : (b.createdAt || 0) - (a.createdAt || 0); }).map(i => {
      const done = i.status === '처리완료';
      return `<div style="border:1px solid ${done ? '#d0e8dc' : '#fecdca'};background:${done ? '#f3faf6' : '#fef3f2'};border-radius:10px;padding:9px 11px;margin-bottom:7px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="pill ${done ? 'p-done' : 'p-issue'}" style="flex:none">${done ? '처리완료' : '미해결'}</span><span style="font-size:11px;color:var(--t3)">${i.createdAt ? new Date(i.createdAt).toLocaleDateString('ko-KR') : ''} · ${esc(i.by || '')}</span></div>
        <div style="margin-top:6px;font-size:13px;white-space:pre-wrap;line-height:1.55">${esc(i.reason || '')}</div>
        ${done ? `<div style="margin-top:5px;font-size:11.5px;color:var(--t3)"><i class="ti ti-check"></i> ${esc(i.resolvedDate || '')} ${esc(i.resolvedBy || '')} 처리</div>` : `<button class="btn btn-pri btn-sm btn-block" style="margin-top:7px" onclick="resolveIssue('${i.id}')"><i class="ti ti-circle-check"></i>처리 완료</button>`}
      </div>`; }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:4px 2px 10px">등록된 이슈가 없습니다.</div>`}`; })()}
    <div class="sec-label"><i class="ti ti-arrow-bar-to-right"></i>진행 단계 변경</div>
    <div class="seg" style="flex-wrap:wrap">
      ${SITE_STAGES.filter(st => !(skip && st === '실측')).map(st => `<button class="${(s.stage || '접수') === st ? 'on' : ''}" onclick="advanceStage('${s.id}','${st}')">${st}</button>`).join('')}
    </div>
    ${linkedHold ? `<div class="banner info" style="margin-top:6px"><i class="ti ti-lock"></i>이미 홀딩이 연결된 현장입니다 (${esc(linkedHold.status || '홀딩')}) — ${esc(linkedHold.vendor || '')} · ${+linkedHold.jang || 0}장${linkedHold.materialName ? ' · ' + esc(linkedHold.materialName) : ''}. 진행 단계가 넘어가도 중복 홀딩은 막습니다.</div>` : `<button class="btn btn-ghost btn-block" style="margin-top:6px" onclick="holdFromSite('${s.id}')"><i class="ti ti-lock-plus"></i>이 현장 자재 홀딩 잡기</button>`}
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="openSiteForm('${s.id}')"><i class="ti ti-edit"></i>수정</button>
      ${isAdmin() ? `<button class="btn btn-danger" onclick="delSite('${s.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>`);
}
/* 현장 → 홀딩 생성 (현장 정보로 홀딩 폼 프리필) */
function holdFromSite(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const existing = state.holdings.find(h => h.status !== '해제' && (h.forSiteId === id || (s.name && h.forSiteName === s.name)));
  if (existing) { toast(`이미 홀딩이 연결된 현장입니다 (${existing.status || '홀딩'}) — 중복 방지`); return; }
  openHoldForm(null, { forSiteId: id, vendor: s.client || '', items: siteItems(s).map(it => ({ materialName: it.name, jang: it.qty, lot: it.lot })), useDate: s.constructDate });
}
async function advanceStage(id, stage) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  if (stage === '완료') {
    const openIss = siteOpenIssues(id);
    if (openIss.length) { toast(`미해결 이슈 ${openIss.length}건 — 이슈를 처리 완료해야 현장을 완료할 수 있어요`); return; }
  }
  const hist = Object.assign({}, s.history || {}); if (!hist[stage]) hist[stage] = todayStr();
  await Store.update('sites', id, { stage, history: hist, updatedBy: me.name });
  toast(`단계 → ${stage}`); closeModal();
}
async function delSite(id) {
  if (!guardDelete('이 현장을 삭제할까요?')) return;
  const s = state.sites.find(x => x.id === id); const nm = s ? s.name : '';
  await Store.remove('sites', id);
  // 이 현장에 연결됐던 홀딩의 현장 정보 제거(고아 데이터 방지)
  for (const h of state.holdings.filter(h => h.forSiteId === id || (nm && h.forSiteName === nm))) {
    await Store.update('holdings', h.id, { forSiteId: '', forSiteName: '' });
  }
  toast('삭제됨 · 연결 홀딩의 현장 정보도 정리'); closeModal();
}

/* 현장 등록/수정 폼 */
let _siteFromQuote = '';
function openSiteForm(id, pre) {
  _siteFromQuote = (pre && pre.quoteId) || '';
  const s = id ? state.sites.find(x => x.id === id) : null;
  const v = s || Object.assign({ manager: me.name, orderType: '실측', stage: '접수', measureNeeded: true }, pre || {});
  _mrowPattern = false; _mrowDepot = false;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-community"></i>${s ? '현장 수정' : '현장 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld"><label>현장명 <span style="color:var(--t3);font-weight:500">(미입력 시 업체명)</span></label><input id="s-name" lang="ko" value="${esc(v.name || '')}" placeholder="현장명"></div>
      <div class="fld"><label>업체(거래처)<span class="req">*</span></label>${searchBox('s-client', '업체명 검색·입력', v.client, 'companyNames', '')}</div>
      <div class="fld"><label>지역</label><input id="s-region" lang="ko" value="${esc(v.region || '')}" placeholder="지역"></div>
      <div class="fld"><label>현장 담당자</label><input id="s-manager" lang="ko" value="${esc(v.manager || me.name)}"></div>
      <div class="fld full"><label>현장 주소</label><input id="s-address" lang="ko" value="${esc(v.address || '')}" placeholder="상세 주소"></div>
      <div class="fld"><label>발주 유형</label>
        <div class="seg" id="s-ordertype">
          <button type="button" class="${v.orderType === '실측' ? 'on' : ''}" onclick="pickOrderType('실측')">실측 발주</button>
          <button type="button" class="${v.orderType === '도면' ? 'on' : ''}" onclick="pickOrderType('도면')">도면 발주</button>
        </div>
      </div>
      <div class="fld"><label>진행 단계</label><select id="s-stage">${SITE_STAGES.map(st => `<option ${(v.stage || '접수') === st ? 'selected' : ''}>${st}</option>`).join('')}</select></div>
      ${holdingsForSite().length ? `<div class="fld full"><label><i class="ti ti-lock" style="font-size:13px;color:var(--blue)"></i> 홀딩에서 불러오기 <span style="color:var(--t3);font-weight:500">(진행·예정홀딩 · 불러온 뒤 수량은 실사용량으로 수정 가능)</span></label><select id="s-hold" onchange="pickSiteHolding()"><option value="">— 직접 입력 —</option>${holdingOptions()}</select></div>` : ''}
      <div class="fld full"><label>자재 / 수량 / 롯트<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 종류면 '자재 추가' · 수량은 직접 수정 가능 · 미정이면 아래 체크)</span></label>${matRowsHtml(siteItems(v), '수량')}</div>
      <div class="fld full"><button type="button" id="s-matpending-btn" class="btn btn-ghost btn-sm btn-block${v.matPending ? ' on' : ''}" style="margin:0;color:#d64545;border-color:#e6a9a9;font-weight:600${v.matPending ? ';background:#fdeaea' : ''}" onclick="const on=!this.classList.contains('on');this.classList.toggle('on',on);this.style.background=on?'#fdeaea':''"><i class="ti ti-help-circle"></i> 자재 미정</button></div>
      <div class="fld"><label>실측일 <span id="s-measure-lbl" style="color:var(--t3)">${v.orderType === '도면' ? '(도면발주·생략)' : ''}</span></label><input type="date" id="s-measureDate" value="${esc(v.measureDate || '')}" ${v.orderType === '도면' ? 'disabled' : ''}></div>
      <div class="fld"><label>시공일<span class="req">*</span></label><input type="date" id="s-constructDate" value="${esc(v.constructDate || '')}"></div>
      <div class="fld"><label>가공 공장<span class="req">*</span></label><select id="s-factory" onchange="onMasterChange('s-factory','factories')">${masterOptions('factories', v.factory || '')}</select></div>
      <div class="fld full hidden" id="s-factory-add"><label>새 공장 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-factory-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-factory','factories')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld"><label>시공팀<span class="req">*</span></label><select id="s-team" onchange="onMasterChange('s-team','teams')">${masterOptions('teams', v.team || '')}</select></div>
      <div class="fld full hidden" id="s-team-add"><label>새 시공팀 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-team-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-team','teams')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld full"><label>특이사항 <span style="color:var(--t3);font-weight:500">(내부용)</span></label><textarea id="s-note" lang="ko" placeholder="현장 메모">${esc(v.note || '')}</textarea></div>
      <div class="fld full"><label><i class="ti ti-message-2" style="font-size:13px;color:var(--blue)"></i> 시공팀 전달사항 <span style="color:var(--t3);font-weight:500">— 시공팀 계정 화면에 표시됨</span></label><textarea id="s-crewnote" lang="ko" placeholder="시공팀(모든대리석 등)에게 전달할 내용">${esc(v.crewNote || '')}</textarea></div>
    </div>
    <button class="btn btn-ghost btn-block" style="margin-top:12px" onclick="runRecommend()"><i class="ti ti-wand"></i>매뉴얼 기반 시공팀·공장 자동추천</button>
    <div id="reco-out"></div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitSite('${id || ''}')"><i class="ti ti-check"></i>${s ? '저장' : '등록'}</button>
    </div>`);
  mrowLotRefresh();
}
let _orderType = null;
function pickOrderType(t) {
  _orderType = t;
  document.querySelectorAll('#s-ordertype button').forEach(b => b.classList.toggle('on', b.textContent.includes(t === '실측' ? '실측' : '도면')));
  const md = el('s-measureDate'), lbl = el('s-measure-lbl');
  if (t === '도면') { md.value = ''; md.disabled = true; lbl.textContent = '(도면발주·생략)'; }
  else { md.disabled = false; lbl.textContent = ''; }
}
function curOrderType() { return _orderType || (el('s-measureDate').disabled ? '도면' : '실측'); }

function runRecommend() {
  const first = collectMaterialRows()[0] || {}; const fq = +first.qty || 0;
  const o = {
    region: el('s-region').value, address: el('s-address').value,
    constructionDate: el('s-constructDate').value, dueDate: el('s-constructDate').value,
    jang: fq,
    volume: fq >= 25 ? '대형' : '소형',
    materialName: first.name || '',
    workType: '', complex: false, simpleTop: false
  };
  const t = recommendTeam(o), f = recommendFactory(o);
  el('reco-out').innerHTML = `
    <div class="reco">
      <div class="reco-h"><i class="ti ti-wand"></i>매뉴얼 자동추천 (참고용)</div>
      <div class="row"><span class="rl">시공팀</span><span class="rv"><b>${esc(t.team)}</b><small>${esc(t.why)}</small></span></div>
      <div class="row"><span class="rl">가공 공장</span><span class="rv"><b>${esc(f.factory)}</b><small>${esc(f.why)}</small></span></div>
      <div class="row"><span class="rl" style="align-self:center">적용</span><span class="rv"><button class="btn btn-pri btn-sm" onclick="applyReco('${esc(t.team)}','${esc(f.factory)}')">입력란에 채우기</button></span></div>
    </div>`;
}
function applyReco(team, factory) { setSelectValue('s-team', 'teams', team); setSelectValue('s-factory', 'factories', factory); toast('추천값을 입력했습니다'); }
/* 현장 폼에서 홀딩 선택 → 자재·수량·업체 자동 입력 + 등록 시 그 홀딩을 현장에 연결(유지) */
function pickSiteHolding() {
  const id = el('s-hold').value;
  if (!id) { _holdLinkSite = null; return; }
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  const box = el('mat-rows');
  if (box) { box.innerHTML = ''; holdItems(h).forEach(it => addMaterialRow({ name: it.materialName, qty: it.jang, lot: it.lot }, '수량')); }
  if (!el('s-client').value) el('s-client').value = h.vendor || '';
  _holdLinkSite = id;
  toast('홀딩 자재를 불러왔습니다 — 수량은 실사용량으로 수정하세요');
}

async function submitSite(id) {
  const name = el('s-name').value.trim();
  const client = el('s-client').value.trim();
  let items = collectMaterialRows();
  const matPending = !!(el('s-matpending-btn') && el('s-matpending-btn').classList.contains('on'));
  if (!items.length && matPending) items = [{ name: '(미정)', qty: 0, lot: '' }];
  const constructDate = el('s-constructDate').value;
  const factory = normFactory(el('s-factory').value === '__add' ? '' : el('s-factory').value);
  const team = el('s-team').value === '__add' ? '' : el('s-team').value;
  if (!client) { toast('업체명을 입력하세요'); return; }
  if (!items.length) { toast("자재명과 수량을 입력하세요 (미정이면 '자재 미정' 체크)"); return; }
  if (!constructDate) { toast('시공일을 선택하세요'); return; }
  if (!factory) { toast('가공 공장을 선택하세요'); return; }
  if (!team) { toast('시공팀을 선택하세요'); return; }
  const stage = el('s-stage').value || '접수';
  if (id && stage === '완료' && siteOpenIssues(id).length) { toast(`미해결 이슈 ${siteOpenIssues(id).length}건 — 이슈를 처리 완료해야 현장을 완료할 수 있어요`); return; }
  const obj = {
    name: name || (client + ' 현장'), client, region: el('s-region').value.trim(),
    address: el('s-address').value.trim(), manager: el('s-manager').value.trim() || me.name,
    orderType: curOrderType(), stage,
    items, materialName: items[0].name, qty: String(items[0].qty), unit: '',
    measureDate: el('s-measureDate').value, constructDate,
    factory, team,
    matPending, note: el('s-note').value.trim(), crewNote: (el('s-crewnote') && el('s-crewnote').value || '').trim(), updatedBy: me.name
  };
  await ensureClient(client);   // 신규 거래처 자동 등록
  if (id) {
    const s = state.sites.find(x => x.id === id);
    const hist = Object.assign({}, s.history || {}); if (!hist[obj.stage]) hist[obj.stage] = todayStr();
    obj.history = hist;
    await Store.update('sites', id, obj); toast('현장 정보 저장됨');
  } else {
    obj.history = { '접수': todayStr() }; if (obj.stage !== '접수') obj.history[obj.stage] = todayStr();
    await Store.add('sites', obj); toast('현장 등록 완료');
  }
  // 연결된 홀딩에 실사용 수량 연동(출고는 홀딩에서 함) — 이번에 고른 것 우선, 없으면 이미 연결된 홀딩 자동 탐색(재편집 대응)
  let linkHoldId = _holdLinkSite;
  if (!linkHoldId && id) {
    const s0 = state.sites.find(x => x.id === id); const oldName = s0 ? s0.name : '';
    const lh = state.holdings.find(h => !['해제', '확정'].includes(h.status || '홀딩') && (h.forSiteId === id || (oldName && h.forSiteName === oldName)));
    if (lh) linkHoldId = lh.id;
  }
  if (linkHoldId) {
    const hItems = items.map(r => {
      const inv = state.inventory.find(i => _normName(i.name) === _normName(r.name));
      return { materialName: r.name, jang: r.qty, hebe: inv ? +(r.qty * (+inv.hebePerJang || 0)).toFixed(2) : 0, lot: r.lot, pattern: r.pattern || '' };
    });
    const upd = { forSiteName: obj.name, items: hItems, materialName: hItems[0].materialName, jang: hItems[0].jang, hebe: hItems[0].hebe, lot: hItems[0].lot };
    if (id) upd.forSiteId = id;
    await Store.update('holdings', linkHoldId, upd);
  }
  _holdLinkSite = null;
  if (_siteFromQuote) { try { await Store.update('quotes', _siteFromQuote, { siteDone: true, siteDoneAt: Date.now() }); } catch (e) { } _siteFromQuote = ''; }
  closeModal();
}

/* ===================================================================
   재고 · 입고
   =================================================================== */
/* ── 제품 종류(카테고리) & 단위 ──
   세라믹·석재·무늬목 = '장', 세면대·기타(폽업·수전 등) = '개'. 규격·헤베·패턴은 세라믹/석재만 사용. */
const ITEM_CATS = ['세라믹', '석재', '세면대', '무늬목', '기타'];
function itemCat(it) { return (it && it.cat) ? it.cat : '세라믹'; }
function itemUnit(cat) { return (cat === '세면대' || cat === '기타') ? '개' : '장'; }
function catIsCeramicLike(cat) { return cat === '세라믹' || cat === '석재'; }   // 헤베(㎡)·패턴 사용
function catUsesSpec(cat) { return cat !== '기타'; }   // 규격: 세라믹·석재·무늬목·세면대
function catUsesStone(cat) { return cat === '세면대'; }   // 석종(자재종류) 선택
function basinStoneNames() { const set = new Set(BASIN_STONES.map(s => s.k)); (state.inventory || []).forEach(i => { if (itemCat(i) === '세면대' && i.stone) set.add(i.stone); }); return [...set]; }
function catColor(c) { return { '세라믹': '#0F6E56', '석재': '#7a5b2e', '세면대': '#2f6fed', '무늬목': '#9a6a12', '기타': '#6b7280' }[c || '세라믹'] || '#6b7280'; }
function catBadge(cat) { const c = cat || '세라믹'; const col = catColor(c); return `<span style="display:inline-block;font-size:9.5px;font-weight:700;color:${col};background:${col}1a;border:1px solid ${col}55;border-radius:7px;padding:1px 6px;vertical-align:middle;margin-left:4px">${esc(c)}</span>`; }
function stockBaseList() {
  const f = filters.stock;
  let list = state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (f === 'none') list = list.filter(i => stockState(i).k === '없음');
  else if (f === 'short') list = list.filter(i => ['부족', '임박'].includes(stockState(i).k));
  else if (f === 'low') list = list.filter(i => ['부족', '없음'].includes(stockState(i).k));
  else if (f === 'ok') list = list.filter(i => stockState(i).k === '정상');
  else if (f === 'dmg') list = list.filter(i => damagedStock(i.name) > 0);
  const cat = filters.stockCat || 'all';
  if (cat !== 'all') list = list.filter(i => itemCat(i) === cat);
  const q = (filters.stockSearch || '').trim().toLowerCase();
  if (q) list = list.filter(i => (i.name || '').toLowerCase().includes(q) || (i.spec || '').toLowerCase().includes(q) || (i.vendor || '').toLowerCase().includes(q) || itemCat(i).includes(q));
  return list;
}
function stockRowsHtml(list) {
  if (!list.length) return `<tr><td colspan="8"><div class="empty"><i class="ti ti-package-off"></i>해당하는 자재가 없습니다</div></td></tr>`;
  return list.map(i => {
    const s = stockState(i);
    const held = heldJangFor(i.name), avail = (+i.jang || 0) - held;
    const dmg = damagedStock(i.name);
    const plan = plannedJangFor(i.name), planD = restockDateForItem(i.name);
    const cat = itemCat(i), u = itemUnit(cat), ceramic = catIsCeramicLike(cat);
    const planTxt = plan > 0 ? `<div style="font-size:10px;color:#2f6fed;font-weight:700">입고 예정 ${plan}${u}${planD ? ` <span style="font-weight:500;color:#5a86e0">(${(() => { const p = String(planD).split('-'); return p.length === 3 ? +p[1] + '/' + +p[2] : planD; })()})</span>` : ''}</div>` : '';
    return `<tr onclick="openItemForm('${i.id}')">
      <td><b>${esc(i.name)}</b>${catBadge(cat)}${dmg > 0 ? ` <span style="display:inline-block;font-size:10px;font-weight:700;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:1px 6px">파손 ${dmg}</span>` : ''}<div style="font-size:11px;color:var(--t3)">${esc(i.vendor || '')}${i.stone ? ` · 석종 ${esc(i.stone)}` : ''}</div></td>
      <td>${esc(i.spec || '-')}</td>
      <td style="font-size:11px">${ceramic ? patternStockCell(i.name) : '-'}</td>
      <td><b>${(+i.jang || 0)}</b>${u}${i.safeJang ? `<div style="font-size:10px;color:var(--t3)">안전 ${i.safeJang}</div>` : ''}${planTxt}</td>
      <td><b style="color:${avail <= 0 ? 'var(--red-t)' : 'var(--gd)'}">${avail}</b>${u}${held > 0 ? `<div style="font-size:10px;color:var(--t3)">홀딩 ${held}</div>` : ''}</td>
      <td>${ceramic ? itemHebe(i).toFixed(1) + '㎡' : '-'}</td>
      <td><span class="pill ${s.cls}">${s.k}</span></td>
      <td>${esc(i.depot || '본사')}</td>
    </tr>`;
  }).join('');
}
function filterStockTable() {
  filters.stockSearch = el('stock-search') ? el('stock-search').value : '';
  const list = stockBaseList();
  if (el('stock-tbody')) el('stock-tbody').innerHTML = stockRowsHtml(list);
  if (el('stock-count')) el('stock-count').textContent = list.length + '종';
}
/* 입고 내역 전체 (최신순) */
function inTxnList() {
  return state.transactions.filter(t => t.type === 'in').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.date || '').localeCompare(a.date || ''));
}
/* 입고 내역 목록 HTML (검색 반영) */
function inListHtml() {
  const q = (filters.inSearch || '').trim().toLowerCase();
  let list = inTxnList();
  if (q) list = list.filter(t => (t.itemName || '').toLowerCase().includes(q) || (t.vendor || '').toLowerCase().includes(q) || (t.lot || '').toLowerCase().includes(q));
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>${q ? '검색 결과가 없습니다' : '입고 내역 없음'}</div>`;
  return list.map(t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd)"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>${esc(t.itemName)} +${(+t.hebe || 0).toFixed(1)}㎡ (${+t.jang || 0}장)</b><span>${esc(t.date)} · 롯트 ${esc(t.lot || '-')} · ${esc(t.vendor || '')} · ${esc(t.by || '')}</span></div>${isAdmin() ? `<button class="x" onclick="delIn('${t.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}</div>`).join('');
}
/* 검색어 입력 시 목록만 교체 (한글 입력 끊김 방지) */
function filterInList() {
  filters.inSearch = el('in-search') ? el('in-search').value : '';
  if (el('in-list')) el('in-list').innerHTML = inListHtml();
  const x = el('in-search-x'); if (x) x.style.display = (filters.inSearch || '').trim() ? '' : 'none';
}
/* 입고 내역 → 엑셀(.xls) 다운로드 (검색 반영, 패턴별 행 분리) */
function downloadInXls() {
  const q = (filters.inSearch || '').trim().toLowerCase();
  let list = inTxnList();
  if (q) list = list.filter(t => (t.itemName || '').toLowerCase().includes(q) || (t.vendor || '').toLowerCase().includes(q) || (t.lot || '').toLowerCase().includes(q));
  if (!list.length) { toast('내보낼 입고 내역이 없습니다'); return; }
  const rows = [];
  list.forEach(t => {
    const it = state.inventory.find(i => _normName(i.name) === _normName(t.itemName));
    const per = it ? (+it.hebePerJang || 0) : 0;
    const pats = (t.patterns && t.patterns.length) ? t.patterns : [{ pattern: '', jang: +t.jang || 0 }];
    pats.forEach(p => { const jg = +p.jang || 0; rows.push({ date: t.date || '', name: t.itemName || '', spec: t.spec || (it && it.spec) || '', pattern: p.pattern || '', jang: jg, hebe: +(jg * per).toFixed(2), lot: t.lot || '', vendor: t.vendor || '', by: t.by || '', note: t.note || '' }); });
  });
  const tj = rows.reduce((a, b) => a + b.jang, 0), th = rows.reduce((a, b) => a + b.hebe, 0);
  const TH = (t, w) => `<th style="background:#0F6E56;color:#fff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const body = rows.map((r, i) => { const bg = i % 2 ? 'background:#f3f6f4;' : ''; return `<tr>${TD(esc(r.date), bg)}${TD('<b>' + esc(r.name) + '</b>', bg)}${TD(esc(r.spec), bg)}${TD(esc(r.pattern), bg)}${TD(r.jang, bg + 'text-align:right')}${TD(r.hebe.toFixed(2), bg + 'text-align:right')}${TD(esc(r.lot), bg)}${TD(esc(r.vendor), bg)}${TD(esc(r.by), bg)}${TD(esc(r.note), bg)}</tr>`; }).join('');
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const scope = q ? `검색 "${esc(filters.inSearch.trim())}"` : '전체';
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>입고내역</x:Name><x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="10" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 입고 내역</td></tr>
<tr><td colspan="10" style="font-size:9pt;color:#777;padding:0 4px 10px">범위 ${scope}  ·  생성일 ${todayStr()}  ·  총 ${rows.length}행</td></tr>
<tr>${TH('입고일', 90)}${TH('자재명', 150)}${TH('규격', 110)}${TH('패턴', 90)}${TH('장수', 60)}${TH('헤베(㎡)', 80)}${TH('롯트', 110)}${TH('발주처', 120)}${TH('담당', 80)}${TH('메모', 140)}</tr>
${body}
<tr><td colspan="4" style="${sumStyle};text-align:right">합계</td><td style="${sumStyle};text-align:right">${tj}</td><td style="${sumStyle};text-align:right">${th.toFixed(2)}</td><td colspan="4" style="${sumStyle}"></td></tr>
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '입고내역_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('입고 엑셀 다운로드 (' + rows.length + '행)');
}
function renderStock() {
  const f = filters.stock;
  const list = stockBaseList();
  const ins = state.transactions.filter(t => t.type === 'in').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);

  el('pg-stock').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-packages"></i>재고 · 입고</h2><p>장수·헤베(㎡) 기준 · 안전재고 자동 표시</p></div></div>
    <div style="display:flex;gap:9px;margin-bottom:9px">
      <button class="btn btn-pri" style="flex:1" onclick="openStockForm()"><i class="ti ti-login"></i>입고 등록</button>
      <button class="btn" style="flex:1" onclick="openItemForm()"><i class="ti ti-plus"></i>품목 추가</button>
    </div>
    <button class="btn btn-block" style="margin-bottom:12px" onclick="bulkInOpen()"><i class="ti ti-file-spreadsheet"></i>엑셀로 여러 건 한꺼번에 입고</button>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="stock-search" placeholder="품명·규격·공급처 검색" value="${esc(filters.stockSearch || '')}" oninput="filterStockTable()" autocomplete="off">
      ${filters.stockSearch ? `<button class="search-x" onclick="el('stock-search').value='';filterStockTable()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div class="chips">${['all'].concat(ITEM_CATS).map(chipCat).join('')}</div>
    <div class="chips">${chipS('all', '전체', f)}${chipS('none', '없음', f)}${chipS('short', '부족', f)}${chipS('ok', '정상', f)}${chipS('dmg', '파손', f)}</div>
    ${f === 'low' ? `<div class="banner warn"><i class="ti ti-alert-triangle"></i><span><b>입고가 필요한 자재</b>만 모았습니다. 자재명과 현재 수량을 확인하세요.</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:12px;color:var(--t3)">검색 결과 <b id="stock-count" style="color:var(--t1)">${list.length}종</b></span><button class="btn btn-sm" onclick="stockExportExcel()"><i class="ti ti-download"></i>재고 엑셀</button></div>
    <div class="tbl-wrap" id="stock-wrap" data-keepscroll style="max-height:calc(100vh - 360px);min-height:220px;overflow:auto">
      <table class="tbl">
        <thead><tr><th>자재명</th><th>규격</th><th>패턴별</th><th>실재고</th><th>가용</th><th>헤베(㎡)</th><th>상태</th><th>창고</th></tr></thead>
        <tbody id="stock-tbody">${stockRowsHtml(list)}</tbody>
      </table>
    </div>
    ${restockCardHtml()}
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3><i class="ti ti-login"></i>입고 내역</h3><button class="btn btn-sm" onclick="downloadInXls()"><i class="ti ti-file-spreadsheet"></i>엑셀</button></div>
      <div class="search-box" style="margin-bottom:10px">
        <i class="ti ti-search"></i>
        <input id="in-search" placeholder="자재명·공급처·롯트 검색" value="${esc(filters.inSearch || '')}" oninput="filterInList()" autocomplete="off" lang="ko">
        <button class="search-x" id="in-search-x" style="${(filters.inSearch || '').trim() ? '' : 'display:none'}" onclick="el('in-search').value='';filterInList()"><i class="ti ti-x"></i></button>
      </div>
      <div id="in-list" data-keepscroll style="max-height:360px;overflow-y:auto;-webkit-overflow-scrolling:touch">${inListHtml()}</div>
    </div>`;
}
function chipS(v, l, c) { return `<button class="chip ${c === v ? 'active' : ''}" onclick="filters.stock='${v}';renderStock()">${l}</button>`; }
function chipCat(c) { const cur = filters.stockCat || 'all'; const label = c === 'all' ? '전체종류' : c; const on = cur === c; const col = c === 'all' ? '' : catColor(c); return `<button class="chip ${on ? 'active' : ''}" style="${on && col ? `background:${col};border-color:${col};color:#fff` : (col ? `color:${col}` : '')}" onclick="filters.stockCat='${c}';renderStock()">${label}</button>`; }
/* 현재 재고 리스트 → 엑셀 (항목별 실재고 · 롯트 참고) */
function stockExportExcel() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const rows = [];
  state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(it => {
    const jang = +it.jang || 0;
    if (jang === 0) return;   // 재고 0 제외
    const per = +it.hebePerJang || 0;
    // 롯트별·패턴별 잔여(참고). 출고에 미기입분은 '(미지정)'으로 집계됨
    const lotText = lotStock(it.name).filter(l => l.remain !== 0)
      .map(l => `${l.lot} ${l.remain}장`).join(' · ');
    const patText = patternStock(it.name).map(p => `${p.pattern} ${p.remain}장`).join(' · ');
    rows.push({
      '자재명': it.name || '',
      '규격': it.spec || '',
      '실재고(장)': jang,
      '가용(장)': availJang(it),
      '파손(장)': (function () { const d = damagedStock(it.name); return d > 0 ? d : ''; })(),
      '헤베(㎡)': +(jang * per).toFixed(2),
      '패턴별(참고)': patText,
      '롯트별(참고)': lotText,
      '창고': it.depot || '',
      '공급처': it.vendor || ''
    });
  });
  if (!rows.length) { toast('재고가 없습니다'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '재고');
  XLSX.writeFile(wb, `재고리스트_${todayStr()}.xlsx`);
  toast('재고 ' + rows.length + '종 다운로드');
}

/* 품목 추가/수정 */
/* 내역 리스트: 10건만 보이고 나머지는 "더 보기"로 펼침 */
function txnRowsWithMore(arr, moreId, rowFn, emptyMsg) {
  if (!arr.length) return `<div class="empty" style="padding:16px"><i class="ti ti-inbox"></i>${emptyMsg}</div>`;
  const first = arr.slice(0, 10).map(rowFn).join('');
  if (arr.length <= 10) return first;
  const rest = arr.slice(10).map(rowFn).join('');
  return first + `<div id="${moreId}" class="hidden">${rest}</div>` +
    `<button class="btn btn-ghost btn-sm btn-block" style="margin-top:6px" onclick="el('${moreId}').classList.remove('hidden');this.remove()"><i class="ti ti-chevron-down"></i>더 보기 (${arr.length - 10}건)</button>`;
}
function openItemForm(id) {
  const it = id ? state.inventory.find(x => x.id === id) : null;
  const v = it || {};
  const txns = it ? state.transactions.filter(t => (t.itemId && t.itemId === id) || t.itemName === it.name) : [];
  const outs = txns.filter(t => t.type === 'out').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const ins = txns.filter(t => t.type === 'in').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const totalOut = outs.reduce((a, b) => a + (+b.jang || 0), 0);
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-box"></i>${it ? '품목 수정' : '품목 추가'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld"><label>제품 종류<span class="req">*</span></label>
        <select id="i-cat" onchange="onItemCatChange()">${ITEM_CATS.map(c => `<option value="${c}" ${itemCat(v) === c ? 'selected' : ''}>${c}${c === '기타' ? ' (폽업·수전 등)' : ''}</option>`).join('')}</select>
      </div>
      <div class="fld" id="i-stone-fld"><label>석종(자재종류) <span style="color:var(--t3);font-weight:500">— 세면대 (기존 목록 선택 또는 새로 입력)</span></label>${searchBox('i-stone', '석종 검색·입력', v.stone || '', 'basinStoneNames', '')}</div>
      <div class="fld"><label>자재명<span class="req">*</span> <span style="color:var(--t3);font-weight:500" id="i-name-hint"></span></label><input id="i-name" value="${esc(v.name || '')}" placeholder="자재명"></div>
      <div class="fld" id="i-spec-fld"><label>규격 (가로*세로*두께)</label>
        <select id="i-spec" onchange="onSpecChange('i')">${specOptions(v.spec || '')}</select>
      </div>
      <div class="fld full hidden" id="i-spec-add">
        <label>새 규격 입력 후 추가</label>
        <div style="display:flex;gap:8px">
          <input id="i-spec-new" placeholder="가로*세로*두께" inputmode="text" style="flex:1">
          <button class="btn btn-pri btn-sm" type="button" onclick="commitSpec('i')"><i class="ti ti-plus"></i>추가</button>
        </div>
      </div>
      <div class="fld"><label>공급처/발주처</label><select id="i-vendor" onchange="onMasterChange('i-vendor','suppliers')">${masterOptions('suppliers', v.vendor || '')}</select></div>
      <div class="fld full hidden" id="i-vendor-add"><label>새 공급처 입력 후 추가</label><div style="display:flex;gap:8px"><input id="i-vendor-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('i-vendor','suppliers')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld"><label>창고</label><input id="i-depot" value="${esc(v.depot || '본사')}"></div>
      <div class="fld"><label id="i-jang-label">현재 ${itemUnit(itemCat(v)) === '개' ? '수량(개)' : '장수'}</label><input id="i-jang" value="${esc(v.jang || 0)}" inputmode="numeric" oninput="updateItemHebe()"></div>
      <div class="fld"><label id="i-safe-label">안전재고(${itemUnit(itemCat(v))}) — 미만이면 '부족'</label><input id="i-safe" value="${esc(v.safeJang || 0)}" inputmode="numeric" placeholder="안전재고"></div>
      <div class="fld full" id="i-hebe-fld"><div class="reco" id="i-hebe-info" style="margin-top:0"><div class="reco-h"><i class="ti ti-ruler-2"></i>자동 환산</div><div class="row"><span class="rl">장당 헤베</span><span class="rv"><b id="i-perjang">${(parseSpec(v.spec).hebePerJang || 0).toFixed(3)}</b> ㎡/장</span></div><div class="row"><span class="rl">현재 재고 헤베</span><span class="rv"><b id="i-tothebe">${itemHebe(v).toFixed(2)}</b> ㎡</span></div></div></div>
    </div>
    <div id="i-pattern-block">
    <div class="sec-label"><i class="ti ti-layout-grid"></i>패턴 정의(고정) <span style="font-weight:500;color:var(--t3)">— 입고 때 자동 표시</span></div>
    <div style="font-size:11.5px;color:var(--t3);margin-bottom:6px;background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 이 자재의 패턴을 배치 순서대로 적어두면(예: 1번(좌상), 2번(우상)) 입고 등록 때 그대로 자동 표시돼 매번 입력할 필요가 없습니다. 공정이 바뀌면 언제든 여기서 수정하세요.</div>
    <div id="ipat-defs">${(() => { const defs = it ? matPatternDefs(it.name) : []; return defs.length ? defs.map(ipatDefRow).join('') : ipatDefRow(''); })()}</div>
    <button class="btn btn-ghost btn-sm" type="button" onclick="addIpatDef()" style="margin-bottom:8px"><i class="ti ti-plus"></i>패턴 추가</button>
    </div>
    ${it ? `
    <div class="sec-label" style="display:flex;justify-content:space-between;align-items:center"><span><i class="ti ti-list-details"></i>롯트별 재고</span>${isAdmin() ? `<button class="btn btn-ghost btn-sm" type="button" onclick="openAdjustForm('${it.id}')"><i class="ti ti-adjustments"></i>재고 조정</button>` : ''}</div>
    ${(() => { const ls = lotStock(it.name); return ls.length ? `<div class="tbl-wrap" style="margin-bottom:6px"><table class="tbl"><thead><tr><th>롯트</th><th>입고</th><th>출고</th><th>잔여</th></tr></thead><tbody>${ls.map(l => `<tr><td><b>${esc(l.lot)}</b></td><td>${l.inQty}장</td><td>${l.outQty}장</td><td><b style="color:${l.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${l.remain}장</b></td></tr>`).join('')}</tbody></table></div>` : `<div style="font-size:12.5px;color:var(--t3);padding:2px 0 8px">롯트 정보가 없습니다 (입고 시 롯트를 입력하면 표시됩니다)</div>`; })()}
    ${(() => { const ds = depotStock(it.name); return ds.length > 1 ? `<div class="sec-label"><i class="ti ti-building-warehouse"></i>창고별 재고</div><div class="tbl-wrap" style="margin-bottom:6px"><table class="tbl"><thead><tr><th>창고</th><th>입고</th><th>출고</th><th>잔여</th></tr></thead><tbody>${ds.map(d => `<tr><td><b>${esc(d.depot)}</b></td><td>${d.inQty}장</td><td>${d.outQty}장</td><td><b style="color:${d.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${d.remain}장</b></td></tr>`).join('')}</tbody></table></div>` : ''; })()}
    <div class="sec-label" style="display:flex;justify-content:space-between;align-items:center"><span><i class="ti ti-alert-square-rounded" style="color:#d64545"></i> 파손 재고 <b style="color:#b42318">${damagedStock(it.name)}장</b></span><button class="btn btn-ghost btn-sm" type="button" onclick="openDamageForm('${it.id}')"><i class="ti ti-arrow-right-bar"></i>파손 처리</button></div>
    ${isAdmin() ? `<div class="sec-label"><i class="ti ti-history"></i>재고 조정 내역 <span style="font-weight:500;color:var(--t3)">(관리자)</span></div>
    ${(() => { const adjs = txns.filter(t => t.type === 'adjust').sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0)); return adjs.length ? adjs.map(t => { const d = +t.jang || 0; return `<div class="alert-i b" style="margin-bottom:6px"><div class="ai" style="color:${d >= 0 ? 'var(--gd)' : 'var(--red-t)'}"><i class="ti ti-adjustments"></i></div><div class="at"><b style="color:${d >= 0 ? 'var(--gd)' : 'var(--red-t)'}">${d > 0 ? '+' : ''}${d}장</b><span>${esc(t.date || '')}${t.lot ? ' · 롯트 ' + esc(t.lot) : ''}${t.pattern ? ' · 패턴 ' + esc(t.pattern) : ''} · ${esc(t.note || '')} · ${esc(t.by || '')}</span></div><button class="btn btn-ghost btn-sm" type="button" onclick="event.stopPropagation();delAdjust('${t.id}')" title="되돌리기"><i class="ti ti-arrow-back-up"></i></button></div>`; }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:2px 0 8px">조정 내역이 없습니다</div>`; })()}` : ''}
    <div class="sec-label"><i class="ti ti-logout"></i>출고 내역 <span style="font-weight:500;color:var(--t3)">· 누적 ${totalOut}장</span></div>
    <div style="font-size:11.5px;color:var(--t3);margin-bottom:6px"><i class="ti ti-info-circle"></i> 출고를 탭하면 롯트·패턴을 지정해 미지정을 해소할 수 있습니다</div>
    ${txnRowsWithMore(outs, 'out-more', t => { const dmg = (t.damaged === true) || (t.damaged === undefined && /파손/.test(t.note || '')); return `<div class="alert-i b" style="margin-bottom:6px;cursor:pointer" onclick="openOutEdit('${t.id}')" title="탭하면 롯트·패턴 지정"><div class="ai"><i class="ti ti-logout"></i></div><div class="at"><b>${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}${dmg ? ` <span style="display:inline-block;font-size:10px;font-weight:700;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:1px 6px">파손</span>` : ''}</b><span>${esc(t.date || '')} · ${esc(t.targetName || '-')}${t.lot ? ' · 롯트 ' + esc(t.lot) : ' · <span style="color:var(--red-t)">롯트 미지정</span>'}</span></div><i class="ti ti-edit" style="color:var(--t3);align-self:center"></i></div>`; }, '출고 내역 없음')}
    <div class="sec-label" style="margin-top:14px"><i class="ti ti-login"></i>입고 내역</div>
    <div style="font-size:11.5px;color:var(--t3);margin-bottom:6px"><i class="ti ti-info-circle"></i> 입고 내역을 탭하면 롯트·패턴을 수정할 수 있습니다</div>
    ${txnRowsWithMore(ins, 'in-more', t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd);margin-bottom:6px;cursor:pointer" onclick="openInEdit('${t.id}')" title="탭하면 롯트·패턴 수정"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>+${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}</b><span>${esc(t.date || '')} · 롯트 ${esc(t.lot || '-')} · ${esc(t.by || '')}</span></div><i class="ti ti-edit" style="color:var(--t3);align-self:center"></i></div>`, '입고 내역 없음')}
    ` : ''}
    <div class="frm-foot">
      ${it && isAdmin() ? `<button class="btn btn-danger" onclick="delItem('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:1.4" onclick="submitItem('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
  setSelectValue('i-vendor', 'suppliers', v.vendor);
  onItemCatChange();   // 종류에 맞춰 규격·헤베·패턴 표시/숨김 + 단위 라벨 반영
}
/* 품목 폼: 종류 변경 시 세라믹 전용 항목 표시/숨김 + 단위 라벨 갱신 */
function onItemCatChange() {
  const cat = el('i-cat') ? el('i-cat').value : '세라믹';
  const ceramic = catIsCeramicLike(cat);   // 헤베·패턴
  const toggle = (id, show) => { const e = el(id); if (e) e.style.display = show ? '' : 'none'; };
  toggle('i-stone-fld', catUsesStone(cat));   // 석종 — 세면대만
  toggle('i-spec-fld', catUsesSpec(cat));     // 규격 — 기타 빼고 전부(세면대·무늬목 포함)
  toggle('i-hebe-fld', ceramic);              // 헤베(㎡) — 세라믹·석재
  toggle('i-pattern-block', ceramic);         // 패턴 — 세라믹·석재
  if (!catUsesSpec(cat)) { const a = el('i-spec-add'); if (a) a.classList.add('hidden'); }
  const u = itemUnit(cat);
  const jl = el('i-jang-label'); if (jl) jl.textContent = '현재 ' + (u === '개' ? '수량(개)' : '장수');
  const sl = el('i-safe-label'); if (sl) sl.textContent = "안전재고(" + u + ") — 미만이면 '부족'";
  const nh = el('i-name-hint'); if (nh) nh.textContent = catUsesStone(cat) ? '(비우면 석종명으로 저장)' : '';
}
/* 현재고 → 파손 처리(정상↔파손). 실재고는 그대로, '파손' 수량만 변동 */
function openDamageForm(id) {
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const cur = damagedStock(it.name);
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-alert-square-rounded" style="color:#d64545"></i>파손 처리</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(it.name)}</b> · 실재고 ${+it.jang || 0}장 · 현재 파손 <b style="color:#b42318">${cur}장</b></div>
    <div class="frm">
      <div class="fld"><label>구분</label><select id="dm-dir"><option value="1">파손 처리 (정상 → 파손)</option><option value="-1">파손 복구 (파손 → 정상)</option></select></div>
      <div class="fld"><label>장수</label><input id="dm-jang" inputmode="numeric" value="1"></div>
      <div class="fld full"><label>롯트 <span style="color:var(--t3);font-weight:500">(선택)</span></label><select id="dm-lot">${lotSelectHtml(it.name, '')}</select></div>
      <div class="fld full"><label>패턴 <span style="color:var(--t3);font-weight:500">(선택)</span></label><select id="dm-pat">${patternSelectHtml(it.name, '')}</select></div>
      <div class="fld full"><label>사유</label><input id="dm-note" lang="ko" value="모서리 파손" placeholder="파손 사유"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 파손 처리해도 실재고(장수)는 그대로이고 '파손' 수량으로만 표시됩니다. 폐기·반품으로 실재고에서 빼려면 출고로 처리하세요.</div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitDamage('${it.id}')"><i class="ti ti-check"></i>적용</button></div>`);
}
async function submitDamage(id) {
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const dir = parseInt(el('dm-dir').value, 10) || 1;
  const n = Math.abs(parseFloat(el('dm-jang').value) || 0);
  if (n <= 0) { toast('장수를 입력하세요'); return; }
  if (dir < 0 && n > damagedStock(it.name)) { toast('복구 수량이 현재 파손 수량보다 많습니다'); return; }
  await Store.add('transactions', {
    type: 'damage', itemId: it.id, itemName: it.name, spec: it.spec || '',
    jang: dir * n, lot: (el('dm-lot').value || '').trim(), pattern: (el('dm-pat').value || '').trim(),
    note: (el('dm-note').value || '').trim() || '파손', date: todayStr(), by: me.name
  });
  closeModal();
  toast(dir > 0 ? `파손 ${n}장 처리됨` : `파손 ${n}장 복구됨`);
}
/* 입고 내역 수정 — 롯트·패턴 재배정(롯트별/패턴별 재고 자동 재계산). 장수는 변경하지 않음 */
function iepRowHtml(p) {
  p = p || {};
  const inp = 'font-size:14px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:9px';
  return `<div class="iep-row" style="display:flex;gap:6px;margin-bottom:6px">
    <input class="iep-name" lang="ko" placeholder="패턴(없으면 비움)" value="${esc(p.pattern && p.pattern !== '-' ? p.pattern : '')}" style="flex:1.4;min-width:0;${inp}">
    <input class="iep-jang" inputmode="numeric" placeholder="장수" value="${esc(p.jang != null ? p.jang : '')}" oninput="iepTotal()" style="flex:1;min-width:50px;${inp}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.iep-row').remove();iepTotal()" aria-label="삭제"><i class="ti ti-x"></i></button>
  </div>`;
}
function addIepRow() { const c = el('iep-rows'); if (c) c.insertAdjacentHTML('beforeend', iepRowHtml({})); }
function iepTotal() { let t = 0; document.querySelectorAll('#iep-rows .iep-jang').forEach(i => t += parseFloat(i.value) || 0); if (el('iep-total')) el('iep-total').textContent = t; return t; }
function openInEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'in'); if (!t) return;
  const pats = (t.patterns && t.patterns.length) ? t.patterns : [{ pattern: '', jang: +t.jang || 0 }];
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-edit"></i>입고 내역 수정</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(t.itemName || '')}</b>${t.spec ? ' · ' + esc(t.spec) : ''}</div>
    <div class="frm">
      <div class="fld"><label>입고일</label><input type="date" id="ie-date" value="${esc(t.date || '')}"></div>
      <div class="fld"><label>공급처</label><input id="ie-vendor" lang="ko" value="${esc(t.vendor || '')}"></div>
      <div class="fld"><label>창고(입고지)</label><input id="ie-depot" list="ie-depot-list" value="${esc(t.depot || '')}" placeholder="창고"><datalist id="ie-depot-list">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full"><label>롯트 넘버<span class="req">*</span></label><input id="ie-lot" value="${esc(t.lot || '')}" placeholder="롯트 넘버"></div>
      <div class="fld full"><label>패턴별 장수 <span style="color:var(--t3);font-weight:500">(패턴 없으면 이름 비우고 장수만)</span></label>
        <div id="iep-rows">${pats.map(iepRowHtml).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addIepRow()"><i class="ti ti-plus"></i>패턴 추가</button>
        <div style="font-size:12px;color:var(--t3);margin-top:4px">합계 <b id="iep-total" style="color:var(--t1)">${+t.jang || 0}</b>장</div>
      </div>
      <div class="fld full"><label>비고</label><input id="ie-note" lang="ko" value="${esc(t.note || '')}"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 롯트 넘버·패턴별 장수를 자유롭게 수정할 수 있습니다. 총 장수가 바뀌면 실재고도 자동 보정됩니다. 롯트별/패턴별 재고는 자동으로 다시 계산됩니다.</div>
    </div>
    <div class="frm-foot">${isAdmin() ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="delInTxn('${t.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitInEdit('${t.id}')"><i class="ti ti-check"></i>저장</button></div>`);
  iepTotal();
}
async function submitInEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'in'); if (!t) return;
  const lot = (el('ie-lot').value || '').trim();
  if (!lot) { toast('롯트 넘버를 입력하세요'); return; }
  const patterns = []; let newJang = 0;
  document.querySelectorAll('#iep-rows .iep-row').forEach(r => {
    const nm = (r.querySelector('.iep-name').value || '').trim();
    const q = parseFloat(r.querySelector('.iep-jang').value) || 0;
    if (q > 0) { patterns.push({ pattern: nm || '-', jang: q }); newJang += q; }
  });
  if (newJang <= 0) { toast('장수를 입력하세요'); return; }
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  const per = it ? (+it.hebePerJang || 0) : 0;
  const oldJang = +t.jang || 0;
  await Store.update('transactions', id, {
    lot, patterns, jang: newJang, hebe: +(newJang * per).toFixed(2),
    date: el('ie-date').value || t.date || '', vendor: (el('ie-vendor').value || '').trim(), note: (el('ie-note').value || '').trim(),
    depot: (el('ie-depot') && el('ie-depot').value || '').trim()
  });
  if (it && newJang !== oldJang) {
    await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) + (newJang - oldJang)) });   // 입고 총량 변경분만큼 실재고 보정
  }
  closeModal(); toast('입고 내역이 수정되었습니다');
}
/* 입고 삭제 (관리자) — 실재고에서 차감 */
async function delInTxn(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id && x.type === 'in'); if (!t) return;
  if (!guardDelete(`이 입고를 삭제할까요?\n${t.itemName} +${+t.jang || 0}장 · ${t.date || ''}\n실재고에서 차감됩니다.`)) return;
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - (+t.jang || 0)) });
  await Store.remove('transactions', id);
  closeModal(); toast('입고 삭제됨 (재고 차감)');
}
/* 재고 조정(실사 보정) — 롯트+패턴+실재고를 한 번에 ± 보정 */
function openAdjustForm(id) {
  if (!isAdmin()) { toast('재고 조정은 관리자만 가능합니다'); return; }
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const lots = lotStock(it.name).map(l => l.lot).filter(l => l && l !== '(미지정)');
  const pats = patternStock(it.name).map(p => p.pattern).filter(Boolean);
  const depots = depotStock(it.name).map(d => d.depot);
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-adjustments"></i>재고 조정 (실사 보정)</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(it.name)}</b> · 실재고 ${+it.jang || 0}장</div>
    <div class="frm">
      <div class="fld"><label>구분</label><select id="aj-dir" onchange="ajDirChange()"><option value="1">증가 (＋ 총재고)</option><option value="-1">감소 (－ 총재고)</option><option value="move">창고 이동 (총량 불변)</option></select></div>
      <div class="fld"><label>장수</label><input id="aj-jang" inputmode="numeric" value="1"></div>
      <div class="fld full" id="aj-depot-fld"><label>창고 <span style="color:var(--t3);font-weight:500">(선택 · 창고별 총재고 보정 시)</span></label><input id="aj-depot" list="aj-depot-list" placeholder="창고"><datalist id="aj-depot-list">${depots.map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full hidden" id="aj-move-fld"><label>창고 이동 (출발 → 도착) <span style="color:var(--t3);font-weight:500">(총재고는 그대로, 창고별만 이동)</span></label><div style="display:flex;gap:6px;align-items:center"><input id="aj-from" list="aj-dep2" placeholder="출발 창고" style="flex:1"><span style="flex:none;color:var(--t3)">→</span><input id="aj-to" list="aj-dep2" placeholder="도착 창고" style="flex:1"></div><datalist id="aj-dep2">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full"><label>롯트 <span style="color:var(--t3);font-weight:500">(선택 · 비우면 총량만 보정)</span></label><input id="aj-lot" list="aj-lot-list" placeholder="롯트"><datalist id="aj-lot-list">${lots.map(l => `<option value="${esc(l)}">`).join('')}</datalist></div>
      <div class="fld full"><label>패턴 <span style="color:var(--t3);font-weight:500">(선택)</span></label><input id="aj-pat" list="aj-pat-list" lang="ko" placeholder="패턴"><datalist id="aj-pat-list">${pats.map(p => `<option value="${esc(p)}">`).join('')}</datalist></div>
      <div class="fld full"><label>사유</label><input id="aj-note" lang="ko" placeholder="예: 실사 보정 · 잘못 출고 후 보관 등"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> <b>증가/감소</b>는 총재고를 바꿉니다(창고 지정 시 그 창고에 반영). <b>창고 이동</b>은 총재고는 그대로 두고 출발→도착 창고로만 옮깁니다(오출고 보관 등).</div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitAdjust('${it.id}')"><i class="ti ti-check"></i>조정</button></div>`);
  ajDirChange();
}
function ajDirChange() {
  const move = el('aj-dir') && el('aj-dir').value === 'move';
  if (el('aj-depot-fld')) el('aj-depot-fld').classList.toggle('hidden', move);
  if (el('aj-move-fld')) el('aj-move-fld').classList.toggle('hidden', !move);
}
async function submitAdjust(id) {
  if (!isAdmin()) { toast('재고 조정은 관리자만 가능합니다'); return; }
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const mode = el('aj-dir').value;
  const n = Math.abs(parseFloat(el('aj-jang').value) || 0);
  if (n <= 0) { toast('장수를 입력하세요'); return; }
  const lot = (el('aj-lot').value || '').trim(), pattern = (el('aj-pat').value || '').trim();
  const note = (el('aj-note').value || '').trim() || '재고 조정';
  if (mode === 'move') {
    const from = (el('aj-from').value || '').trim(), to = (el('aj-to').value || '').trim();
    if (!from || !to) { toast('출발·도착 창고를 입력하세요'); return; }
    if (from === to) { toast('출발과 도착 창고가 같습니다'); return; }
    const moveId = 'M' + Date.now();
    const base = { type: 'adjust', moveId, itemId: it.id, itemName: it.name, spec: it.spec || '', lot, pattern, date: todayStr(), by: me.name };
    await Store.add('transactions', Object.assign({}, base, { jang: -n, depot: from, note: `${note} (창고이동 ${from}→${to})` }));
    await Store.add('transactions', Object.assign({}, base, { jang: n, depot: to, note: `${note} (창고이동 ${from}→${to})` }));
    // 총재고(실재고)는 변경하지 않음 — 창고별만 이동
    closeModal(); toast(`창고 이동 완료 · ${from}→${to} ${n}장`);
    setTimeout(() => { if (state.inventory.find(x => x.id === id)) openItemForm(id); }, 350);
    return;
  }
  const dir = parseInt(mode, 10) || 1;
  const delta = dir * n;
  await Store.add('transactions', {
    type: 'adjust', itemId: it.id, itemName: it.name, spec: it.spec || '',
    jang: delta, lot, pattern, depot: (el('aj-depot').value || '').trim(),
    note, date: todayStr(), by: me.name
  });
  await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) + delta) });
  closeModal(); toast(`재고 조정 완료 (${delta > 0 ? '+' : ''}${delta}장)`);
  setTimeout(() => { if (state.inventory.find(x => x.id === id)) openItemForm(id); }, 350);
}
/* 조정 되돌리기 (관리자) — 조정 전 상태로 복구. 창고이동(net0)은 총재고 불변으로 그룹 삭제 */
async function delAdjust(id) {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const t = state.transactions.find(x => x.id === id && x.type === 'adjust'); if (!t) return;
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  if (t.moveId) {
    if (!confirm('이 창고 이동을 되돌릴까요? (총재고는 그대로)')) return;
    for (const g of state.transactions.filter(x => x.moveId === t.moveId)) { try { await Store.remove('transactions', g.id); } catch (e) { } }
  } else {
    if (!confirm(`이 조정(${(+t.jang || 0) > 0 ? '+' : ''}${+t.jang || 0}장)을 되돌릴까요?\n실재고·롯트·패턴 재고가 조정 전으로 복구됩니다.`)) return;
    if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - (+t.jang || 0)) });
    await Store.remove('transactions', id);
  }
  toast('조정 되돌림');
  if (it) setTimeout(() => { if (state.inventory.find(x => x.id === it.id)) openItemForm(it.id); }, 350);
}
/* 규격 select에서 "새 규격 추가" 선택 시 입력란 표시 */
function onSpecChange(prefix) {
  const sel = el(prefix + '-spec');
  const addBox = el(prefix + '-spec-add');
  if (sel.value === '__add') { if (addBox) addBox.classList.remove('hidden'); setTimeout(() => el(prefix + '-spec-new') && el(prefix + '-spec-new').focus(), 50); }
  else { if (addBox) addBox.classList.add('hidden'); if (prefix === 'i') updateItemHebe(); }
}
async function commitSpec(prefix) {
  const val = await addSpecValue(el(prefix + '-spec-new').value);
  if (!val) return;
  // 추가된 규격을 select에 반영하고 선택
  const sel = el(prefix + '-spec');
  sel.innerHTML = specOptions(val);
  el(prefix + '-spec-add').classList.add('hidden');
  if (prefix === 'i') updateItemHebe();
  toast('규격 추가됨: ' + val);
}
function updateItemHebe() {
  const ps = parseSpec(el('i-spec').value === '__add' ? '' : el('i-spec').value);
  const jang = parseFloat(el('i-jang').value) || 0;
  if (el('i-perjang')) el('i-perjang').textContent = ps.hebePerJang.toFixed(3);
  if (el('i-tothebe')) el('i-tothebe').textContent = (jang * ps.hebePerJang).toFixed(2);
}
async function submitItem(id) {
  const cat = el('i-cat') ? el('i-cat').value : '세라믹';
  const ceramic = catIsCeramicLike(cat);
  const stone = catUsesStone(cat) ? ((el('i-stone') && el('i-stone').value || '').trim()) : '';
  let name = el('i-name').value.trim();
  if (!name && stone) name = stone;   // 세면대: 자재명 비우면 석종명으로
  if (!name) { toast(catUsesStone(cat) ? '석종을 선택하거나 자재명을 입력하세요' : '자재명을 입력하세요'); return; }
  let spec = catUsesSpec(cat) ? el('i-spec').value : ''; if (spec === '__add') spec = '';
  const ps = parseSpec(spec);
  const jang = parseFloat(el('i-jang').value) || 0;
  let vendor = el('i-vendor').value; if (vendor === '__add') vendor = ''; vendor = vendor.trim();
  const patterns = [];
  if (ceramic) document.querySelectorAll('#ipat-defs .ipat-name').forEach(i => { const val = (i.value || '').trim(); if (val && !patterns.includes(val)) patterns.push(val); });
  const obj = { name, cat, stone, spec, vendor, depot: el('i-depot').value.trim() || '본사', jang, hebePerJang: ceramic ? ps.hebePerJang : 0, safeJang: parseFloat(el('i-safe').value) || 0, patterns };
  if (id) { await Store.update('inventory', id, obj); toast('저장됨'); }
  else { obj.lastInDate = todayStr(); await Store.add('inventory', obj); toast('품목 추가됨'); }
  closeModal();
}
/* 실수 삭제 방지 — 삭제하려면 '삭제' 를 직접 입력해야 진행 */
function guardDelete(msg) {
  const v = prompt((msg ? msg + '\n\n' : '') + "⚠ 실수 방지 — 삭제하려면 아래에 '삭제' 라고 입력하세요.");
  if (v == null) return false;
  if (v.trim() !== '삭제') { toast("삭제하려면 '삭제' 를 정확히 입력해야 합니다"); return false; }
  return true;
}
async function delItem(id) { if (!guardDelete('이 품목을 삭제할까요?')) return; await Store.remove('inventory', id); toast('삭제됨'); closeModal(); }

/* 입고 등록 → 자재 선택(언더바) + 롯트 + 패턴별 장수 → 헤베 자동환산 */
function openStockForm() {
  if (!state.inventory.length) { toast('먼저 품목을 추가하세요'); openItemForm(); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-login"></i>입고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>자재 선택<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(자재명 입력 → ↑↓ 방향키로 선택)</span></label>
        ${searchBox('in-item', '자재명 검색·입력', '', 'invNames', 'onInItemChange')}
      </div>
      <div class="fld"><label>규격</label><input id="in-spec" readonly placeholder="자재 선택 시 자동" style="background:var(--soft)"></div>
      <div class="fld" id="in-lot-fld"><label>롯트 넘버<span class="req">*</span></label><input id="in-lot" placeholder="롯트 넘버 입력"></div>
      <div class="fld"><label>창고(입고지)</label><input id="in-depot" list="in-depot-list" placeholder="창고"><datalist id="in-depot-list">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
    </div>
    <div id="in-pattern-block">
      <div class="sec-label"><i class="ti ti-layout-grid"></i>패턴별 장수 <span style="font-weight:500;color:var(--t3)">(패턴이 없으면 장수만 입력)</span></div>
      <div id="in-patterns"></div>
      <button class="btn btn-ghost btn-sm" type="button" onclick="addPatternRow()" style="margin-top:4px"><i class="ti ti-plus"></i>패턴 추가</button>
    </div>
    <div class="frm" id="in-simple-block" style="display:none">
      <div class="fld"><label id="in-simple-label">수량</label><input id="in-simple-qty" inputmode="numeric" placeholder="수량 입력" oninput="computeInTotal()"></div>
    </div>
    <div class="frm" style="margin-top:14px">
      <div class="fld"><label>입고일</label><input type="date" id="in-date" value="${todayStr()}"></div>
      <div class="fld"><label>발주처/매입처 <span style="color:var(--t3);font-weight:500">(기본: 직발주)</span></label><select id="in-vendor" onchange="onMasterChange('in-vendor','suppliers')">${masterOptions('suppliers', '다우세라믹앤석재')}</select></div>
      <div class="fld full hidden" id="in-vendor-add"><label>기타 발주처 입력 후 추가</label><div style="display:flex;gap:8px"><input id="in-vendor-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('in-vendor','suppliers')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld full"><label>메모</label><input id="in-note" placeholder="선택"></div>
    </div>
    <div class="reco" id="in-summary" style="margin-top:14px"><div class="reco-h"><i class="ti ti-calculator"></i>합계</div>
      <div class="row"><span class="rl">총 입고 수량</span><span class="rv"><b id="in-tot-jang">0</b> <span id="in-tot-unit">장</span></span></div>
      <div class="row" id="in-hebe-row"><span class="rl">환산 헤베</span><span class="rv"><b id="in-tot-hebe">0</b> ㎡</span></div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitStock()"><i class="ti ti-check"></i>입고 등록</button></div>`);
  _inLastMat = '';
  addPatternRow();
  onInItemChange();
}
let _inLastMat = '';   // 입고 폼에서 마지막으로 선택된 자재 (패턴 재채움 판단용)
function inSelItem() {   // 입고 폼에서 검색창에 입력된 자재명 → 재고 품목
  const nm = (el('in-item') && el('in-item').value || '').trim();
  return state.inventory.find(i => _normName(i.name) === _normName(nm));
}
function onInItemChange() {
  const it = inSelItem();
  el('in-spec').value = it ? (it.spec || '-') : '';
  if (el('in-depot')) el('in-depot').value = it ? (it.depot || '') : '';   // 선택 자재의 기본 창고
  // 종류별: 세라믹·석재는 롯트+패턴, 그 외(세면대·무늬목·기타)는 수량만
  const cat = it ? itemCat(it) : '세라믹';
  const ceramic = catIsCeramicLike(cat);
  const show = (id, on) => { const e = el(id); if (e) e.style.display = on ? '' : 'none'; };
  show('in-lot-fld', ceramic);
  show('in-pattern-block', ceramic);
  show('in-simple-block', !ceramic && !!it);
  show('in-hebe-row', ceramic);
  const sl = el('in-simple-label'); if (sl) sl.textContent = '수량(' + itemUnit(cat) + ')';
  if (it && it.name !== _inLastMat) {
    _inLastMat = it.name;
    if (ceramic) fillInPatterns(it.name);   // 자재가 바뀔 때만 고정 패턴 새로 채움
  } else if (!it) _inLastMat = '';
  computeInTotal();
}
/* 선택 자재의 고정 패턴대로 입고 패턴칸 자동 구성 (없으면 빈 칸 1개) */
function fillInPatterns(matName) {
  const box = el('in-patterns'); if (!box) return;
  box.innerHTML = '';
  const defs = matPatternDefs(matName);
  if (defs.length) defs.forEach(p => addPatternRow(p));
  else addPatternRow();
  computeInTotal();
}
function addPatternRow(name) {
  const box = el('in-patterns'); if (!box) return;
  const row = document.createElement('div');
  row.className = 'pat-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
  row.innerHTML = `<input class="in-pat-name" lang="ko" placeholder="패턴(선택)" value="${esc(name || '')}" style="flex:1.2;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <input class="in-pat-jang" inputmode="numeric" placeholder="장수" oninput="computeInTotal()" style="flex:1;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <button class="btn btn-ghost btn-sm" type="button" onclick="this.parentElement.remove();computeInTotal()"><i class="ti ti-x"></i></button>`;
  box.appendChild(row);
}
function computeInTotal() {
  const it = inSelItem();
  const cat = it ? itemCat(it) : '세라믹';
  const ceramic = catIsCeramicLike(cat);
  let tot = 0;
  if (ceramic) document.querySelectorAll('#in-patterns .in-pat-jang').forEach(i => tot += parseFloat(i.value) || 0);
  else tot = parseFloat(el('in-simple-qty') && el('in-simple-qty').value) || 0;
  const per = it ? (+it.hebePerJang || 0) : 0;
  if (el('in-tot-jang')) el('in-tot-jang').textContent = tot;
  if (el('in-tot-unit')) el('in-tot-unit').textContent = itemUnit(cat);
  if (el('in-tot-hebe')) el('in-tot-hebe').textContent = (tot * per).toFixed(2);
}
async function submitStock() {
  const it = inSelItem();
  if (!it) { toast('자재를 선택하세요 (자재명 입력 후 목록에서 선택)'); return; }
  const ceramic = catIsCeramicLike(itemCat(it));
  let lot = ''; const patterns = []; let jang = 0;
  if (ceramic) {
    lot = el('in-lot').value.trim();
    if (!lot) { toast('롯트 넘버를 입력하세요 (세라믹·석재 필수)'); return; }
    document.querySelectorAll('#in-patterns .pat-row').forEach(r => {
      const nm = r.querySelector('.in-pat-name').value.trim();
      const q = parseFloat(r.querySelector('.in-pat-jang').value) || 0;
      if (q > 0) { patterns.push({ pattern: nm || '-', jang: q }); jang += q; }
    });
  } else {
    jang = parseFloat(el('in-simple-qty') && el('in-simple-qty').value) || 0;   // 세면대·무늬목·기타: 롯트·패턴 없이 수량만
  }
  if (jang <= 0) { toast('입고 수량을 입력하세요'); return; }
  const hebe = ceramic ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
  let vendor = el('in-vendor').value; if (vendor === '__add') vendor = ''; vendor = (vendor || '다우세라믹앤석재').trim();
  const date = el('in-date').value, note = el('in-note').value.trim();
  const depot = (el('in-depot') && el('in-depot').value || '').trim() || it.depot || '본사';
  const newJang = (+it.jang || 0) + jang;
  await Store.update('inventory', it.id, { jang: newJang, lastInDate: date });
  await Store.add('transactions', { type: 'in', itemId: it.id, itemName: it.name, spec: it.spec, lot, patterns, jang, hebe, vendor, date, note, depot, by: me.name });
  await clearRestocksOnIn(it.name);
  const conv = await activatePlannedHolds(it.name, newJang);
  const u = itemUnit(itemCat(it));
  toast(`입고 완료 · ${jang}${u}` + (ceramic ? ` (${hebe}㎡)` : '') + (conv ? ` · 예정홀딩 ${conv}건 활성화` : '')); closeModal();
}

/* ===================================================================
   예정 입고(재입고 예정) — 발주 등록 · 실제 입고 시 자동 완료
   =================================================================== */
/* 활성 예정입고 전체 (예정일 빠른 순) */
function activeRestocks() {
  return (state.restocks || []).filter(r => !r.done)
    .sort((a, b) => (a.expectedDate || '9999-99-99').localeCompare(b.expectedDate || '9999-99-99'));
}
let _rsN = 0;
function rsRowHtml(d) {
  d = d || {}; const i = _rsN++;
  return `<div class="rs-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
    <div style="flex:2.2;min-width:0">${searchBox('rsm-' + i, '자재명 검색·입력', d.name || '', 'matNames', '')}</div>
    <input class="rs-qty" inputmode="numeric" placeholder="수량" value="${esc(d.qty || '')}" style="flex:1;min-width:56px;font-size:15px;padding:10px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <button type="button" class="btn btn-ghost btn-sm" style="flex:none" onclick="this.closest('.rs-row').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
  </div>`;
}
function addRsRow(d) { const c = el('rs-rows'); if (c) c.insertAdjacentHTML('beforeend', rsRowHtml(d)); }
function collectRsRows() {
  const rows = [];
  document.querySelectorAll('#rs-rows .rs-row').forEach(r => {
    const inp = r.querySelector('input.sb-in'); const name = inp ? (inp.value || '').trim() : '';
    const qty = parseFloat(r.querySelector('.rs-qty').value) || 0;
    if (name) rows.push({ name: name, qty: qty });
  });
  return rows;
}
function openRestockForm(id) {
  const r = id ? (state.restocks || []).find(x => x.id === id) : null; const v = r || {};
  _rsN = 0;
  const rowsInit = r ? [{ name: v.itemName, qty: v.jang || '' }] : [{}];
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-truck-delivery"></i>${r ? '예정 입고 수정' : '예정 입고 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>발주한 자재의 <b>입고 예정</b>을 등록합니다. 고객 재고 화면의 <b>품절</b> 자재에 예정일이 표시되고, 실제 입고를 등록하면 자동으로 정리됩니다.</span></div>
    <div class="frm">
      <div class="fld full"><label>자재 · 수량<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 개는 '자재 추가')</span></label>
        <div id="rs-rows">${rowsInit.map(rsRowHtml).join('')}</div>
        ${!r ? `<button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addRsRow({})"><i class="ti ti-plus"></i>자재 추가</button>` : ''}
      </div>
      <div class="fld"><label>입고 예정일<span class="req">*</span></label><input type="date" id="rs-date" value="${esc(v.expectedDate || '')}"></div>
      <div class="fld full"><label>메모</label><input id="rs-note" lang="ko" value="${esc(v.note || '')}" placeholder="선택 (공통 적용)"></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitRestock('${id || ''}')"><i class="ti ti-check"></i>${r ? '저장' : '등록'}</button>
    </div>`);
}
async function submitRestock(id) {
  const date = el('rs-date') && el('rs-date').value;
  if (!date) { toast('입고 예정일을 선택하세요'); return; }
  const note = (el('rs-note') && el('rs-note').value || '').trim();
  const rows = collectRsRows();
  if (!rows.length) { toast('자재명을 입력하세요'); return; }
  if (id) {   // 수정: 단일 건
    const row = rows[0];
    const it = state.inventory.find(i => _normName(i.name) === _normName(row.name));
    await Store.update('restocks', id, { itemName: row.name, spec: it ? it.spec : '', jang: row.qty || 0, expectedDate: date, note: note, done: false });
    await syncItemRestock(row.name);
    toast('예정 입고 수정됨'); closeModal(); return;
  }
  const names = new Set();
  for (const row of rows) {
    const it = state.inventory.find(i => _normName(i.name) === _normName(row.name));
    await Store.add('restocks', { itemName: row.name, spec: it ? it.spec : '', jang: row.qty || 0, expectedDate: date, note: note, done: false, createdAt: Date.now(), by: me.name });
    names.add(row.name);
  }
  for (const n of names) await syncItemRestock(n);
  toast(`예정 입고 ${rows.length}건 등록됨`); closeModal();
}
async function delRestock(id) {
  const r = (state.restocks || []).find(x => x.id === id);
  if (!confirm('이 예정 입고를 삭제할까요?')) return;
  await Store.remove('restocks', id);
  if (r) await syncItemRestock(r.itemName);
  toast('삭제됨');
}
/* 재고 화면용 예정 입고 목록 카드 */
function restockCardHtml() {
  const list = activeRestocks();
  const rows = list.length ? list.map(r => {
    const d = daysFromNow(r.expectedDate);
    const dtag = d != null ? (d < 0 ? '<span style="color:var(--red-t)">지남</span>' : (d === 0 ? '<span style="color:var(--amber-t)">오늘</span>' : `D-${d}`)) : '';
    return `<div class="alert-i b" style="background:var(--amber-l,#fef6e7);border-color:#f5d99b">
      <div class="ai" style="color:var(--amber-t)"><i class="ti ti-truck-delivery"></i></div>
      <div class="at"><b style="word-break:keep-all">${esc(r.itemName)}${r.jang ? ` · ${+r.jang || 0}장` : ''}</b><span>입고 예정 ${esc(r.expectedDate || '-')} ${dtag}${r.vendor ? ` · ${esc(r.vendor)}` : ''}</span></div>
      <div style="display:flex;gap:2px;flex:none">
        <button class="x" onclick="openRestockForm('${r.id}')" aria-label="수정"><i class="ti ti-edit" style="font-size:16px;color:var(--t3)"></i></button>
        <button class="x" onclick="delRestock('${r.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>
      </div></div>`;
  }).join('') : `<div class="empty"><i class="ti ti-calendar-off"></i>예정된 입고가 없습니다</div>`;
  return `<div class="card" style="margin-top:14px">
    <div class="card-h"><h3><i class="ti ti-truck-delivery"></i>예정 입고 (재입고 예정)${list.length ? ` <span style="font-size:12px;font-weight:500;color:var(--t3)">${list.length}건</span>` : ''}</h3><button class="btn btn-sm" onclick="openRestockForm()"><i class="ti ti-plus"></i>예정 등록</button></div>
    <div id="restock-scroll" data-keepscroll style="max-height:300px;overflow-y:auto;-webkit-overflow-scrolling:touch">${rows}</div></div>`;
}

/* ===================================================================
   엑셀 일괄 입고
   =================================================================== */
let _bulkRows = [];
function bulkInOpen() {
  _bulkRows = [];
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-file-spreadsheet"></i>엑셀 일괄 입고</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>엑셀(.xlsx)·CSV로 여러 자재를 한 번에 입고합니다. <b>① 양식 다운로드 → ② 채우기 → ③ 파일 선택 → ④ 미리보기 확인 후 등록.</b><br>열 순서: <b>자재명 · 규격 · 패턴 · 장수 · 롯트 · 입고일 · 발주처 · 메모</b><br><b style="color:var(--gd)">자재명이 같으면 새로 안 만들고 기존 재고에 합산</b>됩니다. <b>장수를 비우면 재고 0인 품목으로만 등록</b>(제품정보만)됩니다. 패턴이 여러 개면 행을 나눠 적으세요.</span></div>
    <div style="display:flex;gap:8px;margin:10px 0">
      <button class="btn" style="flex:1" onclick="bulkInTemplate()"><i class="ti ti-download"></i>빈 양식</button>
      <button class="btn" style="flex:1" onclick="bulkInTemplateStock()"><i class="ti ti-clipboard-list"></i>현재 품목 양식</button>
    </div>
    <label class="btn btn-pri btn-block" style="cursor:pointer;margin-bottom:4px"><i class="ti ti-upload"></i>채운 파일 선택<input type="file" accept=".xlsx,.xls,.csv" onchange="bulkInParse(this)" style="display:none"></label>
    <div id="bulk-preview"></div>`);
}
function bulkInTemplate() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const aoa = [
    ['자재명', '규격', '패턴', '장수', '롯트', '입고일', '발주처', '메모'],
    ['카무스 화이트', '1600*3200*20', 'A패턴', 6, 'LOT-26-0601', todayStr(), '다우세라믹앤석재', ''],
    ['카무스 화이트', '1600*3200*20', 'B패턴', 4, 'LOT-26-0601', todayStr(), '다우세라믹앤석재', '패턴별로 행을 나눠 적으세요']
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '입고');
  XLSX.writeFile(wb, '입고양식.xlsx');
  toast('양식 다운로드 (.xlsx)');
}
/* 현재 등록된 품목을 미리 채운 양식 — 패턴·장수만 적어서 올리면 됨(중복 생성 방지) */
function bulkInTemplateStock() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const header = ['자재명', '규격', '패턴', '장수', '롯트', '입고일', '발주처', '메모'];
  const items = state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!items.length) { toast('등록된 품목이 없습니다 — 빈 양식을 사용하세요'); return; }
  // 각 품목의 과거 패턴(좌상/우상 등)을 미리 채워 고정 — 패턴이 여러 개면 행을 나눠 넣음
  const rows = [];
  items.forEach(i => {
    const pats = patternList(i.name);
    if (pats.length) pats.forEach(p => rows.push([i.name || '', i.spec || '', p.pattern, '', '', todayStr(), i.vendor || '다우세라믹앤석재', '']));
    else rows.push([i.name || '', i.spec || '', '', '', '', todayStr(), i.vendor || '다우세라믹앤석재', '']);
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '입고');
  XLSX.writeFile(wb, '입고양식_현재품목.xlsx');
  toast(`현재 품목 ${items.length}종 양식 다운로드`);
}
function bulkInParse(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      bulkInBuild(rows);
    } catch (err) { toast('파일을 읽지 못했습니다'); }
  };
  reader.readAsArrayBuffer(f);
}
function _bulkPick(r, keys) { for (const k of Object.keys(r)) { if (keys.includes(String(k).trim())) return r[k]; } return ''; }
function _normName(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }
function _bulkDate(v) {
  if (!v) return todayStr();
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const s = String(v).trim().replace(/[.\/]/g, '-').replace(/-+/g, '-');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return todayStr();
}
function bulkInBuild(rows) {
  _bulkRows = rows.map(r => {
    const name = String(_bulkPick(r, ['자재명', '자재', '품명', 'name'])).trim();
    const spec = String(_bulkPick(r, ['규격', 'spec'])).trim();
    const pattern = String(_bulkPick(r, ['패턴', '패턴명', '패턴 명', 'pattern'])).trim();
    const jang = parseFloat(_bulkPick(r, ['장수', '수량', '입고장수', '입고 장수', 'qty'])) || 0;
    const lot = String(_bulkPick(r, ['롯트', '롯트번호', '롯트 번호', 'lot'])).trim();
    const date = _bulkDate(_bulkPick(r, ['입고일', '날짜', 'date']));
    const vendor = String(_bulkPick(r, ['발주처', '매입처', 'vendor'])).trim() || '다우세라믹앤석재';
    const note = String(_bulkPick(r, ['메모', '비고', 'note'])).trim();
    const valid = !!name;
    const exists = !!name && state.inventory.some(i => _normName(i.name) === _normName(name));
    return { name, spec, pattern, jang, lot, date, vendor, note, valid, exists };
  }).filter(r => r.name || r.jang);
  const okCnt = _bulkRows.filter(r => r.valid).length;
  const inCnt = _bulkRows.filter(r => r.valid && r.jang > 0).length;
  const catCnt = okCnt - inCnt;
  el('bulk-preview').innerHTML = `
    <div style="font-size:13px;color:var(--t2);margin:6px 0 8px">총 ${_bulkRows.length}행 · 정상 <b style="color:var(--gd)">${okCnt}</b>건 <span style="color:var(--t3)">(입고 ${inCnt} · 품목등록 ${catCnt})</span>${_bulkRows.length - okCnt ? ` · 오류 <b style="color:var(--red-t)">${_bulkRows.length - okCnt}</b>건` : ''}</div>
    <div class="tbl-wrap" style="max-height:300px;overflow:auto"><table class="tbl"><thead><tr><th>상태</th><th>처리</th><th>자재명</th><th>규격</th><th>패턴</th><th>장수</th><th>롯트</th><th>입고일</th><th>발주처</th></tr></thead><tbody>
    ${_bulkRows.map(r => `<tr><td>${r.valid ? '<span class="pill p-prog">정상</span>' : '<span class="pill p-issue">오류</span>'}</td><td>${!r.valid ? '-' : (r.exists ? (r.jang > 0 ? '<span class="pill p-prog">재고추가</span>' : '<span class="pill p-gray">등록됨</span>') : (r.jang > 0 ? '<span class="pill p-prog">신규+입고</span>' : '<span class="pill p-gray">신규(재고0)</span>'))}</td><td><b>${esc(r.name || '-')}</b></td><td>${esc(r.spec || '-')}</td><td>${esc(r.pattern || '-')}</td><td>${r.jang || 0}장</td><td>${esc(r.lot || '-')}</td><td>${esc(r.date)}</td><td>${esc(r.vendor)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="bulkInSubmit()"><i class="ti ti-check"></i>${okCnt}건 등록</button></div>`;
}
async function bulkInSubmit() {
  const ok = _bulkRows.filter(r => r.valid);
  if (!ok.length) { toast('등록할 행이 없습니다 (자재명 필요)'); return; }
  if (_busy) return; _busy = true;
  try {
    const existById = {}, newByName = {};
    ok.forEach(r => {
      const it = state.inventory.find(i => _normName(i.name) === _normName(r.name));
      if (it) {
        // 기존 품목: 장수>0 일 때만 재고 추가. 장수 없으면 '이미 등록됨'이라 변경 없음.
        if (r.jang > 0) { (existById[it.id] = existById[it.id] || { it, add: 0, date: r.date }).add += r.jang; existById[it.id].date = r.date; }
      } else {
        // 신규 품목: 장수가 없어도 재고 0으로 등록(카탈로그). 장수 있으면 그만큼 초기 재고.
        const key = _normName(r.name);
        const g = (newByName[key] = newByName[key] || { name: r.name, spec: '', add: 0, vendor: r.vendor, date: r.date });
        if (r.spec && !g.spec) g.spec = r.spec;
        g.add += r.jang; g.date = r.date;
      }
    });
    for (const id in existById) { const g = existById[id]; if (g.add > 0) await Store.update('inventory', id, { jang: (+g.it.jang || 0) + g.add, lastInDate: g.date }); }
    for (const nm in newByName) { const g = newByName[nm]; const ps = parseSpec(g.spec); await Store.add('inventory', { name: g.name, spec: g.spec, vendor: g.vendor, depot: '본사', jang: g.add, hebePerJang: ps.hebePerJang, safeJang: 0, lastInDate: g.add > 0 ? g.date : '' }); }
    // 입고 기록은 장수>0 행만
    for (const r of ok) {
      if (!(r.jang > 0)) continue;
      const it = state.inventory.find(i => _normName(i.name) === _normName(r.name));
      const per = it ? (+it.hebePerJang || 0) : (newByName[_normName(r.name)] ? parseSpec(newByName[_normName(r.name)].spec).hebePerJang : 0);
      const hebe = +(r.jang * per).toFixed(2);
      await Store.add('transactions', { type: 'in', itemName: r.name, itemId: it ? it.id : '', spec: r.spec || (it && it.spec) || '', lot: r.lot, patterns: r.pattern ? [{ pattern: r.pattern, jang: r.jang }] : [], jang: r.jang, hebe, vendor: r.vendor, date: r.date, note: r.note, by: me.name });
    }
    // 예정홀딩 자동 전환 (입고분 있는 자재만)
    const affected = {};
    for (const id in existById) { const g = existById[id]; if (g.add > 0) affected[g.it.name] = (+g.it.jang || 0) + g.add; }
    for (const nm in newByName) { const g = newByName[nm]; if (g.add > 0) affected[g.name] = g.add; }
    let convN = 0;
    for (const nm in affected) { await clearRestocksOnIn(nm); convN += await activatePlannedHolds(nm, affected[nm]); }
    const newCnt = Object.keys(newByName).length, inCnt = ok.filter(r => r.jang > 0).length;
    toast(`완료 · 신규품목 ${newCnt}종 · 입고 ${inCnt}건` + (convN ? ` · 예정홀딩 ${convN}건 활성화` : '')); closeModal();
  } finally { _busy = false; }
}

/* ===================================================================
   출고 (현장/공장·거래처) + 월별/분석
   =================================================================== */
/* 출고 건을 shipId 기준으로 묶은 목록 (최신순) */
/* 출고 정렬용 타임스탬프: 등록시각(createdAt) → shipId 내장 시각(S+ms) → 날짜 순 */
function outTs(t) {
  if (t.createdAt) return +t.createdAt;
  if (t.shipId && /^S\d{10,}$/.test(t.shipId)) return +t.shipId.slice(1);
  return t.date ? new Date(t.date + 'T00:00').getTime() : 0;
}
function shipSlipGroups() {
  const outs = state.transactions.filter(t => t.type === 'out');
  const gmap = {}, groups = [];
  outs.forEach(t => { const k = t.shipId || t.id; if (!gmap[k]) { gmap[k] = { key: k, date: t.date, dest: t.dest || t.factory, targetName: t.targetName, by: t.by, items: [], ts: outTs(t) }; groups.push(gmap[k]); } gmap[k].items.push(t); gmap[k].ts = Math.max(gmap[k].ts, outTs(t)); });
  groups.sort((a, b) => b.ts - a.ts);   // 최근 출고가 맨 위로
  return groups;
}
/* 출고증 인쇄 목록: 검색 없으면 최근 10건, 검색하면 업체명·자재명으로 전체에서 찾기 */
function shipSlipListHtml() {
  const q = (filters.slipSearch || '').trim().toLowerCase();
  let groups = shipSlipGroups();
  if (q) groups = groups.filter(g => (g.targetName || '').toLowerCase().includes(q) || (g.dest || '').toLowerCase().includes(q) || g.items.some(t => (t.itemName || '').toLowerCase().includes(q)));
  const list = q ? groups : groups.slice(0, 10);
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>${q ? '검색 결과가 없습니다' : '출고 내역 없음'}</div>`;
  return list.map(g => {
    const totJang = g.items.reduce((a, b) => a + (+b.jang || 0), 0), totHebe = g.items.reduce((a, b) => a + (+b.hebe || 0), 0);
    return `<div class="card" style="margin-bottom:10px;padding:11px 13px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><div style="font-weight:700;font-size:14px"><i class="ti ti-briefcase" style="color:var(--blue);font-size:14px"></i> ${esc(g.targetName || '-')}${(() => { const sc = shipConfirm('out', g.key); return sc && sc.confirmed ? ` <span class="pill" style="background:#e8f7f0;color:#0F6E56;font-size:10px"><i class="ti ti-checks"></i> 확인</span>` : ''; })()}</div>
          <div style="font-size:12px;color:var(--t3);margin-top:2px">${esc(g.date)}${g.dest ? ' · → ' + esc(g.dest) : ''} · ${esc(g.by || '')}</div></div>
        ${isAdmin() ? `<button class="x" onclick="delShipGroup('${g.key}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}
      </div>
      <div style="margin-top:7px;font-size:13px">${g.items.map(t => `<div style="color:var(--t2)">· ${esc(t.itemName)} <b style="color:var(--t1)">${+t.jang || 0}장</b>${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}${t.lot ? ` · 롯트 ${esc(t.lot)}` : ''}${t.pattern ? ` · 패턴 ${esc(t.pattern)}` : ''}</div>`).join('')}</div>
      ${g.items.length > 1 ? `<div style="font-size:11.5px;color:var(--t3);margin-top:6px;text-align:right">합계 ${totJang}장 · ${totHebe.toFixed(1)}㎡</div>` : ''}
      <div style="margin-top:9px;text-align:right"><button class="btn btn-sm" onclick="printShipSlip('${g.key}')"><i class="ti ti-printer"></i>출고증 인쇄</button></div>
    </div>`;
  }).join('');
}
/* 검색어 입력 시 목록만 교체 (한글 입력 끊김 방지) */
function filterShipSlips() {
  filters.slipSearch = el('slip-search') ? el('slip-search').value : '';
  if (el('slip-list')) el('slip-list').innerHTML = shipSlipListHtml();
  const x = el('slip-search-x'); if (x) x.style.display = (filters.slipSearch || '').trim() ? '' : 'none';
}
/* 두께(티) 추출: ① 자재명 "…12T/6티" ② 규격 마지막 치수(예: 1600*3200*12 → 12) / 없으면 '' */
function parseThick(name, spec) {
  const nm = String(name || '').match(/(\d{1,3})\s*(?:T|t|티)(?![a-zA-Z가-힣])/);
  if (nm) return nm[1] + 'T';
  const s = String(spec || '');
  const st = s.match(/(\d{1,3})\s*(?:T|t|티)(?![a-zA-Z가-힣])/);   // 규격에 "12T" 형태
  if (st) return st[1] + 'T';
  const parts = s.split(/[*xX×]/).map(x => (x.match(/\d+/) || [''])[0]).filter(Boolean);   // 규격 W*H*두께
  if (parts.length >= 2) { const last = parseInt(parts[parts.length - 1], 10); if (!isNaN(last) && last > 0 && last <= 50) return last + 'T'; }   // 타일 두께로 볼 만한 값(≤50mm)만
  return '';
}
/* 출고 두께별 장수 집계 (조건: 날짜 predicate). 두께는 명칭·규격에서 파악, 세면대는 별도(개) */
function shipThickAgg(pred) {
  const m = {}; let total = 0;
  (state.transactions || []).forEach(t => {
    if (t.type !== 'out') return; if (!pred(t.date || '')) return; const j = +t.jang || 0; if (j <= 0) return;
    const it = (state.inventory || []).find(i => _normName(i.name) === _normName(t.itemName));
    let spec = t.spec || ''; if (!spec && it) spec = it.spec || '';
    const isBasin = /세면대/.test(t.itemName || '') || (it && itemCat(it) === '세면대');
    const key = isBasin ? '세면대' : (parseThick(t.itemName, spec) || '기타');
    m[key] = (m[key] || 0) + j; total += j;
  });
  return { total, m };
}
function thickChipsHtml(agg) {
  const rank = k => k === '세면대' ? -2 : (k === '기타' ? -3 : (parseInt(k) || 0));   // 두께 큰 순 → 세면대 → 기타
  const keys = Object.keys(agg.m).sort((a, b) => rank(b) - rank(a));
  if (!keys.length) return '<span style="color:var(--t3)">출고 없음</span>';
  return keys.map(k => {
    const unit = k === '세면대' ? '개' : '장';
    const label = k === '세면대' ? '세면대' : (k === '기타' ? '기타' : k.replace('T', '티'));
    const col = k === '세면대' ? 'background:#eef7ee;color:#256b2a' : (k === '기타' ? 'background:#f2f2f0;color:#555' : 'background:#eaf1ff;color:#1b4fb0');
    return `<span style="display:inline-block;${col};border-radius:7px;padding:2px 8px;font-size:12.5px;font-weight:700;margin:2px 4px 2px 0">${esc(label)} <b>${agg.m[k]}</b>${unit}</span>`;
  }).join('');
}
function renderShip() {
  const _shipSY = window.scrollY, _shipTW = el('r-wrap') ? el('r-wrap').scrollTop : 0;   // 재렌더 후 스크롤 위치 유지
  const outs = state.transactions.filter(t => t.type === 'out').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const monthOut = outs.filter(t => (t.date || '').startsWith(ym));
  const monthHebe = monthOut.reduce((a, b) => a + (+b.hebe || 0), 0);
  const _today = todayStr();
  const todayAgg = shipThickAgg(d => d === _today), monthAgg = shipThickAgg(d => d.startsWith(ym));
  const year = now.getFullYear();
  const monthly = Array.from({ length: 12 }, (_, m) => outs.filter(t => (t.date || '').startsWith(year + '-' + String(m + 1).padStart(2, '0'))).reduce((a, b) => a + (+b.hebe || 0), 0));
  const maxM = Math.max(1, ...monthly);
  const selM = filters.shipStatMonth || '';   // 'YYYY-MM' 선택 시 상위 제품·업체를 그 달로 필터, 없으면 전체
  const statSrc = selM ? outs.filter(t => (t.date || '').startsWith(selM)) : outs;
  const selMLabel = selM ? (+selM.slice(5) + '월') : '전체';
  // 상위 제품 (선택 월 기준)
  const byItem = {}; statSrc.forEach(t => { byItem[t.itemName] = (byItem[t.itemName] || 0) + (+t.hebe || 0); });
  const top = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 6); const maxT = Math.max(1, ...top.map(t => t[1]));
  const byClient = {}; statSrc.forEach(t => { const k = t.targetName || '-'; byClient[k] = (byClient[k] || 0) + (+t.hebe || 0); });
  const topC = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 6); const maxC = Math.max(1, ...topC.map(t => t[1]));
  const outClients = [...new Set(outs.map(t => t.targetName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const outMats = [...new Set(outs.map(t => t.itemName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const shipTab = filters.shipTab || 'slip';   // slip=출고증 / list=내역조회 / stats=월별·분석
  const shd = t => shipTab === t ? '' : 'display:none';   // 탭별 표시/숨김

  el('pg-ship').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-truck-delivery"></i>출고 현황</h2><p>현장·공장·거래처 출고 + 월별 분석</p></div>
      <button class="btn btn-pri btn-sm" onclick="openShipForm()"><i class="ti ti-plus"></i>출고 등록</button></div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-h"><h3><i class="ti ti-package-export"></i>출고 현황</h3><span class="more" style="font-size:11.5px;color:var(--t3)">두께(티)별 장수</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div style="background:var(--soft);border-radius:11px;padding:11px 12px">
          <div style="font-size:12px;color:var(--t3);font-weight:600"><i class="ti ti-calendar-event" style="font-size:12px"></i> 오늘 출고</div>
          <div style="font-size:23px;font-weight:800;margin:1px 0 5px">${todayAgg.total}<span style="font-size:13px;font-weight:600;color:var(--t2)">장</span></div>
          <div style="line-height:1.7">${thickChipsHtml(todayAgg)}</div>
        </div>
        <div style="background:var(--soft);border-radius:11px;padding:11px 12px">
          <div style="font-size:12px;color:var(--t3);font-weight:600"><i class="ti ti-calendar-stats" style="font-size:12px"></i> 이번 달 출고 <span style="color:var(--t3);font-weight:400">(${monthOut.length}건)</span></div>
          <div style="font-size:23px;font-weight:800;margin:1px 0 5px">${monthAgg.total}<span style="font-size:13px;font-weight:600;color:var(--t2)">장</span></div>
          <div style="line-height:1.7">${thickChipsHtml(monthAgg)}</div>
        </div>
      </div>
    </div>
    <div class="seg" id="ship-seg" style="margin:2px 0 12px">
      <button type="button" data-t="slip" class="${shipTab === 'slip' ? 'on' : ''}" onclick="goShipTab('slip')"><i class="ti ti-printer" style="font-size:14px"></i> 출고증</button>
      <button type="button" data-t="list" class="${shipTab === 'list' ? 'on' : ''}" onclick="goShipTab('list')"><i class="ti ti-table" style="font-size:14px"></i> 내역 조회</button>
      <button type="button" data-t="stats" class="${shipTab === 'stats' ? 'on' : ''}" onclick="goShipTab('stats')"><i class="ti ti-chart-bar" style="font-size:14px"></i> 월별·분석</button>
    </div>
    <div class="card ship-sec" data-tab="slip" style="${shd('slip')}">
      <div class="card-h"><h3><i class="ti ti-printer"></i>출고증 인쇄</h3></div>
      <div class="search-box" style="margin-bottom:10px">
        <i class="ti ti-search"></i>
        <input id="slip-search" placeholder="업체명·자재명 검색" value="${esc(filters.slipSearch || '')}" oninput="filterShipSlips()" autocomplete="off" lang="ko">
        <button class="search-x" id="slip-search-x" style="${(filters.slipSearch || '').trim() ? '' : 'display:none'}" onclick="el('slip-search').value='';filterShipSlips()"><i class="ti ti-x"></i></button>
      </div>
      <div id="slip-list">${shipSlipListHtml()}</div>
    </div>
    <div class="card ship-sec" data-tab="list" style="${shd('list')}">
      <div class="card-h"><h3><i class="ti ti-table"></i>출고 내역 조회·추출</h3></div>
      <div class="search-box" style="margin-bottom:10px">
        <i class="ti ti-search"></i>
        <input id="r-search" placeholder="자재명·업체명 검색" value="${esc(filters.shipSearch || '')}" oninput="filters.shipSearch=this.value;shipReport()" autocomplete="off">
        ${(filters.shipSearch || '').trim() ? `<button class="search-x" onclick="filters.shipSearch='';el('r-search').value='';shipReport()"><i class="ti ti-x"></i></button>` : ''}
      </div>
      <div class="frm">
        <div class="fld"><label>시작일</label><input type="date" id="r-from" oninput="shipReport()"></div>
        <div class="fld"><label>종료일</label><input type="date" id="r-to" oninput="shipReport()"></div>
        <div class="fld"><label>거래처</label><select id="r-client" onchange="shipReport()"><option value="">전체</option>${outClients.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="fld"><label>자재</label><select id="r-mat" onchange="shipReport()"><option value="">전체</option>${outMats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 8px;gap:8px;flex-wrap:wrap">
        <div style="font-size:13px;color:var(--t2)" id="r-sum">전체 기간</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${isAdmin() ? `<button class="btn btn-sm" onclick="autoLinkSoleLots()"><i class="ti ti-link"></i>미지정 롯트 자동연결</button>` : ''}<button class="btn btn-sm btn-pri" onclick="downloadShipXls()"><i class="ti ti-file-spreadsheet"></i>엑셀 다운로드</button></div>
      </div>
      <div id="r-daily" style="margin-bottom:10px"></div>
      <div class="tbl-wrap" id="r-wrap" data-keepscroll style="max-height:340px;overflow:auto">
        <table class="tbl"><thead><tr><th>날짜</th><th>거래처</th><th>자재</th><th>장수</th><th>헤베</th><th>출고지</th></tr></thead><tbody id="r-body"></tbody></table>
      </div>
    </div>
    <div class="card ship-sec" data-tab="stats" style="${shd('stats')}">
      <div class="card-h"><h3><i class="ti ti-chart-bar"></i>월별 출고 현황</h3><span class="more" style="font-size:11.5px;color:var(--t3)">${year}년 · 월 클릭 시 아래 분석 필터${selM ? ` <a onclick="filters.shipStatMonth='';renderShip()" style="color:#2f6fed;cursor:pointer">전체보기</a>` : ''}</span></div>
      <div class="mchart">${monthly.map((v, i) => { const mk = year + '-' + String(i + 1).padStart(2, '0'); const on = selM === mk; return `<div class="mcol" onclick="shipPickStatMonth(${i})" style="cursor:pointer"><div class="val">${v ? v.toFixed(0) : ''}</div><div class="bb ${i === now.getMonth() ? 'cur' : ''}" style="height:${Math.max(2, v / maxM * 100)}%;${on ? 'background:#2f6fed;box-shadow:0 0 0 2px #2f6fed inset' : ''}"></div><div class="lb" style="${on ? 'color:#2f6fed;font-weight:800' : ''}">${i + 1}월</div></div>`; }).join('')}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="btn btn-sm" onclick="downloadMonthlyChart()"><i class="ti ti-photo"></i> 그래프 이미지</button>
        <button class="btn btn-sm btn-pri" onclick="downloadMonthlyXls()"><i class="ti ti-file-spreadsheet"></i> 엑셀 다운로드</button>
      </div>
    </div>
    <div class="card ship-sec" data-tab="stats" style="${shd('stats')}">
      <div class="card-h"><h3><i class="ti ti-trophy"></i>출고 상위 제품 <span style="font-size:11.5px;font-weight:600;color:${selM ? '#2f6fed' : 'var(--t3)'}">· ${selMLabel}</span></h3>${top.length ? `<span class="more tap" onclick="openTopProducts()" style="cursor:pointer">더보기 <i class="ti ti-chevron-right"></i></span>` : ''}</div>
      ${top.length ? top.map(([nm, v], i) => `<div class="abar"><span class="rk">${i + 1}</span><span class="nm">${esc(nm)}</span><span class="tr"><i style="width:${v / maxT * 100}%"></i></span><span class="vv">${v.toFixed(0)}㎡</span></div>`).join('') : `<div class="empty"><i class="ti ti-chart-dots"></i>출고 데이터가 쌓이면 표시됩니다</div>`}
    </div>
    ${isAdmin() ? `<div class="card ship-sec" data-tab="stats" style="${shd('stats')}">
      <div class="card-h"><h3><i class="ti ti-building-store"></i>거래량 많은 업체 <span style="font-size:11.5px;font-weight:600;color:${selM ? '#2f6fed' : 'var(--t3)'}">· ${selMLabel}</span> <span style="font-size:11px;font-weight:500;color:var(--t3)">(관리자)</span></h3>${topC.length ? `<span class="more tap" onclick="openTopClients()" style="cursor:pointer">더보기 <i class="ti ti-chevron-right"></i></span>` : ''}</div>
      ${topC.length ? topC.map(([nm, v], i) => `<div class="abar"><span class="rk">${i + 1}</span><span class="nm">${esc(nm)}</span><span class="tr"><i style="width:${v / maxC * 100}%"></i></span><span class="vv">${v.toFixed(0)}㎡</span></div>`).join('') : `<div class="empty"><i class="ti ti-chart-dots"></i>출고 데이터가 쌓이면 표시됩니다</div>`}
    </div>` : ''}
    `;
  shipReport();
  requestAnimationFrame(() => { window.scrollTo(0, _shipSY); if (el('r-wrap')) el('r-wrap').scrollTop = _shipTW; });   // 저장 후 자리 유지
}
function shipPickStatMonth(mIdx) { const key = new Date().getFullYear() + '-' + String(mIdx + 1).padStart(2, '0'); filters.shipStatMonth = (filters.shipStatMonth === key ? '' : key); renderShip(); }
function _shipStatOuts() { const sel = filters.shipStatMonth || ''; return state.transactions.filter(t => t.type === 'out' && (!sel || (t.date || '').startsWith(sel))); }
function shipStatLabel() { const sel = filters.shipStatMonth || ''; return sel ? (+sel.slice(0, 4) + '년 ' + (+sel.slice(5)) + '월') : '전체 기간'; }
/* 출고 상위 제품 집계 (규격·건수·장수·헤베) — 헤베 기준 정렬 (선택 월 반영) */
function shipTopProducts() {
  const m = {};
  _shipStatOuts().forEach(t => {
    const k = t.itemName || '-';
    if (!m[k]) m[k] = { name: k, spec: t.spec || '', jang: 0, hebe: 0, cnt: 0 };
    m[k].jang += (+t.jang || 0); m[k].hebe += (+t.hebe || 0); m[k].cnt++;
    if (!m[k].spec && t.spec) m[k].spec = t.spec;
  });
  Object.values(m).forEach(x => { if (!x.spec) { const it = state.inventory.find(i => _normName(i.name) === _normName(x.name)); if (it) x.spec = it.spec || ''; } });
  return Object.values(m).sort((a, b) => b.hebe - a.hebe);
}
/* 출고 상위 업체 집계 (건수·장수·헤베) — 헤베 기준 정렬 (선택 월 반영) */
function shipTopClients() {
  const m = {};
  _shipStatOuts().forEach(t => {
    const k = t.targetName || '-';
    if (!m[k]) m[k] = { name: k, jang: 0, hebe: 0, cnt: 0 };
    m[k].jang += (+t.jang || 0); m[k].hebe += (+t.hebe || 0); m[k].cnt++;
  });
  return Object.values(m).sort((a, b) => b.hebe - a.hebe);
}
function openTopProducts() {
  const list = shipTopProducts();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-trophy"></i>출고 상위 제품 전체</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:8px">${shipStatLabel()} · 총 ${list.length}개 품목 · 헤베 기준 정렬</div>
    <div class="tbl-wrap" style="max-height:62vh;overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>자재</th><th>규격</th><th>건수</th><th>장수</th><th>헤베</th></tr></thead><tbody>
    ${list.length ? list.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.name)}</b></td><td style="font-size:11px;color:var(--t3);white-space:nowrap">${esc(x.spec || '-')}</td><td>${x.cnt}</td><td>${x.jang}장</td><td><b style="color:var(--gd)">${x.hebe.toFixed(1)}㎡</b></td></tr>`).join('') : `<tr><td colspan="6"><div class="empty" style="padding:16px">출고 내역이 없습니다</div></td></tr>`}
    </tbody></table></div>
    <div class="frm-foot"><button class="btn btn-pri" style="flex:1" onclick="closeModal()">닫기</button></div>`);
}
function openTopClients() {
  if (!isAdmin()) { toast('관리자만 볼 수 있습니다'); return; }
  const list = shipTopClients();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-store"></i>거래량 많은 업체 순위</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:8px">${shipStatLabel()} · 총 ${list.length}개 업체 · 헤베 기준 정렬</div>
    <div class="tbl-wrap" style="max-height:62vh;overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>거래처</th><th>건수</th><th>장수</th><th>헤베</th></tr></thead><tbody>
    ${list.length ? list.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.name)}</b></td><td>${x.cnt}</td><td>${x.jang}장</td><td><b style="color:var(--gd)">${x.hebe.toFixed(1)}㎡</b></td></tr>`).join('') : `<tr><td colspan="5"><div class="empty" style="padding:16px">출고 내역이 없습니다</div></td></tr>`}
    </tbody></table></div>
    <div class="frm-foot"><button class="btn btn-pri" style="flex:1" onclick="closeModal()">닫기</button></div>`);
}
/* ===================================================================
   견적서 — 품목 기본단가 + 거래처별 단가 자동입력, 공급가+VAT10%, 저장·목록·A4·엑셀
   =================================================================== */
function fmtWon(n) { return Math.round(+n || 0).toLocaleString('ko-KR'); }
function _numv(v) { return parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0; }
/* 거래처 유형(유통/인테리어/소비자) — 거래처 문서 ctype, 기본 소비자 */
function clientType(name) { const c = (state.clients || []).find(x => _normName(x.value) === _normName(name)); return (c && c.ctype) || '소비자'; }
/* 견적 비고 기본 양식 */
function quoteMemoTemplate() { const m = (state.appmeta || []).find(x => x.key === 'quoteMemo'); return m ? (m.text || '') : ''; }
/* 단가 조회: ① 거래처 개별단가(override) ② 유형별 단가표 ③ 품목 price */
function quoteGetPrice(client, name, typeOverride) {
  const cn = _normName(client || ''), nm = _normName(name || ''); const cps = state.clientPrices || [];
  if (client && client.trim()) { const hit = cps.find(p => (p.client || '').trim() && _normName(p.client) === cn && _normName(p.itemName) === nm); if (hit) return +hit.price || 0; }
  const type = typeOverride || clientType(client); const pl = (state.priceList || []).find(p => _normName(p.itemName) === nm);
  if (pl) { const v = +pl[ctypeKey(type)] || 0; if (v) return v; }
  const it = (state.inventory || []).find(i => _normName(i.name) === nm); return it ? (+it.price || 0) : 0;
}
function quoteNextDocNo() { const d = todayStr().replace(/-/g, ''); const n = (state.quotes || []).filter(q => (q.docNo || '').startsWith('Q' + d)).length; return 'Q' + d + '-' + (n + 1); }
let _qN = 0;
function qRowHtml(d) {
  d = d || {}; const i = _qN++; const inp = 'font-size:14px;padding:8px;border:1.5px solid var(--bd2);border-radius:8px'; const _isBasin = (d.name || '').includes('세면대');
  return `<div class="q-row" style="border:1px solid var(--bd2);border-radius:10px;padding:8px 9px;margin-bottom:8px">
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <input class="q-mat" list="q-mat-list" lang="ko" placeholder="자재명 (선택/입력)" value="${esc(d.name || '')}" onchange="quoteMatPick(this)" style="flex:2.4;min-width:0;${inp}">
      <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.q-row').remove();quoteRecalc()" aria-label="삭제"><i class="ti ti-x"></i></button>
    </div>
    <div class="q-stone-wrap" style="margin-bottom:6px;display:${_isBasin ? 'block' : 'none'}"><select class="q-stone" style="width:100%;font-size:14px;padding:8px;border:1.5px solid var(--bd2);border-radius:8px;background:#fff"><option value="">— 석종(컬러) 선택 · 세면대 발주에 적용 —</option>${BASIN_STONES.map(st => `<option value="${esc(st.k)}" ${d.stone === st.k ? 'selected' : ''}>${esc(st.k)}${st.t ? ' · ' + st.t : ''}</option>`).join('')}</select></div>
    <div style="display:flex;gap:6px;align-items:center">
      <input class="q-spec" lang="en" placeholder="규격" value="${esc(d.spec || '')}" style="flex:1.7;min-width:0;${inp}">
      <input class="q-qty" inputmode="numeric" placeholder="수량" value="${esc(d.qty || '')}" oninput="quoteRecalc()" style="flex:1;min-width:44px;${inp};text-align:right">
      <input class="q-price" inputmode="numeric" placeholder="단가" value="${esc(d.price || '')}" oninput="quoteRecalc()" style="flex:1.3;min-width:56px;${inp};text-align:right">
      <div class="q-amt" style="flex:1.4;min-width:62px;text-align:right;font-weight:700;padding:8px 2px;color:var(--t1);font-size:14px">0</div>
    </div>
  </div>`;
}
function quoteMatPick(inp) {
  const row = inp.closest('.q-row'); if (!row) return; const name = (inp.value || '').trim();
  const it = (state.inventory || []).find(x => _normName(x.name) === _normName(name));
  const pl = (state.priceList || []).find(x => _normName(x.itemName) === _normName(name));
  const specEl = row.querySelector('.q-spec'); if (specEl && !specEl.value.trim()) specEl.value = (it && it.spec) || (pl && pl.spec) || '';
  const client = (el('q-client') && el('q-client').value || '').trim();
  const type = el('q-ctype') ? el('q-ctype').value : '';
  const priceEl = row.querySelector('.q-price'); const p = quoteGetPrice(client, name, type); if (p && !_numv(priceEl.value)) priceEl.value = p;
  const wrap = row.querySelector('.q-stone-wrap'); if (wrap) wrap.style.display = name.includes('세면대') ? 'block' : 'none';
  quoteRecalc();
}
function quoteClientChanged() {
  const client = (el('q-client') && el('q-client').value || '').trim();
  const cs = el('q-ctype'); if (cs) cs.value = clientType(client);
  quoteRefillPrices();
  quoteExtraRefresh();
}
function quoteTypeChanged() { quoteRefillPrices(); quoteExtraRefresh(); }
function quoteRefillPrices() {
  const client = (el('q-client') && el('q-client').value || '').trim();
  const type = el('q-ctype') ? el('q-ctype').value : '';
  document.querySelectorAll('#q-rows .q-row').forEach(r => { const name = (r.querySelector('.q-mat').value || '').trim(); if (!name) return; const p = quoteGetPrice(client, name, type); if (p) r.querySelector('.q-price').value = p; });
  quoteRecalc();
}
let _qRawTotal = 0;
function quoteRecalc() {
  let supply = 0;
  document.querySelectorAll('#q-rows .q-row').forEach(r => { const qty = _numv(r.querySelector('.q-qty').value); const price = _numv(r.querySelector('.q-price').value); const amt = Math.round(qty * price); r.querySelector('.q-amt').textContent = fmtWon(amt); supply += amt; });
  document.querySelectorAll('.qx-row').forEach(r => { const qty = _numv(r.querySelector('.qx-qty').value); const price = _numv(r.querySelector('.qx-price').value); const amt = Math.round(qty * price); r.querySelector('.qx-amt').textContent = fmtWon(amt); supply += amt; });
  const noteEl = el('q-basin-note');
  if (noteEl) {
    let basin = false;
    document.querySelectorAll('#q-rows .q-row').forEach(r => { if ((r.querySelector('.q-mat').value || '').includes('세면대')) basin = true; });
    document.querySelectorAll('.qx-row').forEach(r => { if ((r.getAttribute('data-name') || '').includes('세면대') && _numv(r.querySelector('.qx-qty').value) > 0) basin = true; });
    noteEl.style.display = basin ? 'block' : 'none';
  }
  const vat = Math.round(supply * 0.1); const raw = supply + vat; _qRawTotal = raw;
  const dc = el('q-dc') ? _numv(el('q-dc').value) : 0;
  const total = raw - dc;
  if (el('q-supply')) el('q-supply').textContent = fmtWon(supply);
  if (el('q-vat')) el('q-vat').textContent = fmtWon(vat);
  if (el('q-dcshow')) el('q-dcshow').textContent = dc > 0 ? ('-' + fmtWon(dc)) : '0';
  if (el('q-total')) el('q-total').textContent = fmtWon(total);
}
function quoteTruncate(place) {
  const rem = (_qRawTotal || 0) % place;
  if (el('q-dc')) el('q-dc').value = rem;
  quoteRecalc();
  const unit = place === 1000 ? '천원' : place === 10000 ? '만원' : place === 100000 ? '십만원' : place === 1000000 ? '백만원' : (fmtWon(place) + '원');
  toast(unit + ' 단위 내림 · 할인 ' + fmtWon(rem) + '원 → 합계 ' + fmtWon((_qRawTotal || 0) - rem) + '원');
}
function quoteDcClear() { if (el('q-dc')) el('q-dc').value = ''; quoteRecalc(); }
function addQRow() { const c = el('q-rows'); if (c) { c.insertAdjacentHTML('beforeend', qRowHtml({})); } }
function openQuoteInline(id, copy) { filters.quoteEdit = id || 'new'; filters.quoteCopy = !!copy; filters.quoteCat = ''; renderQuote(); if (el('pg-quote')) el('pg-quote').scrollIntoView({ block: 'start' }); }
function quoteCancel() { filters.quoteEdit = ''; filters.quoteCopy = false; filters.quoteCat = ''; renderQuote(); }
/* 부대비용·가공 프리셋 (견적 폼에 항상 표시, 수량 입력한 것만 견적서 반영) */
const CONSUMER_GAGONG = [{ name: '가공비 12T (장당)', unit: '장' }, { name: '가공비 6T (장당)', unit: '장' }];   // 소비자 유형 가공비
const QUOTE_EXTRAS = [
  { name: '재단비 12T', unit: 'M' }, { name: '재단비 6T', unit: 'M' },
  { name: '북매치 재단', unit: 'M' }, { name: '워터젯', unit: 'M' },
  { name: '사선 재단', unit: 'EA' }, { name: '고스라', unit: 'M' },
  { name: '뒷도메', unit: 'M' }, { name: '배면 연마', unit: 'M' },
  { name: '모서리 가공', unit: 'EA' },
  { name: '인덕션 타공', unit: 'EA' }, { name: '싱크볼 타공', unit: 'EA' },
  { name: '콘센트 타공', unit: 'EA' }, { name: '수전 타공', unit: 'EA' }, { name: '사각 타공', unit: 'EA' },
  { name: '운송비 (창고-공장)', unit: '회' }, { name: '운송비 (공장-현장)', unit: '회' },
  { name: '실측비', unit: '회' }, { name: '시공비', unit: '식' }
];
/* 세면대 주문제작 견적 특이사항 (세면대 항목 포함 시 견적서에 강조 표기) */
const BASIN_NOTICE = [
  '발주 후 수정 불가',
  '주문 제작 건은 납기까지 30~33일 정도 소요됩니다.',
  '세면대 발주 1개 당 브라켓 1SET 포함되어 있으며, 이외 부속품은 별도 구매입니다. (별도 : 폽업, 수전, 트랩 등)',
  '시공비, 운송비는 별도입니다.',
  '조적벽 및 가벽에는 각관 하지를 짜놓으셔야 합니다. (동봉된 브라켓은 콘크리트 벽 설치용입니다.)',
  '제작 방식 상 모든 세면대가 완벽히 동일한 컬러로 나올 수 없으며 (굽는 시간에 따라 색상에 다소 차이가 있음)',
  '내부 볼의 깊이는 150MM 기준 +- 30MM의 오차가 발생할 수 있습니다.'
];
function hasBasinItems(items) { return (items || []).some(it => (it.name || '').includes('세면대')); }
function extraPrices() { const m = (state.appmeta || []).find(x => x.key === 'extraPrices'); return (m && m.prices) || {}; }
async function saveExtraPrices(prices) { const m = (state.appmeta || []).find(x => x.key === 'extraPrices'); if (m) await Store.update('appmeta', m.id, { prices }); else await Store.add('appmeta', { key: 'extraPrices', prices }); }
function extraItemsList() {
  const dmap = {}; QUOTE_EXTRAS.forEach(x => dmap[x.name] = x.unit);
  const m = (state.appmeta || []).find(x => x.key === 'extraItems'); const arr = (m && Array.isArray(m.items)) ? m.items : null;
  if (!arr || !arr.length) return QUOTE_EXTRAS.map(x => ({ name: x.name, unit: x.unit }));
  return arr.map(x => { const nm = (typeof x === 'string') ? x : (x.name || ''); const un = (typeof x === 'object' && x.unit) ? x.unit : (dmap[nm] || ''); return { name: nm, unit: un }; });
}
async function saveExtraItems(items) { const m = (state.appmeta || []).find(x => x.key === 'extraItems'); if (m) await Store.update('appmeta', m.id, { items }); else await Store.add('appmeta', { key: 'extraItems', items }); }
async function saveExtraPrice(name, val) { const p = Object.assign({}, extraPrices()); const v = _numv(val); if (v > 0) p[name] = v; else delete p[name]; await saveExtraPrices(p); toast('단가 저장됨'); }
async function setExtraUnit(name, unit) { const list = extraItemsList().map(x => x.name === name ? { name: x.name, unit: (unit || '').trim() } : x); await saveExtraItems(list); }
async function addExtraItem() { const nmEl = el('qe-new'); const unEl = el('qe-unit'); const nm = (nmEl && nmEl.value || '').trim(); const un = (unEl && unEl.value || '').trim(); if (!nm) return; const list = extraItemsList().slice(); if (list.some(x => _normName(x.name) === _normName(nm))) { toast('이미 있는 항목입니다'); return; } list.push({ name: nm, unit: un }); await saveExtraItems(list); if (nmEl) nmEl.value = ''; if (unEl) unEl.value = ''; toast('항목 추가됨'); setTimeout(() => { if (filters.quoteSettings) renderQuoteSettings(); }, 300); }
async function delExtraItem(name) { if (!confirm(name + ' 항목을 삭제할까요?')) return; const list = extraItemsList().filter(x => _normName(x.name) !== _normName(name)); await saveExtraItems(list); const p = Object.assign({}, extraPrices()); delete p[name]; await saveExtraPrices(p); toast('삭제됨'); setTimeout(() => { if (filters.quoteSettings) renderQuoteSettings(); }, 300); }
async function moveExtraItem(name, dir) { const list = extraItemsList().slice(); const i = list.findIndex(x => _normName(x.name) === _normName(name)); if (i < 0) return; const j = i + dir; if (j < 0 || j >= list.length) return; const t = list[i]; list[i] = list[j]; list[j] = t; await saveExtraItems(list); setTimeout(() => { if (filters.quoteSettings) renderQuoteSettings(); }, 250); }
function _qsExtraRowsHtml() {
  const prices = extraPrices(); const pin = 'width:100px;font-size:13px;padding:7px 8px;border:1.5px solid var(--bd2);border-radius:8px;text-align:right'; const uin = 'width:52px;font-size:13px;padding:7px 6px;border:1.5px solid var(--bd2);border-radius:8px;text-align:center';
  const list = extraItemsList();
  return list.map((it, idx) => { const nm = it.name; const e = esc(nm).replace(/'/g, "\\'");
    return `<div class="mem" style="display:flex;align-items:center;gap:6px">
      <span style="display:flex;flex-direction:column;gap:1px">
        <i class="ti ti-chevron-up" onclick="moveExtraItem('${e}',-1)" title="위로" style="cursor:${idx === 0 ? 'default' : 'pointer'};color:${idx === 0 ? 'var(--bd2)' : 'var(--t2)'};font-size:14px"></i>
        <i class="ti ti-chevron-down" onclick="moveExtraItem('${e}',1)" title="아래로" style="cursor:${idx === list.length - 1 ? 'default' : 'pointer'};color:${idx === list.length - 1 ? 'var(--bd2)' : 'var(--t2)'};font-size:14px"></i>
      </span>
      <div class="info" style="flex:1;min-width:0"><div class="nm">${esc(nm)}</div></div>
      <input class="qe-unit" inputmode="text" placeholder="단위" value="${esc(it.unit || '')}" onchange="setExtraUnit('${e}',this.value)" style="${uin}">
      <input class="qe-price" inputmode="numeric" placeholder="단가" value="${esc(prices[nm] || '')}" onchange="saveExtraPrice('${e}',this.value)" style="${pin}">
      <i class="ti ti-trash" onclick="delExtraItem('${e}')" title="항목 삭제" style="color:#c0341d;cursor:pointer;font-size:16px"></i></div>`; }).join('')
    + `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--bd)"><div style="font-size:11px;color:#a2560f;margin-bottom:5px;font-weight:700">소비자 유형 가공비 (장당) · 소비자 견적서에만 자동 표시</div>` + CONSUMER_GAGONG.map(it => { const nm = it.name; const e = esc(nm).replace(/'/g, "\\'"); return `<div class="mem" style="display:flex;align-items:center;gap:6px"><div class="info" style="flex:1;min-width:0"><div class="nm">${esc(nm)}</div></div><input inputmode="numeric" placeholder="장당 단가" value="${esc(prices[nm] || '')}" onchange="saveExtraPrice('${e}',this.value)" style="${pin}"></div>`; }).join('') + `</div>`;
}
function qxRowHtml(item, d) {
  const name = item.name; const unit = item.unit || '';
  const inp = 'font-size:14px;padding:7px 8px;border:1.5px solid var(--bd2);border-radius:8px';
  const price = (d && d.price != null && d.price !== '') ? d.price : (extraPrices()[name] || '');
  const qty = (d && d.qty != null) ? d.qty : '';
  return `<div class="qx-row" data-name="${esc(name)}" data-unit="${esc(unit)}" style="display:flex;gap:6px;align-items:center;margin-bottom:5px">
    <div style="flex:2.2;min-width:0;font-size:13.5px">${esc(name)}</div>
    <input class="qx-qty" inputmode="numeric" placeholder="0" value="${esc(qty)}" oninput="quoteRecalc()" style="flex:1;min-width:42px;${inp};text-align:right">
    <div style="width:24px;font-size:11.5px;color:var(--t3);text-align:center">${esc(unit)}</div>
    <input class="qx-price" inputmode="numeric" placeholder="단가" value="${esc(price)}" oninput="quoteRecalc()" style="flex:1.3;min-width:54px;${inp};text-align:right">
    <div class="qx-amt" style="flex:1.3;min-width:58px;text-align:right;font-weight:700;font-size:14px">0</div>
  </div>`;
}
function extraItemsFor(ctype) {
  const base = extraItemsList();
  if ((ctype || '') === '소비자') { const nonG = base.filter(it => marginCat(it.name) !== '가공'); return CONSUMER_GAGONG.concat(nonG); }
  return base;
}
function collectQxValues() { const m = {}; document.querySelectorAll('.qx-row').forEach(r => { const nm = r.getAttribute('data-name'); m[nm] = { qty: r.querySelector('.qx-qty').value, price: r.querySelector('.qx-price').value }; }); return m; }
function quoteExtraRefresh() {
  const box = el('qx-rows-box'); if (!box) return;
  const ctype = el('q-ctype') ? el('q-ctype').value : '소비자';
  const saved = collectQxValues();
  box.innerHTML = extraItemsFor(ctype).map(it => qxRowHtml(it, saved[it.name])).join('');
  quoteRecalc();
}
async function quoteAddExtraRow() {
  const box = el('qx-rows-box'); if (!box) return;
  const nm = (el('qx-newname') && el('qx-newname').value || '').trim();
  if (!nm) { toast('항목명을 입력하세요'); return; }
  const un = (el('qx-newunit') && el('qx-newunit').value || '').trim();
  const pr = (el('qx-newprice') && el('qx-newprice').value || '').trim();
  if (Array.from(box.querySelectorAll('.qx-row')).some(r => _normName(r.getAttribute('data-name')) === _normName(nm))) { toast('이미 있는 항목입니다'); return; }
  box.insertAdjacentHTML('beforeend', qxRowHtml({ name: nm, unit: un }, { price: pr, qty: '' }));
  if (el('qx-newname')) el('qx-newname').value = '';
  if (el('qx-newunit')) el('qx-newunit').value = '';
  if (el('qx-newprice')) el('qx-newprice').value = '';
  quoteRecalc(); toast('항목 추가됨 · 수량 입력 시 견적서에 표시');
  try { const list = extraItemsList().slice(); if (!list.some(x => _normName(x.name) === _normName(nm))) { list.push({ name: nm, unit: un }); await saveExtraItems(list); if (_numv(pr) > 0) await saveExtraPrices(Object.assign({}, extraPrices(), { [nm]: _numv(pr) })); } } catch (e) { }
}
function renderQuoteForm() {
  const id = filters.quoteEdit === 'new' ? '' : filters.quoteEdit;
  const copy = !!filters.quoteCopy;
  const q = id ? (state.quotes || []).find(x => x.id === id) : null; const v = q || {};
  _qN = 0;
  const extraSet = new Set(extraItemsList().map(x => x.name)); const savedExtra = {};
  (v.items || []).forEach(it => { if (extraSet.has(it.name)) savedExtra[it.name] = { qty: it.qty, price: it.price }; });
  const matItems = (v.items || []).filter(it => !extraSet.has(it.name));
  const rows = (matItems.length ? matItems : [{}]).map(qRowHtml).join('');
  const editing0 = q && !copy;
  const _formCat = filters.quoteCat || (editing0 && v.category) || '세라믹+세면대';
  if (_formCat === '통관비용') { renderCustomsForm(q, copy); return; }
  const matOpts = quotePriceItems().map(i => `<option value="${esc(i.name)}">`).join('');   // 재고 + 단가표 통합
  const editing = q && !copy;
  el('pg-quote').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-file-invoice"></i>${editing ? '견적 수정' : (copy ? '견적 복사' : '견적 작성')}</h2><p>거래처·품목을 입력하면 합계가 자동 계산됩니다</p></div>
      <button class="btn btn-sm" onclick="quoteCancel()"><i class="ti ti-arrow-left"></i> 목록</button></div>
    <div id="qform-root" class="card" style="padding:15px 17px">
      <div class="frm" style="display:block">
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <div class="fld" style="flex:2;min-width:180px;margin:0"><label>거래처 <span class="req">*</span></label>${searchBox('q-client', '업체명 검색·입력', v.client || '', 'companyNames', 'quoteClientChanged')}</div>
          <div class="fld" style="flex:1;min-width:130px;margin:0"><label>단가 유형</label><select id="q-ctype" onchange="quoteTypeChanged()" style="width:100%;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px">${CTYPES.map(t => `<option ${((editing && v.ctype) || clientType(v.client || '')) === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="fld" style="flex:1;min-width:130px;margin:0"><label>분류</label><select id="q-cat" onchange="quoteCatChanged(this.value)" style="width:100%;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px">${QCATS.map(cc => `<option ${((editing && v.category) || '세라믹+세면대') === cc ? 'selected' : ''}>${cc}</option>`).join('')}</select></div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <div class="fld" style="flex:1;min-width:150px;margin:0"><label>견적일</label><input type="date" id="q-date" value="${esc((editing && v.date) || todayStr())}"></div>
          <div class="fld" style="flex:1;min-width:150px;margin:0"><label>유효기간</label><input id="q-valid" lang="ko" value="${esc(v.valid || '견적일로부터 15일')}"></div>
          <div class="fld" style="flex:1;min-width:130px;margin:0"><label>담당자</label><input id="q-staff" lang="ko" placeholder="담당자명" value="${esc(editing ? (v.by || '') : ((me && me.name) || ''))}"></div>
        </div>
        <div class="fld full" style="margin-bottom:10px"><label>수신·참조 <span style="color:var(--t3);font-weight:500">(담당자·현장 등, 선택)</span></label><input id="q-attn" lang="ko" placeholder="예: 홍길동 과장 / OO현장" value="${esc(v.attn || '')}"></div>
        <div class="fld full" style="margin-bottom:10px;background:var(--soft);border-radius:10px;padding:9px 12px"><label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;margin:0"><input type="checkbox" id="q-userep" ${editing && v.useSalesRep ? 'checked' : ''} style="width:18px;height:18px"> 영업담당자로 표기 <span style="font-weight:400;color:var(--t3);font-size:12px">(견적 담당자 대신 거래처 영업담당자 이름·연락처 표시)</span></label></div>
        <div class="fld full" style="margin-bottom:10px"><label>현장 주소 <span style="color:var(--t3);font-weight:500">(선택 · 견적서 수신란에 표시)</span></label><input id="q-site" lang="ko" placeholder="예: OO시 OO구 OO동 OO현장" value="${esc(v.siteAddr || '')}"></div>
        <div class="fld full" style="margin-bottom:10px"><label>견적 품목 <span class="req">*</span> <span style="color:var(--t3);font-weight:500">(자재 선택 시 규격·단가 자동 · 단가 수정 가능)</span></label>
          <div id="q-rows">${rows}</div>
          <datalist id="q-mat-list">${matOpts}</datalist>
          <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addQRow()"><i class="ti ti-plus"></i>품목 추가</button>
        </div>
        <div class="fld full" style="margin-bottom:10px"><label>부대비용 · 가공 <span style="color:var(--t3);font-weight:500">(수량 입력한 항목만 견적서에 표시됩니다)</span></label>
          <div style="border:1px solid var(--bd2);border-radius:10px;padding:9px 11px">
            <div style="display:flex;gap:6px;font-size:11px;color:var(--t3);margin-bottom:5px;font-weight:600"><div style="flex:2.2">항목</div><div style="flex:1;text-align:right">수량</div><div style="width:24px;text-align:center">단위</div><div style="flex:1.3;text-align:right">단가</div><div style="flex:1.3;text-align:right">금액</div></div>
            <div id="qx-rows-box">${extraItemsFor((editing && v.ctype) || clientType(v.client || '') || '소비자').map(it => qxRowHtml(it, savedExtra[it.name])).join('')}</div>
            <div style="display:flex;gap:5px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed var(--bd)">
              <input id="qx-newname" lang="ko" placeholder="가공·부대 항목 직접 추가 (예: 모서리 R가공)" autocomplete="off" style="flex:2.2;min-width:0;font-size:13px;padding:7px 8px;border:1.5px solid var(--bd2);border-radius:8px">
              <input id="qx-newunit" placeholder="단위" autocomplete="off" style="width:44px;font-size:13px;padding:7px 5px;border:1.5px solid var(--bd2);border-radius:8px;text-align:center">
              <input id="qx-newprice" inputmode="numeric" placeholder="단가" autocomplete="off" style="width:74px;font-size:13px;padding:7px 7px;border:1.5px solid var(--bd2);border-radius:8px;text-align:right">
              <button type="button" class="btn btn-sm btn-pri" style="flex:none" onclick="quoteAddExtraRow()"><i class="ti ti-plus"></i>추가</button>
            </div>
          </div>
        </div>
        <div id="q-basin-note" style="display:none;margin-bottom:10px;border:2px solid #c0341d;border-radius:10px;background:#fff5f5;padding:10px 12px">
          <div style="font-weight:800;color:#c0341d;font-size:13px;margin-bottom:5px">⚠ 세면대 주문제작 특이사항 — 견적서에 자동으로 강조 표기됩니다</div>
          <ul style="margin:0;padding-left:20px;font-size:12px;line-height:1.65;color:#8a1c10">${BASIN_NOTICE.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
        </div>
        <div class="fld full" style="margin-bottom:10px"><label>비고 <span style="color:var(--t3);font-weight:500">(기본 양식은 견적 설정에서 관리)</span></label><textarea id="q-memo" lang="ko" placeholder="결제조건·납기 등" style="min-height:64px">${esc(editing ? (v.memo || '') : (v.memo || quoteMemoTemplate()))}</textarea></div>
        <div style="background:var(--soft);border-radius:11px;padding:12px 14px;max-width:360px;margin-left:auto">
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:5px"><span style="color:var(--t2)">공급가액</span><b id="q-supply">0</b></div>
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span style="color:var(--t2)">부가세 (10%)</span><b id="q-vat">0</b></div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:14px;margin-bottom:6px"><span style="color:var(--t2)">할인 (D/C)</span><input id="q-dc" inputmode="numeric" value="${esc(editing ? (v.discount || '') : '')}" oninput="quoteRecalc()" placeholder="0" style="width:130px;text-align:right;font-size:14px;padding:6px 9px;border:1.5px solid var(--bd2);border-radius:8px;color:#c0341d;font-weight:700"></div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;justify-content:flex-end;align-items:center">
            <span style="font-size:10.5px;color:var(--t3);margin-right:auto">합계 내림(절사)</span>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11.5px" onclick="quoteTruncate(1000)">천원</button>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11.5px" onclick="quoteTruncate(10000)">만원</button>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11.5px" onclick="quoteTruncate(100000)">십만원</button>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11.5px" onclick="quoteTruncate(1000000)">백만원</button>
            <button type="button" class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11.5px" onclick="quoteDcClear()">해제</button>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:17px;border-top:1px solid var(--bd2);padding-top:8px"><span style="font-weight:700">합계금액</span><b id="q-total" style="color:var(--gd)">0</b></div>
        </div>
      </div>
      <div class="frm-foot" style="margin-top:13px">${editing ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="delQuote('${q.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="quoteCancel()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitQuote('${editing ? q.id : ''}')"><i class="ti ti-check"></i>${editing ? '저장' : '견적 저장'}</button></div>
    </div>`;
  quoteRecalc();
}
function collectQItems() {
  const items = [];
  document.querySelectorAll('#q-rows .q-row').forEach(r => {
    const name = (r.querySelector('.q-mat').value || '').trim(); const spec = (r.querySelector('.q-spec').value || '').trim();
    const qty = _numv(r.querySelector('.q-qty').value); const price = _numv(r.querySelector('.q-price').value);
    const stone = (r.querySelector('.q-stone') && r.querySelector('.q-stone').value) || '';
    if (name && qty > 0) items.push(Object.assign({ name, spec, unit: '', qty, price, amt: Math.round(qty * price) }, stone ? { stone } : {}));
  });
  document.querySelectorAll('.qx-row').forEach(r => {
    const name = r.getAttribute('data-name'); const unit = r.getAttribute('data-unit') || ''; const qty = _numv(r.querySelector('.qx-qty').value); const price = _numv(r.querySelector('.qx-price').value);
    if (name && qty > 0) items.push({ name, spec: '', unit, qty, price, amt: Math.round(qty * price), extra: true });
  });
  return items;
}
/* 견적 저장 시 유형별 단가표에 반영(학습) */
async function quoteLearnPrice(type, name, price) {
  if (!name || !(price > 0)) return; const key = ctypeKey(type);
  const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(name));
  if (pl) { if ((+pl[key] || 0) !== price) { const patch = {}; patch[key] = price; await Store.update('priceList', pl.id, patch); } }
  else { const obj = { itemName: name, dist: 0, interior: 0, consumer: 0 }; obj[key] = price; await Store.add('priceList', obj); }
}
async function submitQuote(id) {
  const client = (el('q-client') && el('q-client').value || '').trim();
  if (!client) { toast('거래처를 입력하세요'); return; }
  const items = collectQItems();
  if (!items.length) { toast('견적 품목과 수량을 입력하세요'); return; }
  const ctype = (el('q-ctype') && el('q-ctype').value) || '소비자';
  const date = (el('q-date') && el('q-date').value) || todayStr();
  const valid = (el('q-valid') && el('q-valid').value || '').trim();
  const attn = (el('q-attn') && el('q-attn').value || '').trim();
  const siteAddr = (el('q-site') && el('q-site').value || '').trim();
  const category = (el('q-cat') && el('q-cat').value) || '세라믹+세면대';
  const memo = (el('q-memo') && el('q-memo').value || '').trim();
  const supply = items.reduce((a, b) => a + (+b.amt || 0), 0); const vat = Math.round(supply * 0.1); const discount = el('q-dc') ? _numv(el('q-dc').value) : 0; const total = supply + vat - discount;
  if (_busy) return; _busy = true;
  try {
    await ensureClient(client);
    const q = id ? (state.quotes || []).find(x => x.id === id) : null;
    const docNo = (q && q.docNo) || quoteNextDocNo();
    const useSalesRep = !!(el('q-userep') && el('q-userep').checked);
    const data = { docNo, client, ctype, category, date, valid, attn, siteAddr, items, supply, vat, discount, total, memo, useSalesRep, by: (el('q-staff') && el('q-staff').value.trim()) || (me && me.name) || '', createdAt: (q && q.createdAt) || Date.now(), updatedAt: Date.now() };
    if (id) await Store.update('quotes', id, data); else await Store.add('quotes', data);
    try { const cdoc = (state.clients || []).find(x => _normName(x.value) === _normName(client)); if (cdoc && (cdoc.ctype || '') !== ctype) await Store.update('clients', cdoc.id, { ctype }); } catch (e) { }   // 거래처 유형 기억
    for (const it of items) { if (it.extra) continue; try { await quoteLearnPrice(ctype, it.name, +it.price || 0); } catch (e) { } }   // 유형별 단가표 학습(부대비용 제외)
    try {   // 부대비용 기본단가 기억
      const cur = extraPrices(); const np = Object.assign({}, cur); let ch = false;
      document.querySelectorAll('.qx-row').forEach(r => { const nm = r.getAttribute('data-name'); const pr = _numv(r.querySelector('.qx-price').value); if (pr > 0 && cur[nm] !== pr) { np[nm] = pr; ch = true; } });
      if (ch) await saveExtraPrices(np);
    } catch (e) { }
    filters.quoteEdit = ''; filters.quoteCopy = false; toast(id ? '견적 저장됨' : '견적 저장 · 유형별 단가 반영됨'); renderQuote();
  } finally { setTimeout(() => { _busy = false; }, 500); }
}
async function delQuote(id) {
  if (!confirm('이 견적을 삭제할까요?')) return;
  await Store.remove('quotes', id); filters.quoteEdit = ''; toast('삭제됨'); renderQuote();
}
/* ── 견적 ERP: 결제·세금계산서 상태, 견적→출고 ── */
async function quoteMarkPaid(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  const total = +q.total || 0; const cur = +q.paidAmount || 0;
  const inp = prompt('입금 받은 누적 금액을 입력하세요.\n합계 ' + fmtWon(total) + '원 · 현재 입금 ' + fmtWon(cur) + '원\n(전액 입금: ' + total + ')', String(cur || ''));
  if (inp === null) return;
  let amt = Math.max(0, Math.round(_numv(inp))); if (total > 0 && amt > total) amt = total;
  const paid = total > 0 && amt >= total;
  await Store.update('quotes', id, { paidAmount: amt, paid: paid, paidDate: amt > 0 ? todayStr() : '' });
  toast(paid ? '결제완료' : (amt > 0 ? ('입금 ' + fmtWon(amt) + ' · 미수 ' + fmtWon(total - amt)) : '미결제'));
}
async function quoteMarkTax(id) { const q = (state.quotes || []).find(x => x.id === id); if (!q) return; const t = !q.taxInvoice; await Store.update('quotes', id, { taxInvoice: t, taxDate: t ? todayStr() : '' }); toast(t ? '세금계산서 발행 표시' : '표시 해제'); }
function quoteToShip(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  try { Store.update('quotes', id, { shipped: true, shipStartedAt: Date.now() }); } catch (e) { }
  openShipForm({ targetName: q.client, items: (q.items || []).map(it => ({ name: it.name, qty: it.qty, lot: '', pattern: '' })) });
  toast('견적 품목을 출고 등록 폼에 불러왔습니다 · 확인 후 등록하세요');
}
function quoteConfirmOrder(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  try { Store.update('quotes', id, { ordered: true, orderedAt: Date.now() }); } catch (e) { }
  toast('확정 주문 · 진행중 발주로 전환됨'); try { renderQuote(); } catch (e) { }
}
function quoteCancelOrder(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  if (!confirm('확정 주문을 취소할까요?\n(미확정 상태로 되돌립니다)')) return;
  try { Store.update('quotes', id, { ordered: false, orderedAt: 0 }); } catch (e) { }
  toast('확정 주문 취소됨'); try { renderQuote(); } catch (e) { }
}
function quoteRegister(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  const items = (q.items || []).filter(it => marginCat(it.name) === '자재').map(it => ({ name: it.name, qty: it.qty, lot: '', pattern: '' }));   // 출고엔 자재만 (가공·운송 제외)
  const hasBasin = (q.items || []).some(it => (it.name || '').includes('세면대'));
  const hasGagong = (q.items || []).some(it => marginCat(it.name) === '가공');
  if (hasBasin) {
    let bi = (q.items || []).filter(it => (it.name || '').includes('세면대')).map(it => ({ stone: it.stone || '', spec: it.spec || '', qty: it.qty || '', quoteNo: q.docNo || '' }));
    if (!bi.length) bi = (q.items || []).map(it => ({ stone: it.name, spec: it.spec || '', qty: it.qty || '' }));
    go('basin'); setTimeout(() => { try { openBasinForm(null, { vendor: q.client, items: bi, quoteId: id }); } catch (e) { } }, 90);
    toast('세면대 발주로 불러왔습니다');
  } else if (hasGagong) {
    go('sites'); setTimeout(() => { try { openSiteForm(null, { name: q.client, address: q.siteAddr, quoteId: id }); } catch (e) { } }, 90);
    toast('가공 포함 · 현장 등록으로 이동');
  } else { openShipForm({ targetName: q.client, items: items, quoteId: id }); toast('출고 등록으로 불러왔습니다 · 확인 후 등록'); }
}
function quoteToOrder(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  try { Store.update('quotes', id, { ordered: true, orderedAt: Date.now(), shipped: true, shipStartedAt: q.shipStartedAt || Date.now() }); } catch (e) { }
  const items = (q.items || []).map(it => ({ name: it.name, qty: it.qty, lot: '', pattern: '' }));
  const hasBasin = (q.items || []).some(it => (it.name || '').includes('세면대'));
  if (hasBasin) {
    let bi = (q.items || []).filter(it => (it.name || '').includes('세면대')).map(it => ({ stone: it.stone || '', spec: it.spec || '', qty: it.qty || '', quoteNo: q.docNo || '' }));
    if (!bi.length) bi = (q.items || []).map(it => ({ stone: it.name, spec: it.spec || '', qty: it.qty || '' }));
    go('basin'); setTimeout(() => { try { openBasinForm(null, { vendor: q.client, items: bi, quoteId: id }); } catch (e) { } }, 90);
    toast('확정 · 세면대 발주로 불러왔습니다');
  } else if ((q.siteAddr || '').trim()) {
    go('sites'); setTimeout(() => { try { openSiteForm(null, { name: q.client, address: q.siteAddr, quoteId: id }); } catch (e) { } }, 90);
    toast('확정 · 현장 등록으로 이동');
  } else { openShipForm({ targetName: q.client, items: items }); toast('확정 · 출고 등록으로 불러왔습니다 · 확인 후 등록'); }
}
/* ── 세금계산서 발행 (팝빌 Popbill · CF action=taxinvoice) ── */
function clientTaxInfo(name) { const c = (state.clients || []).find(x => _normName(x.value) === _normName(name)); return (c && c.taxInfo) || {}; }
async function saveClientTaxInfo(name, info) { const c = (state.clients || []).find(x => _normName(x.value) === _normName(name)); if (c) { try { await Store.update('clients', c.id, { taxInfo: info }); } catch (e) { } } }
function openTaxForm(id) { if (!isAdmin()) { toast('세금계산서 발행은 관리자만 가능합니다'); return; } filters.taxEdit = id; renderQuote(); if (el('pg-quote')) el('pg-quote').scrollIntoView({ block: 'start' }); }
function taxCancel() { filters.taxEdit = ''; renderQuote(); }
function renderTaxForm() {
  const id = filters.taxEdit; const q = (state.quotes || []).find(x => x.id === id); if (!q) { filters.taxEdit = ''; renderQuote(); return; }
  const co = companyInfo(); const ti = clientTaxInfo(q.client);
  const inp = 'width:100%;font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:9px';
  const fld = (fid, label, val, ph) => `<div class="fld" style="flex:1;min-width:150px;margin:0"><label>${label}</label><input id="${fid}" lang="ko" value="${esc(val || '')}" placeholder="${ph || ''}" style="${inp}"></div>`;
  el('pg-quote').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-file-invoice"></i>세금계산서 발행</h2><p>${esc(q.docNo || '')} · ${esc(q.client || '')}</p></div>
      <button class="btn btn-sm" onclick="taxCancel()"><i class="ti ti-arrow-left"></i> 목록</button></div>
    <div id="taxform-root" class="card" style="padding:15px 17px">
      <div style="font-weight:800;font-size:13px;color:var(--gd);margin-bottom:9px">공급받는자 (거래처)</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px"><div class="fld" style="flex:1;min-width:180px;margin:0"><label>사업자등록번호 *</label><div style="display:flex;gap:6px"><input id="tx-bizno" inputmode="numeric" value="${esc(ti.bizNo || '')}" placeholder="000-00-00000" style="${inp}"><button class="btn btn-sm btn-pri" style="flex:none;white-space:nowrap" onclick="lookupBizInfo()"><i class="ti ti-search"></i>조회</button></div></div>${fld('tx-corp', '상호', ti.corpName || q.client)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">${fld('tx-ceo', '대표자', ti.ceo)}${fld('tx-contact', '담당자', ti.contact)}</div>
      <div class="fld full" style="margin-bottom:8px"><label>주소</label><input id="tx-addr" lang="ko" value="${esc(ti.addr || '')}" style="${inp}"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">${fld('tx-biztype', '업태', ti.bizType)}${fld('tx-bizclass', '종목', ti.bizClass)}</div>
      <div class="fld full" style="margin-bottom:13px"><label>담당자 이메일 <span class="req">*</span> <span style="color:var(--t3);font-weight:500">(발행 안내메일 수신)</span></label><input id="tx-email" lang="en" value="${esc(ti.email || '')}" placeholder="name@company.com" style="${inp}"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div class="fld" style="flex:1;min-width:150px;margin:0"><label>작성일자</label><input type="date" id="tx-date" value="${esc(todayStr())}" style="${inp}"></div>
        <div class="fld" style="flex:1;min-width:150px;margin:0"><label>영수/청구</label><select id="tx-purpose" style="${inp}"><option>영수</option><option>청구</option></select></div>
      </div>
      <div style="background:var(--soft);border-radius:11px;padding:12px 14px;margin-bottom:12px;font-size:13px">
        <div style="color:var(--t2);margin-bottom:5px">공급자: <b>${esc(co.name)}</b> (${esc(co.bizno)})</div>
        <div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--t2)">공급가액</span><b>${fmtWon(q.supply)}원</b></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="color:var(--t2)">세액</span><b>${fmtWon(q.vat)}원</b></div>
        ${(+q.discount || 0) > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="color:var(--t2)">할인 (D/C)</span><b style="color:#c0341d">- ${fmtWon(q.discount)}원</b></div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:15px;border-top:1px solid var(--bd2);padding-top:6px"><span style="font-weight:700">합계</span><b style="color:var(--gd)">${fmtWon(q.total)}원</b></div>
      </div>
      <div style="font-size:11.5px;color:var(--t3);margin-bottom:11px">발행 시 국세청 전송되며 팝빌 포인트가 과금됩니다. 공급받는자 이메일로 발행 안내가 발송됩니다. ${co.bizno ? '' : '<b style="color:#c0341d">공급자 사업자번호가 없어 발행이 안 됩니다 — 회사 정보에서 설정하세요.</b>'}</div>
      <div class="frm-foot">${q.taxInvoice ? '<div style="flex:1;color:var(--gd);font-weight:700;font-size:13px;display:flex;align-items:center"><i class="ti ti-file-check"></i> 이미 발행됨' + (q.ntsConfirmNum ? ' · 승인 ' + esc(q.ntsConfirmNum) : '') + '</div>' : ''}<button class="btn" style="flex:1" onclick="taxCancel()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitTaxInvoice('${q.id}')"><i class="ti ti-file-check"></i>${q.taxInvoice ? '다시 발행' : '세금계산서 발행'}</button></div>
    </div>`;
}
async function submitTaxInvoice(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  const co = companyInfo();
  const bizNo = (el('tx-bizno').value || '').trim(); const email = (el('tx-email').value || '').trim();
  if (!(co.bizno || '').trim()) { toast('공급자 사업자번호가 없습니다 — 회사 정보에서 설정하세요'); return; }
  if (!bizNo) { toast('공급받는자 사업자등록번호를 입력하세요'); return; }
  if (!email) { toast('발행 안내메일 수신 이메일을 입력하세요'); return; }
  const buyer = { bizNo, corpName: (el('tx-corp').value || '').trim() || q.client, ceo: (el('tx-ceo').value || '').trim(), contact: (el('tx-contact').value || '').trim(), addr: (el('tx-addr').value || '').trim(), bizType: (el('tx-biztype').value || '').trim(), bizClass: (el('tx-bizclass').value || '').trim(), email };
  const writeDate = (el('tx-date').value || todayStr()).replace(/-/g, '');
  const purposeType = (el('tx-purpose') && el('tx-purpose').value) || '영수';
  const bt = (co.biztype || '').trim().split(/\s+/);
  const items = (q.items || []).filter(it => (+it.amt > 0) || (+it.qty > 0));
  let supplyTotal = 0; const detailList = items.map(it => { const sc = Math.round(+it.amt || 0); supplyTotal += sc; return { itemName: it.name, spec: it.spec || '', qty: it.qty || '', unitCost: it.price || '', supplyCost: sc, tax: Math.round(sc * 0.1), remark: '' }; });
  const taxTotal = detailList.reduce((a, b) => a + b.tax, 0); const totalAmount = supplyTotal + taxTotal;
  const payload = {
    invoicerCorpNum: co.bizno, mgtKey: (q.docNo || ('Q' + Date.now())), writeDate, purposeType,
    invoicerCorpName: co.name, invoicerCEOName: co.ceo, invoicerAddr: co.addr, invoicerBizType: bt[0] || co.biztype, invoicerBizClass: bt.slice(1).join(' ') || bt[0] || '', invoicerContactName: (me && me.name) || '', invoicerTEL: '', invoicerEmail: co.email,
    invoiceeCorpNum: buyer.bizNo, invoiceeCorpName: buyer.corpName, invoiceeCEOName: buyer.ceo, invoiceeAddr: buyer.addr, invoiceeBizType: buyer.bizType, invoiceeBizClass: buyer.bizClass, invoiceeContactName: buyer.contact, invoiceeEmail: buyer.email,
    supplyCostTotal: supplyTotal, taxTotal: taxTotal, totalAmount: totalAmount, detailList: detailList
  };
  if (_busy) return; _busy = true;
  try {
    toast('세금계산서 발행 중…');
    await saveClientTaxInfo(q.client, buyer);
    try { const _ct = classifyCtype(buyer.bizType, buyer.bizClass, buyer.corpName); const _c = (state.clients || []).find(x => _normName(x.value) === _normName(q.client)); if (_c && (_c.ctype || '') !== _ct) await Store.update('clients', _c.id, { ctype: _ct }); } catch (e) { }
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(PUSH_FN + '?action=taxinvoice', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { await Store.update('quotes', id, { taxInvoice: true, taxDate: todayStr(), ntsConfirmNum: j.ntsConfirmNum || '', taxMgtKey: j.mgtKey || payload.mgtKey }); toast('세금계산서 발행 완료' + (j.ntsConfirmNum ? (' · 승인 ' + j.ntsConfirmNum) : '')); filters.taxEdit = ''; renderQuote(); }
    else { toast('발행 실패: ' + ((j && j.error) || ('HTTP ' + r.status))); }
  } catch (e) { toast('발행 오류: ' + ((e && e.message) || e)); }
  finally { setTimeout(() => { _busy = false; }, 700); }
}
/* 업태/업종/상호로 거래처 유형 자동분류 */
function classifyCtype(bizType, bizClass, name) {
  const t = ((bizType || '') + ' ' + (bizClass || '') + ' ' + (name || '')).replace(/\s/g, '');
  if (/대리점/.test(t)) return '대리점';
  if (/건축|건설|가구|인테리어|시공|실내|목공|창호|리모델|설계|디자인|공사|marble/i.test(t)) return '인테리어';
  if (/도매|소매|도소매|타일|도기|위생|석재|제조|무역|유통|자재|판매|건자재/.test(t)) return '유통';
  return '소비자';
}
/* 사업자번호로 기업정보 조회 → 자동입력 + 유형 자동분류 + 거래처 등록 */
async function lookupBizInfo() {
  const raw = el('tx-bizno') ? el('tx-bizno').value : ''; const corpNum = (raw || '').replace(/[^0-9]/g, '');
  if (corpNum.length !== 10) { toast('사업자번호 10자리를 입력하세요'); return; }
  const co = companyInfo();
  toast('사업자 정보 조회 중…');
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(PUSH_FN + '?action=bizinfo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ corpNum: corpNum, memberCorpNum: co.bizno }) });
    const j = await r.json().catch(() => ({}));
    if (!(r.ok && j.ok)) { toast('조회 실패: ' + ((j && j.error) || ('HTTP ' + r.status))); return; }
    if (j.corpName && el('tx-corp')) el('tx-corp').value = j.corpName;
    if (j.ceo && el('tx-ceo')) el('tx-ceo').value = j.ceo;
    if (j.addr && el('tx-addr')) el('tx-addr').value = j.addr;
    if (j.bizType && el('tx-biztype')) el('tx-biztype').value = j.bizType;
    if (j.bizClass && el('tx-bizclass')) el('tx-bizclass').value = j.bizClass;
    const ct = classifyCtype(j.bizType, j.bizClass, j.corpName);
    const warn = (+j.closeDownState === 2) ? ' · ⚠폐업' : ((+j.closeDownState === 3) ? ' · ⚠휴업' : '');
    // 거래처에 등록(세금정보 + 유형)
    const q = (state.quotes || []).find(x => x.id === filters.taxEdit);
    if (q) {
      const buyer = { bizNo: corpNum, corpName: j.corpName || '', ceo: j.ceo || '', addr: j.addr || '', bizType: j.bizType || '', bizClass: j.bizClass || '', contact: (el('tx-contact') && el('tx-contact').value) || '', email: (el('tx-email') && el('tx-email').value) || '' };
      await saveClientTaxInfo(q.client, buyer);
      const c = (state.clients || []).find(x => _normName(x.value) === _normName(q.client));
      if (c && (c.ctype || '') !== ct) { try { await Store.update('clients', c.id, { ctype: ct }); } catch (e) { } }
    }
    toast('조회완료 · 유형: ' + ct + warn);
  } catch (e) { toast('조회 오류: ' + ((e && e.message) || e)); }
}
/* ── 견적 기본설정: 비고 양식 · 거래처 유형 · 자재별 유형단가 ── */
function openQuoteSettings() { filters.quoteSettings = true; renderQuote(); }
function quoteSettingsClose() { filters.quoteSettings = false; renderQuote(); }
async function saveQuoteMemo() {
  const t = (el('qs-memo') && el('qs-memo').value || '');
  const ex = (state.appmeta || []).find(x => x.key === 'quoteMemo');
  if (ex) await Store.update('appmeta', ex.id, { text: t }); else await Store.add('appmeta', { key: 'quoteMemo', text: t });
  toast('비고 기본 양식 저장됨');
}
async function setClientTypeSetting(id, type) { try { await Store.update('clients', id, { ctype: type }); } catch (e) { } }
function _ctypeNorm(v) { const s = String(v == null ? '' : v).replace(/\s/g, ''); if (!s) return ''; if (/유통|도매/.test(s)) return '유통'; if (/대리점/.test(s)) return '대리점'; if (/인테리어|시공/.test(s)) return '인테리어'; if (/별도|이외|특판|예외/.test(s)) return '별도'; if (/소비자|소매|일반|개인/.test(s)) return '소비자'; return ''; }
/* 거래처 유형 엑셀/CSV 업로드 → clients.ctype 학습 */
function clientTypeImport(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); input.value = ''; return; }
  const rd = new FileReader();
  rd.onload = async e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      let hi = -1, nameC = -1, typeC = -1;
      for (let r = 0; r < Math.min(rows.length, 12); r++) {
        const cells = rows[r] || []; let nc = -1, tc = -1;
        cells.forEach((c, i) => { const s = String(c || '').replace(/\s/g, '');
          if (nc < 0 && /(거래처|업체|상호|성명|명칭|고객|거래선)/.test(s)) nc = i;
          if (tc < 0 && /(유형|구분|타입|등급|단가유형)/.test(s)) tc = i;
        });
        if (nc >= 0 && tc >= 0) { hi = r; nameC = nc; typeC = tc; break; }
      }
      if (hi < 0) { toast('헤더를 못 찾음 — 거래처명 + 유형 열이 필요합니다'); input.value = ''; return; }
      let n = 0, added = 0, skipped = 0;
      for (let r = hi + 1; r < rows.length; r++) {
        const cells = rows[r] || []; const name = String(cells[nameC] == null ? '' : cells[nameC]).trim(); if (!name) continue;
        const ctype = _ctypeNorm(cells[typeC]); if (!ctype) { skipped++; continue; }
        const c = (state.clients || []).find(x => _normName(x.value) === _normName(name));
        if (c) { await Store.update('clients', c.id, { ctype }); } else { await Store.add('clients', { value: name, ctype }); added++; }
        n++;
      }
      toast(n ? (n + '개 거래처 유형 반영' + (added ? ' (신규 ' + added + ')' : '') + (skipped ? ' · 유형없음 ' + skipped + '건 건너뜀' : '')) : '반영된 행이 없습니다 (유형 열 확인)'); input.value = '';
      setTimeout(() => { if (tab === 'clients') renderClients(); else if (filters.quoteSettings) renderQuoteSettings(); }, 400);
    } catch (err) { toast('파일을 읽지 못했습니다'); input.value = ''; }
  };
  rd.readAsArrayBuffer(f);
}
/* 거래처 유형 양식(현재값 채워서) 엑셀 다운로드 */
function clientTypeTemplate() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const clients = (state.clients || []).slice().sort((a, b) => (a.value || '').localeCompare(b.value || ''));
  const aoa = [['거래처명', '유형']].concat(clients.map(c => [c.value || '', c.ctype || '']));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '거래처유형');
  XLSX.writeFile(wb, '거래처유형양식_' + todayStr() + '.xlsx');
  toast('거래처 유형 양식(.xlsx) 다운로드 · 유형(유통/대리점/인테리어/소비자/별도) 채워 다시 업로드');
}
/* 견적/단가 대상 품목: 재고 + 단가표(priceList) 통합 목록 */
function quotePriceItems() {
  const map = {};
  (state.inventory || []).forEach(i => { if (i.name) map[_normName(i.name)] = { name: i.name, spec: i.spec || '' }; });
  (state.priceList || []).forEach(p => { const k = _normName(p.itemName); if (p.itemName && !map[k]) map[k] = { name: p.itemName, spec: p.spec || '' }; });
  return Object.values(map).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
async function savePriceRow(itemName) {
  const row = document.querySelector(`.qs-prow[data-nm="${CSS.escape(itemName)}"]`); if (!row) return;
  const patch = { dist: _numv(row.querySelector('.qsp-dist').value), agency: _numv(row.querySelector('.qsp-agy').value), interior: _numv(row.querySelector('.qsp-int').value), consumer: _numv(row.querySelector('.qsp-con').value) };
  const spcEl = row.querySelector('.qsp-spc'); if (spcEl) patch.special = _numv(spcEl.value);
  const costEl = row.querySelector('.qsp-cost'); if (costEl && isAdmin()) patch.cost = _numv(costEl.value);   // 원가는 관리자만 저장
  const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(itemName));
  if (pl) await Store.update('priceList', pl.id, patch); else await Store.add('priceList', Object.assign({ itemName, dist: 0, agency: 0, interior: 0, consumer: 0 }, patch));
  const ok = row.querySelector('.qsp-ok'); if (ok) { ok.style.opacity = 1; setTimeout(() => { ok.style.opacity = 0; }, 1200); }
}
async function deletePriceRow(id, name) {
  if (!id) return;
  if (!confirm((name || '이 자재') + ' 단가를 삭제할까요?')) return;
  await Store.remove('priceList', id);
  toast('단가 삭제됨');
  setTimeout(() => { const b = document.querySelector('#qs-prices tbody'); if (b) b.innerHTML = _qsPriceRowsHtml(); }, 250);
}
/* 엑셀/CSV 단가표 헤더 열 매핑 */
function mapPriceCols(cells) {
  const m = { name: null, spec: null, dist: null, agency: null, interior: null, consumer: null, special: null, cost: null };
  cells.forEach((c, i) => { const s = String(c || '').replace(/\s/g, '');
    if (m.name == null && /(자재명|품목명|제품명|자재|품목|품명|제품|명칭)/.test(s)) m.name = i;
    if (m.spec == null && /(규격|사이즈|치수|size)/i.test(s)) m.spec = i;
    if (m.dist == null && /(유통|도매)/.test(s)) m.dist = i;
    if (m.agency == null && /대리점/.test(s)) m.agency = i;
    if (m.interior == null && /(인테리어|시공)/.test(s)) m.interior = i;
    if (m.special == null && /(별도|이외|특판)/.test(s)) m.special = i;
    if (m.consumer == null && /(소비자|소매|일반|판매가|판매)/.test(s)) m.consumer = i;
    if (m.cost == null && /(원가|매입|cost)/i.test(s)) m.cost = i;
  });
  return m;
}
/* 단가표 엑셀/CSV 업로드 → priceList 학습 */
function priceListImport(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); input.value = ''; return; }
  const rd = new FileReader();
  rd.onload = async e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      let hi = -1, map = {};
      for (let r = 0; r < Math.min(rows.length, 12); r++) { const m = mapPriceCols(rows[r]); if (m.name != null && (m.dist != null || m.agency != null || m.interior != null || m.consumer != null)) { hi = r; map = m; break; } }
      if (hi < 0) { toast('헤더를 못 찾음 — 자재명 + 유통/대리점/인테리어/소비자 열이 필요합니다'); input.value = ''; return; }
      let n = 0; const adm = isAdmin();
      for (let r = hi + 1; r < rows.length; r++) {
        const cells = rows[r] || []; const name = String(cells[map.name] == null ? '' : cells[map.name]).trim(); if (!name) continue;
        const patch = {}; [['dist', map.dist], ['agency', map.agency], ['interior', map.interior], ['consumer', map.consumer], ['special', map.special]].forEach(([k, ci]) => { if (ci != null) { const v = _numv(cells[ci]); if (v > 0) patch[k] = v; } });
        if (map.cost != null && adm) { const cv = _numv(cells[map.cost]); if (cv > 0) patch.cost = cv; }   // 원가는 관리자만
        if (map.spec != null) { const sp = String(cells[map.spec] == null ? '' : cells[map.spec]).trim(); if (sp) patch.spec = sp; }
        if (!Object.keys(patch).length) continue;
        const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(name));
        if (pl) await Store.update('priceList', pl.id, patch); else await Store.add('priceList', Object.assign({ itemName: name, dist: 0, agency: 0, interior: 0, consumer: 0 }, patch));
        n++;
      }
      toast(n ? (n + '개 자재 단가 반영됨') : '반영된 행이 없습니다 (열 이름 확인)'); input.value = ''; setTimeout(() => { if (filters.quoteSettings) renderQuoteSettings(); }, 400);
    } catch (err) { toast('파일을 읽지 못했습니다'); input.value = ''; }
  };
  rd.readAsArrayBuffer(f);
}
/* 단가표 양식(현재값 채워서) 엑셀 다운로드 — 수정 후 다시 업로드 */
function priceListTemplate() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const adm = isAdmin();
  const items = quotePriceItems();
  const head = ['자재명', '규격', '유통', '대리점', '인테리어', '소비자', '별도'].concat(adm ? ['원가'] : []);
  const aoa = [head].concat(items.map(i => { const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(i.name)) || {}; const row = [i.name, i.spec || '', pl.dist || '', pl.agency || '', pl.interior || '', pl.consumer || '', pl.special || '']; if (adm) row.push(pl.cost || ''); return row; }));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '단가표');
  XLSX.writeFile(wb, '단가표양식_' + todayStr() + '.xlsx');
  toast('단가표 양식(.xlsx) 다운로드 · 수정 후 다시 업로드하세요');
}
function _qsClientRowsHtml() {
  const clSearch = (filters.qsClientSearch || '').trim().toLowerCase();
  let clients = (state.clients || []).slice().sort((a, b) => (a.value || '').localeCompare(b.value || ''));
  if (clSearch) clients = clients.filter(c => (c.value || '').toLowerCase().includes(clSearch));
  return clients.slice(0, 300).map(c => `<div class="mem"><div class="info"><div class="nm">${esc(c.value)}</div></div>
    <select onchange="setClientTypeSetting('${c.id}',this.value)" style="font-size:13px;padding:6px 8px;border:1.5px solid var(--bd2);border-radius:8px">${CTYPES.map(t => `<option ${((c.ctype) || '소비자') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`).join('') || '<div style="font-size:12.5px;color:var(--t3);padding:8px">거래처가 없습니다.</div>';
}
function _qsPriceRowsHtml() {
  const adm = isAdmin();
  const matSearch = (filters.qsMatSearch || '').trim().toLowerCase();
  let mats = quotePriceItems();
  if (matSearch) mats = mats.filter(i => (i.name || '').toLowerCase().includes(matSearch) || (i.spec || '').toLowerCase().includes(matSearch));
  const inp = 'width:100%;font-size:13px;padding:7px 4px;border:1.5px solid var(--bd2);border-radius:8px;text-align:right';
  const cols = adm ? 8 : 7;
  return mats.slice(0, 150).map(i => { const pl = (state.priceList || []).find(p => _normName(p.itemName) === _normName(i.name)) || {}; const nm = esc(i.name).replace(/'/g, "\\'");
    const _cat = itemCategory(i.name); return `<tr class="qs-prow" data-nm="${esc(i.name)}"><td style="text-align:left"><b>${esc(i.name)}</b>${i.spec ? `<div style="font-size:10.5px;color:var(--t3)">${esc(i.spec)}</div>` : ''}<select onchange="saveItemCat('${nm}',this.value)" style="margin-top:3px;font-size:10.5px;padding:2px 4px;border:1px solid var(--bd2);border-radius:6px;color:var(--t2)">${QCATS.map(cc => `<option ${_cat === cc ? 'selected' : ''}>${cc}</option>`).join('')}</select></td>
      <td><input class="qsp-dist" inputmode="numeric" value="${esc(pl.dist || '')}" onchange="savePriceRow('${nm}')" style="${inp}"></td>
      <td><input class="qsp-agy" inputmode="numeric" value="${esc(pl.agency || '')}" onchange="savePriceRow('${nm}')" style="${inp}"></td>
      <td><input class="qsp-int" inputmode="numeric" value="${esc(pl.interior || '')}" onchange="savePriceRow('${nm}')" style="${inp}"></td>
      <td><input class="qsp-con" inputmode="numeric" value="${esc(pl.consumer || '')}" onchange="savePriceRow('${nm}')" style="${inp}"></td>
      <td><input class="qsp-spc" inputmode="numeric" value="${esc(pl.special || '')}" onchange="savePriceRow('${nm}')" style="${inp};background:#eef5ff;border-color:#b8d4ee"></td>
      ${adm ? `<td><input class="qsp-cost" inputmode="numeric" value="${esc(pl.cost || '')}" onchange="savePriceRow('${nm}')" style="${inp};background:#fff6f6;border-color:#e6b0b0"></td>` : ''}
      <td style="width:46px;white-space:nowrap;text-align:center"><i class="ti ti-check qsp-ok" style="color:var(--gd);opacity:0;transition:opacity .2s"></i>${pl.id ? `<i class="ti ti-trash" onclick="deletePriceRow('${pl.id}','${nm}')" title="단가 삭제" style="color:#c0341d;cursor:pointer;margin-left:8px;font-size:16px"></i>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="${cols}"><div class="empty" style="padding:14px">자재가 없습니다</div></td></tr>`;
}
function qsFilterClients(v) { filters.qsClientSearch = v; const c = el('qs-clients'); if (c) c.innerHTML = _qsClientRowsHtml(); }
function qsFilterPrices(v) { filters.qsMatSearch = v; const b = document.querySelector('#qs-prices tbody'); if (b) b.innerHTML = _qsPriceRowsHtml(); }
function renderQuoteSettings() {
  const memo = quoteMemoTemplate();
  const ci = companyInfo();
  const coFields = [['name', '상호'], ['ceo', '대표'], ['bizno', '사업자등록번호'], ['addr', '주소'], ['tel', '연락처'], ['biztype', '업태·종목'], ['email', '이메일'], ['web', '홈페이지']];
  el('pg-quote').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-settings"></i>견적 기본설정</h2><p>비고 양식 · 거래처 유형 · 자재별 유형단가</p></div>
      <button class="btn btn-sm" onclick="quoteSettingsClose()"><i class="ti ti-arrow-left"></i> 견적 목록</button></div>
    <div id="qset-root">
      <div class="card" style="margin-bottom:12px;padding:13px 15px">
        <div class="card-h"><h3><i class="ti ti-building"></i>회사 정보 · 도장</h3><span class="more" style="font-size:11px;color:var(--t3)">견적서·발주서에 표시</span></div>
        <div style="font-size:11.5px;color:var(--t3);margin-bottom:9px">여기 정보가 견적서·발주서 상단 공급자란에 표시됩니다.</div>
        ${coFields.map(([k, label]) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><label style="width:100px;font-size:12px;color:var(--t2);flex:none">${label}</label><input value="${esc(ci[k] || '')}" onchange="saveCompanyField('${k}',this.value)" autocomplete="off" lang="ko" style="flex:1;min-width:0;font-size:13px;padding:7px 9px;border:1.5px solid var(--bd2);border-radius:8px"></div>`).join('')}
        <div style="display:flex;align-items:center;gap:12px;margin-top:11px;padding-top:11px;border-top:0.5px solid var(--bd)">
          <div style="width:62px;height:62px;flex:none;border:1px dashed var(--bd2);border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden">${ci.stampImg ? `<img src="${ci.stampImg}" style="width:100%;height:100%;object-fit:contain">` : `<span style="font-size:9px;color:#c2a06a;border:1.5px solid #c2a06a;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center">도장</span>`}</div>
          <div style="flex:1">
            <div style="font-size:12px;color:var(--t2);margin-bottom:6px">도장 · 직인 이미지 <span style="color:var(--t3)">(배경 투명 PNG 권장)</span></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-sm btn-pri" onclick="el('stamp-file').click()"><i class="ti ti-upload"></i> 이미지 업로드</button>
              ${ci.stampImg ? `<button class="btn btn-sm" onclick="removeStamp()"><i class="ti ti-trash"></i> 제거</button>` : ''}
              <input type="file" id="stamp-file" accept="image/*" style="display:none" onchange="companyStampImport(this)">
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px;padding:13px 15px">
        <div class="card-h"><h3><i class="ti ti-note"></i>비고 기본 양식</h3></div>
        <div style="font-size:11.5px;color:var(--t3);margin-bottom:7px">새 견적을 작성할 때 비고란에 자동으로 채워집니다.</div>
        <textarea id="qs-memo" lang="ko" placeholder="예) · 부가세 별도\n· 결제: 계약금 50%, 잔금 납품 시\n· 납기: 발주 후 7일\n· 유효기간: 견적일로부터 15일" style="width:100%;min-height:110px;font-size:14px;padding:10px;border:1.5px solid var(--bd2);border-radius:10px">${esc(memo)}</textarea>
        <button class="btn btn-pri btn-sm btn-block" style="margin-top:8px" onclick="saveQuoteMemo()"><i class="ti ti-check"></i>비고 양식 저장</button>
      </div>

      <div class="card" style="margin-bottom:12px;padding:13px 15px">
        <div class="card-h"><h3><i class="ti ti-tools"></i>부대비용 · 가공 단가</h3><span class="more" style="font-size:11px;color:var(--t3)">견적 작성 시 자동 표시</span></div>
        <div style="font-size:11.5px;color:var(--t3);margin-bottom:8px">기본 단가를 미리 저장하면 견적 작성 시 자동으로 채워집니다. 항목을 추가·삭제할 수 있습니다.</div>
        <div id="qs-extras" data-keepscroll style="max-height:340px;overflow:auto;border:0.5px solid var(--bd);border-radius:10px;padding:2px 8px">${_qsExtraRowsHtml()}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input id="qe-new" lang="ko" placeholder="새 항목명 (예: 모서리 가공)" autocomplete="off" style="flex:1;font-size:13.5px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:8px">
          <button class="btn btn-sm btn-pri" onclick="addExtraItem()"><i class="ti ti-plus"></i>항목 추가</button>
        </div>
      </div>
      <div class="card" style="padding:13px 15px">
        <div class="card-h"><h3><i class="ti ti-currency-won"></i>자재별 유형단가</h3><span class="more" style="font-size:11px;color:var(--t3)">칸에 입력하면 자동 저장</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button class="btn btn-sm btn-pri" onclick="el('pl-file').click()"><i class="ti ti-upload"></i> 엑셀 업로드</button>
          <button class="btn btn-sm" onclick="priceListTemplate()"><i class="ti ti-download"></i> 양식 다운로드</button>
          <input type="file" id="pl-file" accept=".xlsx,.xls,.csv" style="display:none" onchange="priceListImport(this)">
        </div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:8px">엑셀/CSV 열: <b>자재명 · 규격 · 유통 · 대리점 · 인테리어 · 소비자 · 별도</b> (열 이름만 맞으면 순서 무관). <b style="color:#1a6dc0">별도</b>=예외 업체(신성그룹·현대엘앤씨 등) 단가. PDF는 자동 인식이 안 되니 엑셀/CSV로 올려주세요.</div>
        <div class="search-box" style="margin-bottom:8px"><i class="ti ti-search"></i><input placeholder="자재명·규격 검색" value="${esc(filters.qsMatSearch || '')}" oninput="qsFilterPrices(this.value)" autocomplete="off" lang="ko"></div>
        <div data-keepscroll id="qs-prices" style="max-height:52vh;overflow:auto">
          <table class="tbl"><thead><tr><th style="text-align:left">자재</th><th>유통</th><th>대리점</th><th>인테리어</th><th>소비자</th><th style="color:#1a6dc0">별도</th>${isAdmin() ? '<th style="color:#c0341d">원가🔒</th>' : ''}<th></th></tr></thead><tbody>${_qsPriceRowsHtml()}</tbody></table>
        </div>
        <div style="font-size:11px;color:var(--t3);margin-top:6px">단가는 칸을 벗어나면(Tab/클릭) 자동 저장됩니다. 상위 120개 표시 — 검색으로 좁혀주세요.</div>
      </div>
    </div>`;
}
function quoteCatChanged(v) { filters.quoteCat = v; renderQuoteForm(); }
function cxRowHtml(d) {
  d = d || {}; const inp = 'font-size:14px;padding:7px 8px;border:1.5px solid var(--bd2);border-radius:8px';
  return `<div class="cx-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
    <input class="cx-name" lang="ko" placeholder="항목" value="${esc(d.name || '')}" style="flex:2;min-width:0;${inp}">
    <input class="cx-supply" inputmode="numeric" placeholder="공급가액" value="${esc(d.supply || '')}" oninput="customsRecalc()" style="flex:1.3;min-width:0;${inp};text-align:right">
    <input class="cx-vat" inputmode="numeric" placeholder="부가세" value="${esc(d.vat || '')}" oninput="customsRecalc()" style="flex:1.3;min-width:0;${inp};text-align:right">
    <input class="cx-note" lang="ko" placeholder="비고" value="${esc(d.note || '')}" style="flex:1.4;min-width:0;${inp}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.cx-row').remove();customsRecalc()"><i class="ti ti-x"></i></button>
  </div>`;
}
function addCustomsRow() { const c = el('cx-rows'); if (c) c.insertAdjacentHTML('beforeend', cxRowHtml({})); }
function customsRecalc() {
  let sup = 0, vat = 0;
  document.querySelectorAll('#cx-rows .cx-row').forEach(r => { sup += _numv(r.querySelector('.cx-supply').value); vat += _numv(r.querySelector('.cx-vat').value); });
  if (el('cx-supply')) el('cx-supply').textContent = fmtWon(sup);
  if (el('cx-vat')) el('cx-vat').textContent = fmtWon(vat);
  if (el('cx-total')) el('cx-total').textContent = fmtWon(sup + vat);
}
function renderCustomsForm(q, copy) {
  const v = q || {}; const editing = q && !copy; const cs = v.customs || {};
  const inp = 'font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:9px;width:100%';
  const lines = (v.items && v.items.length) ? v.items : CUSTOMS_LINES.map(n => ({ name: n, supply: '', vat: '', note: '' }));
  const rowsHtml = lines.map(cxRowHtml).join('');
  const hf = (fid, label, val, ph) => `<div class="fld" style="flex:1;min-width:140px;margin:0"><label>${label}</label><input id="${fid}" lang="ko" value="${esc(val || '')}" placeholder="${ph || ''}" style="${inp}"></div>`;
  el('pg-quote').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-ship"></i>통관비 예상 견적</h2><p>수입 통관비용 견적</p></div>
      <button class="btn btn-sm" onclick="quoteCancel()"><i class="ti ti-arrow-left"></i> 목록</button></div>
    <div id="qform-root" class="card" style="padding:15px 17px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <div class="fld" style="flex:2;min-width:180px;margin:0"><label>거래처 (TO) <span class="req">*</span></label>${searchBox('cx-client', '업체명 검색·입력', v.client || '', 'companyNames', '')}</div>
        <div class="fld" style="flex:1;min-width:130px;margin:0"><label>분류</label><select onchange="quoteCatChanged(this.value)" style="${inp}"><option>통관비용</option><option>세라믹+세면대</option><option>석재</option></select></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <div class="fld" style="flex:1;min-width:130px;margin:0"><label>견적일 (DATE)</label><input type="date" id="cx-date" value="${esc((editing && v.date) || todayStr())}" style="${inp}"></div>
        ${hf('cx-vessel', '선명', cs.vessel)}${hf('cx-arrive', '입항일', cs.arriveDate, '예: 7월 27일')}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        ${hf('cx-bl', 'B/L NO', cs.blNo)}${hf('cx-product', '품명', cs.product, '예: STONE PRODUCTS')}${hf('cx-port', '도착항', cs.port, '예: 평택항')}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        ${hf('cx-invoice', 'AMOUNT (인보이스)', cs.invoiceAmt, '예: ¥38,238.51')}${hf('cx-rate', '주간환율', cs.exRate, '예: @₩221.56')}${hf('cx-assessed', '감정가격', cs.assessedPrice)}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        ${hf('cx-qty', '수량', cs.qty, '예: 16 PLT')}${hf('cx-weight', '중량', cs.weight, '예: 27,450 KG')}${hf('cx-cont', "CON'T 수량", cs.container, "예: 20' X 1")}
      </div>
      <div class="fld full" style="margin-bottom:10px"><label>적요 (통관비 항목) <span class="req">*</span></label>
        <div style="display:flex;gap:6px;font-size:11px;color:var(--t3);font-weight:600;padding:0 2px 4px"><div style="flex:2">항목</div><div style="flex:1.3;text-align:right">공급가액</div><div style="flex:1.3;text-align:right">부가세</div><div style="flex:1.4">비고</div><div style="width:28px"></div></div>
        <div id="cx-rows">${rowsHtml}</div>
        <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addCustomsRow()"><i class="ti ti-plus"></i>항목 추가</button>
      </div>
      <div class="fld full" style="margin-bottom:10px"><label>비고</label><textarea id="cx-memo" lang="ko" style="min-height:54px">${esc(editing ? (v.memo || '') : (v.memo || '※ 상기 금액은 예상 청구 금액이며 환율변동과 세관검사시 합계 금액이 변경될 수 있습니다.'))}</textarea></div>
      <div style="background:var(--soft);border-radius:11px;padding:12px 14px;max-width:380px;margin-left:auto">
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:5px"><span style="color:var(--t2)">공급가액 합계</span><b id="cx-supply">0</b></div>
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:7px"><span style="color:var(--t2)">부가세 합계</span><b id="cx-vat">0</b></div>
        <div style="display:flex;justify-content:space-between;font-size:17px;border-top:1px solid var(--bd2);padding-top:8px"><span style="font-weight:700">총 합계</span><b id="cx-total" style="color:var(--gd)">0</b></div>
      </div>
      <div class="frm-foot" style="margin-top:13px">${editing ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="delQuote('${q.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="quoteCancel()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitCustomsQuote('${editing ? q.id : ''}')"><i class="ti ti-check"></i>${editing ? '저장' : '통관 견적 저장'}</button></div>
    </div>`;
  customsRecalc();
}
async function submitCustomsQuote(id) {
  const client = (el('cx-client') && el('cx-client').value || '').trim(); if (!client) { toast('거래처를 입력하세요'); return; }
  const lines = []; let sup = 0, vat = 0;
  document.querySelectorAll('#cx-rows .cx-row').forEach(r => { const name = (r.querySelector('.cx-name').value || '').trim(); const sv = _numv(r.querySelector('.cx-supply').value); const vv = _numv(r.querySelector('.cx-vat').value); const note = (r.querySelector('.cx-note').value || '').trim(); if (name && (sv > 0 || vv > 0 || note)) { lines.push({ name: name, supply: sv, vat: vv, note: note, amt: sv + vv }); sup += sv; vat += vv; } });
  if (!lines.length) { toast('통관 항목(금액)을 입력하세요'); return; }
  const g = fid => { const e = el(fid); return e ? e.value.trim() : ''; };
  const customs = { vessel: g('cx-vessel'), arriveDate: g('cx-arrive'), blNo: g('cx-bl'), product: g('cx-product'), port: g('cx-port'), invoiceAmt: g('cx-invoice'), exRate: g('cx-rate'), assessedPrice: g('cx-assessed'), qty: g('cx-qty'), weight: g('cx-weight'), container: g('cx-cont') };
  const date = g('cx-date') || todayStr(); const memo = (el('cx-memo') && el('cx-memo').value || '').trim(); const total = sup + vat;
  if (_busy) return; _busy = true;
  try {
    await ensureClient(client);
    const q = id ? (state.quotes || []).find(x => x.id === id) : null;
    const docNo = (q && q.docNo) || quoteNextDocNo();
    const data = { docNo: docNo, client: client, category: '통관비용', customs: customs, ctype: '별도', date: date, items: lines, supply: sup, vat: vat, total: total, memo: memo, by: (el('q-staff') && el('q-staff').value.trim()) || (me && me.name) || '', createdAt: (q && q.createdAt) || Date.now(), updatedAt: Date.now() };
    if (id) await Store.update('quotes', id, data); else await Store.add('quotes', data);
    filters.quoteEdit = ''; filters.quoteCat = ''; toast('통관 견적 저장됨'); renderQuote();
  } finally { setTimeout(() => { _busy = false; }, 500); }
}
function customsDocHtml(q) {
  const e = s => esc(s == null ? '' : String(s)); const co = companyInfo(); const cs = q.customs || {};
  const items = q.items || []; const MIN = Math.max(13, items.length);
  let rows = items.map(it => `<tr><td class="l">${e(it.name)}</td><td class="r">${it.supply ? fmtWon(it.supply) : ''}</td><td class="r">${it.vat ? fmtWon(it.vat) : ''}</td><td class="l">${e(it.note || '')}</td></tr>`).join('');
  for (let i = items.length; i < MIN; i++) rows += `<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>`;
  const ic = (k, val) => `<td class="ik">${e(k)}</td><td class="iv">${e(val)}</td>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>통관비견적 ${e(q.client)} ${e(q.docNo)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/static/pretendard.min.css">
<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}
@page{size:A4;margin:8mm}
#page{width:718px;height:1047px;overflow:hidden;position:relative;margin:0 auto;background:#fff}
#sheet{width:718px;padding:24px 26px;transform-origin:top left;font-family:'Pretendard Variable',Pretendard,'맑은 고딕','Malgun Gothic',sans-serif;color:#1c1c1c;font-size:12px}
.chead{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #201c17;padding-bottom:10px}
.chead img{height:40px;display:block}
.ctitle h1{margin:0;font-size:23px;font-weight:800;letter-spacing:5px;color:#201c17;text-align:right}
.cmeta{display:flex;justify-content:space-between;font-size:11px;color:#777;margin:9px 0 13px}.cmeta b{color:#222}
.itbl{border-collapse:collapse;width:100%;margin-bottom:13px;table-layout:fixed}
.itbl td{border:1px solid #b6ab95;padding:6px 9px;font-size:11.5px}
.itbl .ik{background:#f6f1e8;font-weight:700;width:13%;white-space:nowrap;color:#7a6531}.itbl .iv{width:24%}
.atbl{border-collapse:collapse;width:100%;table-layout:fixed;border-top:2px solid #201c17}
.atbl th{background:#201c17;color:#f3ece0;font-weight:600;font-size:11.5px;padding:8px 6px}
.atbl td{border:1px solid #e0d8c8;padding:6px 9px;font-size:11.5px;height:25px}
.atbl td.l{text-align:left}.atbl td.r{text-align:right}
.total{margin-top:13px;border:2px solid #201c17;display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:#faf7f1}
.total .lb{font-weight:800;font-size:15px;letter-spacing:7px;color:#201c17}.total .vv{font-weight:800;font-size:20px;color:#0F6E56}
.foot{margin-top:13px;font-size:10.5px;color:#666;line-height:1.6}
@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
<div id="page"><div id="sheet">
  <div class="chead"><div><img src="${DAWOO_LOGO}" alt=""></div><div class="ctitle"><h1>통관비 예상 견적서</h1></div></div>
  <div class="cmeta"><span>견적번호 <b>${e(q.docNo)}</b></span><span>DATE : <b>${e(q.date)}</b></span></div>
  <table class="itbl">
    <tr>${ic('TO', q.client)}${ic('주간환율', cs.exRate)}</tr>
    <tr>${ic('선 명', cs.vessel)}${ic('도착항', cs.port)}</tr>
    <tr>${ic('입항일', cs.arriveDate)}${ic('수 량', cs.qty)}</tr>
    <tr>${ic('B/L NO', cs.blNo)}${ic('중 량', cs.weight)}</tr>
    <tr>${ic('품 명', cs.product)}${ic("CON'T 수량", cs.container)}</tr>
    <tr>${ic('AMOUNT', cs.invoiceAmt)}${ic('감정가격', cs.assessedPrice)}</tr>
  </table>
  <table class="atbl"><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup>
    <thead><tr><th>적 요</th><th>공급가액</th><th>부가세</th><th>비고</th></tr></thead>
    <tbody>${rows}
      <tr><td class="l" style="font-weight:700;background:#f6f1e8">합 계</td><td class="r" style="font-weight:700;background:#f6f1e8">${fmtWon(q.supply)}</td><td class="r" style="font-weight:700;background:#f6f1e8">${fmtWon(q.vat)}</td><td style="background:#f6f1e8"></td></tr>
    </tbody>
  </table>
  <div class="total"><span class="lb">총 합 계</span><span class="vv">₩ ${fmtWon(q.total)}</span></div>
  ${q.memo ? `<div class="foot">${e(q.memo)}</div>` : ''}
  <div class="foot">공급자 : ${e(co.name)} · 대표 ${e(co.ceo)} · 사업자 ${e(co.bizno)} · ${e(co.tel)}</div>
</div></div>
<script>window.addEventListener('load',function(){var s=document.getElementById('sheet');var a=1047;if(s&&s.scrollHeight>a){s.style.transform='scale('+(a/s.scrollHeight)+')';}});</script>
</body></html>`;
}
function qDate(q) { return q.date || (q.createdAt ? new Date(+q.createdAt).toISOString().slice(0, 10) : ''); }
function quoteMonthNav(delta) { const cur = filters.quoteMonth || todayStr().slice(0, 7); const p = cur.split('-').map(Number); const d = new Date(p[0], p[1] - 1 + delta, 1); filters.quoteMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); renderQuote(); }
function quoteCardHtml(q) {
  const when = qDate(q);
  const _hasBasin = (q.items || []).some(it => (it.name || '').includes('세면대'));
  const _hasGagong = (q.items || []).some(it => marginCat(it.name) === '가공');
  const _regLabel = _hasBasin ? '세면대 발주' : (_hasGagong ? '현장 등록' : '출고 등록');
  const _regIcon = _hasBasin ? 'ti-bath' : (_hasGagong ? 'ti-building-community' : 'ti-truck-delivery');
  const names = (q.items || []).map(it => it.name).filter(Boolean).slice(0, 3).join(', ') + ((q.items || []).length > 3 ? ` 외 ${q.items.length - 3}` : '');
  const _pa = +q.paidAmount || 0; const _tt = +q.total || 0; const _rem = Math.max(0, _tt - _pa);
  const paidPill = (_tt > 0 && _pa >= _tt) ? `<button class="pill p-done" style="border:none;cursor:pointer" onclick="quoteMarkPaid('${q.id}')" title="입금 수정"><i class="ti ti-cash"></i> 결제완료</button>` : (_pa > 0 ? `<button class="pill p-prog" style="border:none;cursor:pointer" onclick="quoteMarkPaid('${q.id}')" title="입금 수정"><i class="ti ti-cash"></i> 입금 ${fmtWon(_pa)} · 미수 ${fmtWon(_rem)}</button>` : `<button class="pill p-wait" style="border:none;cursor:pointer" onclick="quoteMarkPaid('${q.id}')" title="입금 입력"><i class="ti ti-cash"></i> 미결제</button>`);
  const taxPill = q.taxInvoice ? `<button class="pill p-prog" style="border:none;cursor:pointer" onclick="quoteMarkTax('${q.id}')" title="클릭 시 해제"><i class="ti ti-file-check"></i> 계산서 발행${q.taxDate ? ' ' + esc(q.taxDate.slice(5)) : ''}</button>` : `<button class="pill p-gray" style="border:none;cursor:pointer" onclick="quoteMarkTax('${q.id}')" title="발행으로 표시"><i class="ti ti-file-off"></i> 계산서 미발행</button>`;
  const shipBadge = q.shipped ? `<span class="pill p-done"><i class="ti ti-truck-delivery"></i> 출고 완료</span>` : '';
  const siteBadge = q.siteDone ? `<span class="pill p-done"><i class="ti ti-building-community"></i> 현장 등록 완료</span>` : '';
  const basinBadge = q.basinDone ? `<span class="pill p-done"><i class="ti ti-bath"></i> 세면대 발주 완료</span>` : '';
  return `<div class="card" style="margin-bottom:10px;padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="min-width:0"><div style="font-weight:700;font-size:14.5px">${esc(q.client || '-')}</div>
          <div style="font-size:11.5px;color:var(--t3);margin-top:2px">${esc(q.docNo || '')} · ${esc(when)} · ${(q.items || []).length}품목</div>
          <div style="font-size:12px;color:var(--t2);margin-top:3px">${esc(names)}</div></div>
        <div style="text-align:right;flex:none"><div style="font-size:17px;font-weight:800;color:var(--gd)">${fmtWon(q.total)}<span style="font-size:12px;font-weight:600">원</span></div><div style="font-size:10.5px;color:var(--t3)">VAT 포함</div>${_rem > 0 ? `<div style="font-size:11px;color:var(--gd);margin-top:5px">입금 ${fmtWon(_pa)}</div><div style="font-size:13.5px;font-weight:800;color:var(--red-t)">미수 ${fmtWon(_rem)}</div>` : (_pa > 0 ? `<div style="font-size:12px;font-weight:700;color:var(--gd);margin-top:5px"><i class="ti ti-check"></i> 결제완료</div>` : '')}</div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px">${paidPill}${taxPill}${shipBadge}${siteBadge}${basinBadge}</div>
      <div class="frm-foot" style="margin-top:9px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">
        ${(q.shipped || q.siteDone || q.basinDone) ? '' : (q.ordered ? `<button class="btn btn-sm btn-pri" onclick="quoteRegister('${q.id}')"><i class="ti ${_regIcon}"></i>${_regLabel}</button><button class="btn btn-sm" style="color:var(--t3)" onclick="quoteCancelOrder('${q.id}')" title="확정 주문 취소"><i class="ti ti-arrow-back-up"></i>확정취소</button>` : `<button class="btn btn-sm btn-pri" onclick="quoteConfirmOrder('${q.id}')"><i class="ti ti-clipboard-check"></i>확정주문</button>`)}
        <button class="btn btn-sm" onclick="openQuoteInline('${q.id}')"><i class="ti ti-edit"></i>수정</button>
        <button class="btn btn-sm" onclick="printQuote('${q.id}')"><i class="ti ti-printer"></i>인쇄</button>
        <span style="display:inline-flex;gap:2px;padding-left:6px;margin-left:2px;border-left:1px solid var(--bd)">
          <button class="btn btn-sm btn-ghost" title="엑셀 저장" onclick="downloadQuoteXls('${q.id}')"><i class="ti ti-file-spreadsheet"></i></button>
          <button class="btn btn-sm btn-ghost" title="PNG 저장" onclick="downloadQuotePng('${q.id}')"><i class="ti ti-photo"></i></button>
          <button class="btn btn-sm btn-ghost" title="이미지 복사" onclick="copyQuoteImage('${q.id}')"><i class="ti ti-clipboard"></i></button>
        </span>
        ${(isAdmin() && q.ordered) ? `<button class="btn btn-sm" style="color:var(--gd)" onclick="openTaxForm('${q.id}')" title="세금계산서 발행"><i class="ti ti-file-invoice"></i>계산서</button>` : ''}
        <span style="display:inline-flex;gap:4px;margin-left:auto">
          <button class="btn btn-sm btn-ghost" onclick="openQuoteInline('${q.id}',true)" title="복사해 새 견적"><i class="ti ti-copy"></i></button>
          <button class="btn btn-sm btn-ghost" style="color:var(--red-t)" onclick="delQuote('${q.id}')" title="견적 삭제"><i class="ti ti-trash"></i></button>
        </span>
      </div></div>`;
}
let _costSupply = 0;
let _costRev = { mat: 0, proc: 0, cons: 0, trans: 0 };
function marginCat(name) { const n = name || ''; if (/운송|배송|운반|파렛트|팔레트|팔렛|파레트|빠렛/.test(n)) return '운송'; if (/재단|타공|고스라|뒷도|배면|워터젯|사선|모서리|가공|연마|코너/.test(n)) return '가공'; if (/시공|실측|설치/.test(n)) return '시공'; return '자재'; }
function quoteMarginBreakdown(q) {
  const rev = { 자재: 0, 가공: 0, 시공: 0, 운송: 0 };
  (q.items || []).forEach(it => { rev[marginCat(it.name)] += Math.round(+it.amt || 0); });
  const cost = { 자재: 0, 가공: +q.processCost || 0, 시공: 0, 운송: 0 };
  (q.costLines || []).forEach(l => { const c = +l.cost || 0; if (l.gubun === '운송') cost.운송 += c; else if (l.gubun === '시공') cost.시공 += c; else cost.자재 += c; });
  const cats = ['자재', '가공', '시공', '운송']; const out = {}; let rt = 0, ct = 0;
  cats.forEach(c => { out[c] = { rev: rev[c], cost: cost[c], margin: rev[c] - cost[c] }; rt += rev[c]; ct += cost[c]; });
  out['총'] = { rev: rt, cost: ct, margin: rt - ct };
  return out;
}
const GUBUN = ['자재', '운송', '시공', '부속', '기타'];   // 가공은 공장 견적 총액으로 별도 입력
function hebeFromSpec(spec) { const m = (spec || '').match(/(\d{3,4})\s*[*xX×]\s*(\d{3,4})/); if (m) { return +((+m[1] / 1000) * (+m[2] / 1000)).toFixed(2); } return ''; }
function costGubunOf(name) { const n = (name || ''); if (/운송|배송|운반|파렛트|팔레트|팔렛|파레트|빠렛/.test(n)) return '운송'; if (/재단|타공|고스라|뒷도|배면|워터젯|사선|모서리|가공|연마|코너/.test(n)) return '가공'; if (/시공|실측|설치/.test(n)) return '시공'; return '자재'; }
function openCostForm(id) { if (!isAdmin()) { toast('원가는 관리자만 볼 수 있습니다'); return; } filters.costEdit = id; render(); const _pg = el('pg-' + tab); if (_pg) _pg.scrollIntoView({ block: 'start' }); }
function costCancel() { filters.costEdit = ''; render(); }
function costLineHtml(d) {
  d = d || {}; const inp = 'font-size:13px;padding:6px 7px;border:1.5px solid var(--bd2);border-radius:7px';
  return `<div class="ct-row" style="display:flex;gap:5px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
    <select class="ct-gubun" onchange="costRecalc()" style="${inp};flex:none;width:66px">${GUBUN.map(g => `<option ${d.gubun === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
    <input class="ct-name" placeholder="품목명" value="${esc(d.name || '')}" style="${inp};flex:2;min-width:90px" lang="ko">
    <input class="ct-spec" placeholder="규격" value="${esc(d.spec || '')}" style="${inp};flex:1;min-width:64px" lang="en">
    <input class="ct-hebe" inputmode="decimal" placeholder="헤베" value="${esc(d.hebe || '')}" oninput="costRecalc()" style="${inp};flex:none;width:52px;text-align:right">
    <input class="ct-qty" inputmode="numeric" placeholder="수량" value="${esc(d.qty || '')}" oninput="costRecalc()" style="${inp};flex:none;width:48px;text-align:right">
    <input class="ct-unit" inputmode="numeric" placeholder="원가단가" value="${esc(d.unitCost || '')}" oninput="costRecalc()" style="${inp};flex:none;width:76px;text-align:right">
    <input class="ct-cost" inputmode="numeric" placeholder="원가" value="${esc(d.cost || '')}" oninput="costRecalc()" style="${inp};flex:none;width:88px;text-align:right;background:#fff6f6;font-weight:700">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.ct-row').remove();costRecalc()"><i class="ti ti-x"></i></button>
  </div>`;
}
function addCostRow() { const c = el('ct-rows'); if (c) c.insertAdjacentHTML('beforeend', costLineHtml({ gubun: '자재' })); }
function costRecalc() {
  let cMat = 0, cCons = 0, cTrans = 0;
  document.querySelectorAll('#ct-rows .ct-row').forEach(r => {
    const g = r.querySelector('.ct-gubun').value;
    const hebe = _numv(r.querySelector('.ct-hebe').value), qty = _numv(r.querySelector('.ct-qty').value), unit = _numv(r.querySelector('.ct-unit').value);
    const costEl = r.querySelector('.ct-cost');
    if (g === '자재' && hebe > 0 && qty > 0 && unit > 0) { costEl.value = Math.round(hebe * qty * unit); }
    const c = _numv(costEl.value);
    if (g === '운송') cTrans += c; else if (g === '시공') cCons += c; else cMat += c;
  });
  const proc = el('ct-process') ? _numv(el('ct-process').value) : 0;
  const cost = { mat: cMat, proc: proc, cons: cCons, trans: cTrans };
  const setCat = (k) => { const m = (_costRev[k] || 0) - cost[k]; if (el('cc_' + k)) el('cc_' + k).textContent = fmtWon(cost[k]); const me = el('cm_' + k); if (me) { me.textContent = fmtWon(m); me.style.color = m < 0 ? 'var(--red-t)' : 'var(--gd)'; } };
  setCat('mat'); setCat('proc'); setCat('cons'); setCat('trans');
  const totCost = cMat + proc + cCons + cTrans;
  const margin = _costSupply - totCost;
  if (el('ct-total')) el('ct-total').textContent = fmtWon(totCost);
  if (el('ct-margin')) { el('ct-margin').textContent = fmtWon(margin); el('ct-margin').style.color = margin < 0 ? 'var(--red-t)' : 'var(--gd)'; }
  if (el('ct-rate')) el('ct-rate').textContent = _costSupply > 0 ? ((margin / _costSupply * 100).toFixed(1) + '%') : '-';
}
function renderCostForm() {
  const q = (state.quotes || []).find(x => x.id === filters.costEdit); if (!q) { filters.costEdit = ''; render(); return; }
  _costSupply = +q.supply || 0;
  _costRev = { mat: 0, proc: 0, cons: 0, trans: 0 };
  (q.items || []).forEach(it => { const c = marginCat(it.name); const k = c === '가공' ? 'proc' : c === '시공' ? 'cons' : c === '운송' ? 'trans' : 'mat'; _costRev[k] += Math.round(+it.amt || 0); });
  const _procItems = (q.items || []).filter(it => costGubunOf(it.name) === '가공');
  const lines = (q.costLines && q.costLines.length) ? q.costLines : (q.items || []).filter(it => costGubunOf(it.name) !== '가공').map(it => ({ gubun: costGubunOf(it.name), factory: '', name: it.name, spec: it.spec || '', hebe: hebeFromSpec(it.spec || ''), qty: it.qty || '', unitCost: '', cost: '' }));
  const rows = lines.map(costLineHtml).join('');
  el('pg-' + tab).innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-calculator"></i>원가 정리</h2><p>${esc(q.docNo || '')} · ${esc(q.client || '')} · 매출 ${fmtWon(q.supply)}</p></div>
      <button class="btn btn-sm" onclick="costCancel()"><i class="ti ti-arrow-left"></i> 목록</button></div>
    <div id="cost-root" class="card" style="padding:14px 16px">
      <div style="font-size:11px;color:var(--t3);margin-bottom:8px">자재: 헤베×수량×원가단가 자동 · 가공비는 <b>공장 견적 총액</b>으로 아래에 입력 · 운송/부속/기타는 직접 입력 · <b style="color:#c0341d">관리자 전용</b></div>
      <div style="display:flex;gap:5px;font-size:10.5px;color:var(--t3);font-weight:600;padding:0 2px 4px;flex-wrap:wrap"><div style="width:66px">구분</div><div style="flex:2;min-width:90px">품목명</div><div style="flex:1;min-width:64px">규격</div><div style="width:52px;text-align:right">헤베</div><div style="width:48px;text-align:right">수량</div><div style="width:76px;text-align:right">원가단가</div><div style="width:88px;text-align:right">원가</div><div style="width:28px"></div></div>
      <div id="ct-rows">${rows}</div>
      <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addCostRow()"><i class="ti ti-plus"></i>자재·운송 등 항목 추가</button>
      <div style="background:#fff6ee;border:1.5px solid #f0d6b8;border-radius:11px;padding:11px 13px;margin-top:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="min-width:0"><div style="font-size:13px;font-weight:700;color:#a2560f"><i class="ti ti-tools"></i> 가공비 (공장 견적 총액)</div>
            <div style="font-size:11px;color:var(--t3);margin-top:3px;line-height:1.5">견적서 가공 항목은 공장과 미터수·내용이 달라 항목별 대신 <b>공장에서 받은 견적 총액</b>을 그대로 입력하세요.${_procItems.length ? '<br>견적서상 가공: ' + esc(_procItems.map(x => x.name).join(', ')) : ''}</div></div>
          <input id="ct-process" inputmode="numeric" value="${esc(q.processCost || '')}" oninput="costRecalc()" placeholder="0" style="width:140px;text-align:right;font-size:16px;font-weight:800;padding:9px 11px;border:1.5px solid #e6bf93;border-radius:9px;background:#fff;color:#a2560f">
        </div>
      </div>
      <div style="background:var(--soft);border-radius:11px;padding:12px 14px;margin-top:12px;max-width:460px;margin-left:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="color:var(--t3);font-size:11px"><th style="text-align:left;padding:2px 4px">분류</th><th style="text-align:right;padding:2px 4px">매출</th><th style="text-align:right;padding:2px 4px">원가</th><th style="text-align:right;padding:2px 4px">마진</th></tr></thead>
          <tbody>
            <tr><td style="padding:3px 4px">자재</td><td style="text-align:right">${fmtWon(_costRev.mat)}</td><td style="text-align:right;color:#b45309"><span id="cc_mat">0</span></td><td style="text-align:right;font-weight:700"><span id="cm_mat">0</span></td></tr>
            <tr><td style="padding:3px 4px">가공</td><td style="text-align:right">${fmtWon(_costRev.proc)}</td><td style="text-align:right;color:#b45309"><span id="cc_proc">0</span></td><td style="text-align:right;font-weight:700"><span id="cm_proc">0</span></td></tr>
            <tr><td style="padding:3px 4px">시공</td><td style="text-align:right">${fmtWon(_costRev.cons)}</td><td style="text-align:right;color:#b45309"><span id="cc_cons">0</span></td><td style="text-align:right;font-weight:700"><span id="cm_cons">0</span></td></tr>
            <tr><td style="padding:3px 4px">운송</td><td style="text-align:right">${fmtWon(_costRev.trans)}</td><td style="text-align:right;color:#b45309"><span id="cc_trans">0</span></td><td style="text-align:right;font-weight:700"><span id="cm_trans">0</span></td></tr>
          </tbody>
          <tfoot><tr style="border-top:1.5px solid var(--bd2);font-size:14px"><td style="padding:5px 4px;font-weight:800">총</td><td style="text-align:right;font-weight:700">${fmtWon(q.supply)}</td><td style="text-align:right;font-weight:700;color:#b45309"><span id="ct-total">0</span></td><td style="text-align:right;font-weight:800"><span id="ct-margin" style="color:var(--gd)">0</span></td></tr></tfoot>
        </table>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--t3);margin-top:6px"><span>가공 원가 = 공장 견적 총액</span><span>총마진율 <b id="ct-rate">-</b></span></div>
      </div>
      <div class="frm-foot" style="margin-top:12px"><button class="btn" style="flex:1" onclick="costCancel()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitCost('${q.id}')"><i class="ti ti-check"></i>원가 저장</button></div>
    </div>`;
  costRecalc();
}
async function submitCost(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) return;
  const lines = [];
  document.querySelectorAll('#ct-rows .ct-row').forEach(r => { const name = (r.querySelector('.ct-name').value || '').trim(); const cost = _numv(r.querySelector('.ct-cost').value); if (name || cost > 0) { lines.push({ gubun: r.querySelector('.ct-gubun').value, factory: '', name: name, spec: (r.querySelector('.ct-spec').value || '').trim(), hebe: _numv(r.querySelector('.ct-hebe').value) || '', qty: _numv(r.querySelector('.ct-qty').value) || '', unitCost: _numv(r.querySelector('.ct-unit').value) || '', cost: cost }); } });
  const processCost = el('ct-process') ? _numv(el('ct-process').value) : 0;
  const costTotal = lines.reduce((a, b) => a + (+b.cost || 0), 0) + processCost; const sup = +q.supply || 0; const margin = sup - costTotal;
  await Store.update('quotes', id, { costLines: lines, processCost: processCost, costTotal: costTotal, margin: margin, marginRate: sup > 0 ? +(margin / sup).toFixed(4) : 0 });
  filters.costEdit = ''; toast('원가 저장 · 마진 ' + fmtWon(margin)); render();
}
function downloadCostLedger() {
  if (!isAdmin()) { toast('관리자만'); return; }
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후'); return; }
  const qs = (state.quotes || []).filter(q => (q.costLines && q.costLines.length) || (+q.processCost || 0) > 0).sort((a, b) => (qDate(a) || '').localeCompare(qDate(b) || ''));
  if (!qs.length) { toast('원가 입력된 견적이 없습니다'); return; }
  const head = ['날짜', '거래처', '전표', '구분', '공장', '품목명', '규격', '헤베수', '수량', '원가단가', '원가', '매출액', '마진', '마진율'];
  const aoa = [['견적서(현장)별 원가·마진 원장'], ['출력일 ' + todayStr()], [], head];
  let tSup = 0, tCost = 0;
  qs.forEach(q => {
    const sup = +q.supply || 0; const pc = +q.processCost || 0; const ct = (q.costLines || []).reduce((a, b) => a + (+b.cost || 0), 0) + pc; tSup += sup; tCost += ct;
    (q.costLines || []).forEach(l => { aoa.push([qDate(q), q.client || '', q.docNo || '', l.gubun || '', l.factory || '', l.name || '', l.spec || '', l.hebe || '', l.qty || '', l.unitCost || '', +l.cost || 0, '', '', '']); });
    if (pc > 0) aoa.push([qDate(q), q.client || '', q.docNo || '', '가공', '공장견적', '가공비(공장 견적 총액)', '', '', '', '', pc, '', '', '']);
    const mg = sup - ct; aoa.push(['', '', q.docNo || '', '소계', '', '▣ ' + (q.client || '') + ' / ' + (q.docNo || ''), '', '', '', '', ct, sup, mg, sup > 0 ? +(mg / sup).toFixed(4) : 0]); aoa.push([]);
  });
  aoa.push(['', '', '', '총계', '', '', '', '', '', '', tCost, tSup, tSup - tCost, tSup > 0 ? +((tSup - tCost) / tSup).toFixed(4) : 0]);
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 11 }, { wch: 18 }, { wch: 12 }, { wch: 7 }, { wch: 8 }, { wch: 24 }, { wch: 16 }, { wch: 7 }, { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '원가원장'); XLSX.writeFile(wb, '원가원장_' + todayStr() + '.xlsx');
  toast('원가 원장 엑셀 다운로드');
}
/* ================= 정산: 원가 원장 · 회사지출 · 영업이익(마진) ================= */
const EXP_CATS = ['급여', '공용부분', '운반비', '공과금', '상여금', '복리후생', '접대비', '소모품', '수선비', '기타'];
const FIXED_CATS = ['급여', '공용부분', '운반비', '공과금', '기타'];   // 매월 고정
const VAR_CATS = ['상여금', '복리후생', '접대비', '소모품', '수선비', '운반비', '기타'];   // 변동성 지출
function settleMonthNav(d) {
  const ym = filters.settleMonth || todayStr().slice(0, 7);
  const [y, m] = ym.split('-').map(Number); const dt = new Date(y, m - 1 + d, 1);
  filters.settleMonth = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); renderSettle();
}
async function addExpense() {
  if (!isAdmin()) { toast('관리자만'); return; }
  const date = (el('exp-date').value || todayStr()), cat = el('exp-cat').value, name = (el('exp-name').value || '').trim(),
    mgr = (el('exp-mgr').value || '').trim(), amt = Math.round(+el('exp-amt').value || 0), status = el('exp-status').value, note = (el('exp-note').value || '').trim();
  if (!name) { toast('항목명을 입력하세요'); return; }
  if (!amt) { toast('금액을 입력하세요'); return; }
  await Store.add('expenses', { date, cat, name, manager: mgr, amount: amt, status, note, createdAt: Date.now() });
  toast('지출 등록됨'); renderSettle();
}
async function delExpense(id) { if (!isAdmin()) { toast('관리자만'); return; } if (!confirm('이 지출 항목을 삭제할까요?')) return; await Store.remove('expenses', id); toast('삭제됨'); renderSettle(); }
function downloadExpenses() {
  if (!isAdmin()) { toast('관리자만'); return; }
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후'); return; }
  const ym = filters.settleMonth || todayStr().slice(0, 7);
  const rows = (state.expenses || []).filter(e => (e.date || '').startsWith(ym)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!rows.length) { toast(ym + ' 지출 내역이 없습니다'); return; }
  const head = ['결재일', '분류', '항목', '담당자', '금액', '상태', '설명'];
  const aoa = [['회사지출 내역 · ' + ym], ['출력일 ' + todayStr()], [], head];
  let tot = 0; rows.forEach(e => { tot += +e.amount || 0; aoa.push([e.date || '', e.cat || '', e.name || '', e.manager || '', +e.amount || 0, e.status || '', e.note || '']); });
  aoa.push([]); aoa.push(['', '', '', '합계', tot, '', '']);
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 13 }, { wch: 9 }, { wch: 24 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '회사지출'); XLSX.writeFile(wb, '회사지출_' + ym + '.xlsx');
  toast('회사지출 엑셀 다운로드');
}
/* ===== 고정 지출 항목 (매월 반복) ===== */
function fixedExpenses() { const m = (state.appmeta || []).find(x => x.key === 'fixedExpenses'); return (m && Array.isArray(m.items)) ? m.items : []; }
async function saveFixedExpenses(items) { const m = (state.appmeta || []).find(x => x.key === 'fixedExpenses'); if (m) await Store.update('appmeta', m.id, { items }); else await Store.add('appmeta', { key: 'fixedExpenses', items }); }
async function addFixedItem() {
  if (!isAdmin()) { toast('관리자만'); return; }
  const cat = el('fx-cat').value, name = (el('fx-name').value || '').trim(), amt = Math.round(+el('fx-amt').value || 0);
  if (!name) { toast('항목명을 입력하세요'); return; }
  const items = fixedExpenses().slice(); items.push({ cat, name, amount: amt }); await saveFixedExpenses(items); toast('고정항목 추가됨'); renderSettle();
}
async function delFixedItem(idx) { if (!isAdmin()) { toast('관리자만'); return; } const items = fixedExpenses().slice(); if (!confirm((items[idx] ? items[idx].name : '') + ' 고정항목을 삭제할까요?')) return; items.splice(idx, 1); await saveFixedExpenses(items); toast('삭제됨'); renderSettle(); }
async function saveFixedAmt(idx, val) { const items = fixedExpenses().slice(); if (items[idx]) { items[idx].amount = Math.round(+val || 0); await saveFixedExpenses(items); } }
async function applyFixedToMonth() {
  if (!isAdmin()) { toast('관리자만'); return; }
  const ym = filters.settleMonth || todayStr().slice(0, 7);
  const items = fixedExpenses();
  if (!items.length) { toast('고정 지출 항목을 먼저 등록하세요'); return; }
  const existing = (state.expenses || []).filter(e => (e.date || '').startsWith(ym) && e.fixed);
  let added = 0;
  for (const it of items) {
    if (existing.some(e => e.name === it.name && e.cat === it.cat)) continue;
    await Store.add('expenses', { date: ym + '-01', cat: it.cat, name: it.name, amount: +it.amount || 0, status: '정산중', note: '고정지출', fixed: true, createdAt: Date.now() });
    added++;
  }
  toast(added > 0 ? (added + '개 고정지출 반영됨') : '이번 달은 이미 모두 반영됨'); renderSettle();
}

/* ===== 시공비 정산 (시공팀별 · 현장별) ===== */
async function saveCrewFee(id, val) { if (!isAdmin()) { toast('관리자만'); return; } const amt = Math.round(_numv(val)); try { await Store.update('sites', id, { crewFee: amt }); } catch (e) { } }
async function toggleCrewPaid(id) {
  if (!isAdmin()) { toast('관리자만'); return; }
  const s = (state.sites || []).find(x => x.id === id); if (!s) return;
  const paid = !s.crewPaid;
  try { await Store.update('sites', id, { crewPaid: paid, crewPaidDate: paid ? todayStr() : '' }); } catch (e) { }
  toast(paid ? '시공비 정산 완료 표시' : '미정산으로 변경'); renderSettle();
}
function crewToggleUnpaid() { filters.crewUnpaidOnly = !filters.crewUnpaidOnly; renderSettle(); }
function downloadCrewLedger() {
  if (!isAdmin()) { toast('관리자만'); return; }
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후'); return; }
  const sites = (state.sites || []).filter(s => (s.team || '').trim()).sort((a, b) => (a.team || '').localeCompare(b.team || '') || (b.constructDate || '').localeCompare(a.constructDate || ''));
  if (!sites.length) { toast('시공팀 지정된 현장이 없습니다'); return; }
  const head = ['시공팀', '현장', '거래처', '시공일', '시공비', '정산여부', '정산일'];
  const aoa = [['시공비 정산 원장 (시공팀별)'], ['출력일 ' + todayStr()], [], head];
  let tPaid = 0, tUnpaid = 0;
  sites.forEach(s => { const fee = +s.crewFee || 0; if (s.crewPaid) tPaid += fee; else tUnpaid += fee; aoa.push([s.team || '', s.name || '', s.client || '', s.constructDate || '', fee, s.crewPaid ? '정산완료' : '미정산', s.crewPaidDate || '']); });
  aoa.push([]); aoa.push(['', '', '', '정산완료 합계', tPaid, '', '']); aoa.push(['', '', '', '미정산 합계', tUnpaid, '', '']);
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 12 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '시공비정산'); XLSX.writeFile(wb, '시공비정산_' + todayStr() + '.xlsx');
  toast('시공비 정산 엑셀 다운로드');
}
function crewSettleCard() {
  const sites = (state.sites || []).filter(s => (s.team || '').trim());
  const totUnpaid = sites.filter(s => !s.crewPaid).reduce((a, s) => a + (+s.crewFee || 0), 0);
  const totPaid = sites.filter(s => s.crewPaid).reduce((a, s) => a + (+s.crewFee || 0), 0);
  const onlyUnpaid = !!filters.crewUnpaidOnly;
  const byTeam = {}; sites.forEach(s => { const t = (s.team || '미지정'); (byTeam[t] = byTeam[t] || []).push(s); });
  const teams = Object.keys(byTeam).sort((a, b) => a.localeCompare(b));
  const inp = 'width:110px;text-align:right;font-size:13px;padding:6px 8px;border:1.5px solid var(--bd2);border-radius:8px';
  const blocks = teams.map(t => {
    let list = byTeam[t].slice().sort((a, b) => (b.constructDate || '').localeCompare(a.constructDate || ''));
    if (onlyUnpaid) list = list.filter(s => !s.crewPaid);
    if (!list.length) return '';
    const tUnpaid = byTeam[t].filter(s => !s.crewPaid).reduce((a, s) => a + (+s.crewFee || 0), 0);
    const tPaid = byTeam[t].filter(s => s.crewPaid).reduce((a, s) => a + (+s.crewFee || 0), 0);
    const rows = list.map(s => {
      const fee = +s.crewFee || 0;
      return `<tr style="border-bottom:1px solid var(--soft)">
        <td style="padding:6px 8px">${esc((s.constructDate || '').slice(5))}</td>
        <td style="padding:6px 8px"><div style="font-weight:600">${esc(s.client || s.name || '')}</div><div style="font-size:10.5px;color:var(--t3)">${esc(s.name || '')}</div></td>
        <td style="padding:6px 8px;text-align:right"><input inputmode="numeric" value="${fee || ''}" onchange="saveCrewFee('${s.id}',this.value)" placeholder="시공비" style="${inp}"></td>
        <td style="padding:6px 8px;text-align:center"><button class="btn btn-sm ${s.crewPaid ? 'btn-pri' : ''}" style="${s.crewPaid ? 'background:#0f766e;border-color:#0f766e' : 'color:#b45309'}" onclick="toggleCrewPaid('${s.id}')">${s.crewPaid ? '정산완료' : '미정산'}</button></td>
        <td style="padding:6px 8px;text-align:center;font-size:11px;color:var(--t3)">${s.crewPaid ? esc(s.crewPaidDate || '') : '-'}</td>
      </tr>`;
    }).join('');
    return `<div style="margin-top:10px"><div style="display:flex;align-items:center;justify-content:space-between;background:var(--soft);border-radius:8px;padding:6px 10px;margin-bottom:4px">
        <b style="font-size:13px">${esc(t)}${isSelfTeam(t) ? ' <span style="font-size:10px;color:var(--t3);font-weight:500">(자체)</span>' : ''}</b>
        <span style="font-size:11.5px;color:var(--t3)">미정산 <b style="color:#c0341d">${fmtWon(tUnpaid)}</b> · 완료 <b style="color:#0f766e">${fmtWon(tPaid)}</b></span></div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr style="color:var(--t2);font-size:11px"><th style="padding:4px 8px;text-align:left">시공일</th><th style="padding:4px 8px;text-align:left">현장</th><th style="padding:4px 8px;text-align:right">시공비</th><th style="padding:4px 8px;text-align:center">정산</th><th style="padding:4px 8px;text-align:center">정산일</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
  return `<div class="card" style="margin-bottom:12px;padding:13px 14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
      <div style="font-size:11.5px;color:var(--t3);font-weight:700"><i class="ti ti-hammer"></i> 시공비 정산 (시공팀별 · 현장별)</div>
      <div style="display:flex;gap:6px"><button class="btn btn-sm ${onlyUnpaid ? 'btn-pri' : ''}" onclick="crewToggleUnpaid()">미정산만</button><button class="btn btn-sm" onclick="downloadCrewLedger()"><i class="ti ti-download"></i>엑셀</button></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:6px">
      <div style="text-align:center;padding:8px;background:#fdf0ea;border-radius:9px"><div style="font-size:10.5px;color:var(--t2)">미정산 합계</div><div style="font-size:15px;font-weight:800;color:#c0341d">${fmtWon(totUnpaid)}</div></div>
      <div style="text-align:center;padding:8px;background:#eefaf5;border-radius:9px"><div style="font-size:10.5px;color:var(--t2)">정산완료 합계</div><div style="font-size:15px;font-weight:800;color:#0f766e">${fmtWon(totPaid)}</div></div>
    </div>
    <div data-keepscroll id="settle-crew-list" style="max-height:50vh;overflow:auto">${blocks || `<div style="font-size:12px;color:var(--t3);text-align:center;padding:14px">${onlyUnpaid ? '미정산 현장이 없습니다' : '시공팀이 지정된 현장이 없습니다'}</div>`}</div>
  </div>`;
}

function renderSettle() {
  const root = el('pg-settle'); if (!root) return;
  if (filters.costEdit) { if (!document.getElementById('cost-root')) renderCostForm(); return; }   // 원가 입력 폼(관리자)
  if (!tabAllowed('settle')) { root.innerHTML = `<div class="ph"><div><h2><i class="ti ti-report-money"></i>정산</h2></div></div><div class="empty"><i class="ti ti-lock"></i>정산·원가·마진은 관리자 또는 접근 권한이 있는 직원만 열람할 수 있습니다.</div>`; return; }
  const ym = filters.settleMonth || todayStr().slice(0, 7);
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const monthQuotes = (state.quotes || []).filter(q => qDate(q).startsWith(ym));
  const salesAll = monthQuotes.reduce((a, q) => a + (+q.supply || 0), 0);
  const costed = monthQuotes.filter(q => (+q.costTotal || 0) > 0 || (q.costLines && q.costLines.length));
  const salesCosted = costed.reduce((a, q) => a + (+q.supply || 0), 0);
  const costSum = costed.reduce((a, q) => a + ((+q.costTotal) || (q.costLines || []).reduce((x, l) => x + (+l.cost || 0), 0)), 0);
  const grossProfit = salesCosted - costSum;
  const expMonth = (state.expenses || []).filter(e => (e.date || '').startsWith(ym));
  const expSum = expMonth.reduce((a, e) => a + (+e.amount || 0), 0);
  const opProfit = grossProfit - expSum;
  const noCost = monthQuotes.length - costed.length;
  const grossRate = salesCosted > 0 ? Math.round(grossProfit / salesCosted * 100) : 0;
  const opRate = salesAll > 0 ? Math.round(opProfit / salesAll * 100) : 0;
  // 회사지출 분류별
  const expByCat = {}; expMonth.forEach(e => { const c = e.cat || '기타'; expByCat[c] = (expByCat[c] || 0) + (+e.amount || 0); }); const _catKeys = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]);
  const monthBar = `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--soft);border-radius:11px;padding:8px 12px;margin-bottom:12px">
    <button class="btn btn-sm" onclick="settleMonthNav(-1)"><i class="ti ti-chevron-left"></i></button>
    <div style="text-align:center"><div style="font-weight:800;font-size:15.5px">${esc(ym.replace('-', '. '))} 정산</div><div style="font-size:11.5px;color:var(--t3)">견적 ${monthQuotes.length}건 · 지출 ${expMonth.length}건</div></div>
    <button class="btn btn-sm" onclick="settleMonthNav(1)"><i class="ti ti-chevron-right"></i></button></div>`;
  const pnlCell = (lab, val, color, sub) => `<div style="padding:10px 8px;background:var(--soft);border-radius:10px;text-align:center"><div style="font-size:10.5px;color:var(--t2);margin-bottom:3px">${lab}</div><div style="font-size:15px;font-weight:800;color:${color}">${fmtWon(val)}</div>${sub ? `<div style="font-size:10px;color:var(--t3);margin-top:1px">${sub}</div>` : ''}</div>`;
  const pnl = `<div class="card" style="margin-bottom:12px;padding:13px 14px">
    <div style="font-size:11.5px;color:var(--t3);font-weight:700;margin-bottom:9px"><i class="ti ti-chart-bar"></i> 영업이익 요약 (${esc(ym)})</div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px">
      ${pnlCell('매출(공급가)', salesAll, 'var(--gd)', monthQuotes.length + '건')}
      ${pnlCell('원가', costSum, '#b45309', '원가입력 ' + costed.length + '건')}
      ${pnlCell('매출총이익', grossProfit, grossProfit >= 0 ? '#0f766e' : '#dc2626', '마진율 ' + grossRate + '%')}
      ${pnlCell('회사지출', expSum, '#7c3aed', expMonth.length + '건')}
      ${pnlCell('영업이익', opProfit, opProfit >= 0 ? '#0f766e' : '#dc2626', '이익률 ' + opRate + '%')}
    </div>
    <div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5">· 매출총이익 = 원가 입력된 견적의 (매출 − 원가) 기준 · 영업이익 = 매출총이익 − 회사지출${noCost > 0 ? `<br>· <b style="color:#dc2626">원가 미입력 견적 ${noCost}건</b> — 아래 <b>원가 원장</b>의 입력 버튼으로 입력하면 마진에 반영됩니다` : ''}</div>
  </div>`;
  const expCatBar = `<div class="card" style="margin-bottom:12px;padding:11px 14px"><div style="font-size:11.5px;color:var(--t3);font-weight:700;margin-bottom:8px"><i class="ti ti-wallet"></i> 회사지출 분류별</div>
    ${_catKeys.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px">${_catKeys.map(c => `<div style="text-align:center;padding:6px 3px;background:var(--soft);border-radius:8px"><div style="font-size:10px;color:var(--t2);margin-bottom:2px">${esc(c)}</div><div style="font-size:12.5px;font-weight:800;color:#7c3aed">${fmtWon(expByCat[c])}</div></div>`).join('')}</div>` : `<div style="font-size:12px;color:var(--t3);text-align:center;padding:6px">이번 달 지출 내역이 없습니다</div>`}</div>`;
  // 원가·마진 전표별 (이번 달 전체 견적 — 여기서 원가 입력/수정)
  const lq = monthQuotes.slice().sort((a, b) => (qDate(b) || '').localeCompare(qDate(a) || ''));
  const cRows = lq.length ? lq.map(q => { const sup = +q.supply || 0; const has = (q.costTotal != null) || (q.costLines && q.costLines.length); const ct = has ? ((+q.costTotal) || (q.costLines || []).reduce((x, l) => x + (+l.cost || 0), 0)) : null; const mg = ct != null ? sup - ct : null; const r = (ct != null && sup > 0) ? Math.round(mg / sup * 100) : null;
    return `<tr style="border-bottom:1px solid var(--soft)"><td style="padding:6px 8px">${esc(qDate(q).slice(5))}</td><td style="padding:6px 8px">${esc(q.client || '')}</td><td style="padding:6px 8px;font-size:11px;color:var(--t3)">${esc(q.docNo || '')}</td><td style="padding:6px 8px;text-align:right">${fmtWon(sup)}</td><td style="padding:6px 8px;text-align:right;color:#b45309">${ct != null ? fmtWon(ct) : '<span style=\'color:#c0341d\'>미입력</span>'}</td><td style="padding:6px 8px;text-align:right;font-weight:700;color:${mg == null ? 'var(--t3)' : (mg >= 0 ? '#0f766e' : '#dc2626')}">${mg != null ? fmtWon(mg) : '-'}</td><td style="padding:6px 8px;text-align:right;color:var(--t2)">${r != null ? r + '%' : '-'}</td><td style="padding:6px 8px;text-align:center"><button class="btn btn-sm" style="padding:3px 8px;${has ? '' : 'color:var(--blue)'}" onclick="openCostForm('${q.id}')">${has ? '<i class="ti ti-edit"></i>수정' : '<i class="ti ti-plus"></i>입력'}</button></td></tr>`; }).join('')
    : `<tr><td colspan="8" style="padding:16px;text-align:center;color:var(--t3)">이번 달 견적이 없습니다</td></tr>`;
  const costLedger = `<div class="card" style="margin-bottom:12px;padding:13px 14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px"><div style="font-size:11.5px;color:var(--t3);font-weight:700"><i class="ti ti-report-money"></i> 원가 원장 (전표별 원가 입력 · 매출 · 마진)</div>
      <button class="btn btn-sm" onclick="downloadCostLedger()"><i class="ti ti-download"></i>원가원장 엑셀</button></div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:8px">각 견적(현장)의 <b>입력/수정</b> 버튼으로 원가를 여기서 정리하세요.</div>
    <div data-keepscroll id="settle-cost-list" style="max-height:42vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="border-bottom:1.5px solid var(--bd);color:var(--t2);font-size:11px"><th style="padding:6px 8px;text-align:left">날짜</th><th style="padding:6px 8px;text-align:left">거래처</th><th style="padding:6px 8px;text-align:left">전표</th><th style="padding:6px 8px;text-align:right">매출</th><th style="padding:6px 8px;text-align:right">원가</th><th style="padding:6px 8px;text-align:right">마진</th><th style="padding:6px 8px;text-align:right">마진율</th><th style="padding:6px 8px;text-align:center">원가</th></tr></thead>
      <tbody>${cRows}</tbody></table></div></div>`;
  // 회사지출 입력 + 목록
  const expRows = expMonth.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  const expList = expRows.length ? expRows.map(e => `<tr><td style="padding:6px 8px;font-size:11px;color:var(--t3)">${esc((e.date || '').slice(5))}</td><td style="padding:6px 8px">${esc(e.cat || '')}</td><td style="padding:6px 8px">${esc(e.name || '')}${e.manager ? ` <span style="color:var(--t3);font-size:11px">· ${esc(e.manager)}</span>` : ''}${e.note ? `<div style="font-size:10.5px;color:var(--t3)">${esc(e.note)}</div>` : ''}</td><td style="padding:6px 8px;text-align:right;font-weight:700">${fmtWon(e.amount)}</td><td style="padding:6px 8px;text-align:center"><span style="font-size:10.5px;color:${e.status === '완료' ? '#0f766e' : '#b45309'}">${esc(e.status || '')}</span></td><td style="padding:6px 8px;text-align:center"><button class="btn btn-sm" style="padding:2px 6px" onclick="delExpense('${e.id}')"><i class="ti ti-trash"></i></button></td></tr>`).join('')
    : `<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--t3)">${esc(ym)} 지출 내역이 없습니다</td></tr>`;
  const expForm = `<div class="card" style="padding:13px 14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><div style="font-size:11.5px;color:var(--t3);font-weight:700"><i class="ti ti-receipt-2"></i> 회사지출 관리</div>
      <button class="btn btn-sm" onclick="downloadExpenses()"><i class="ti ti-download"></i>지출 엑셀</button></div>
    <div style="display:grid;grid-template-columns:1.1fr 1fr 1.6fr 1.1fr;gap:6px;margin-bottom:6px">
      <input id="exp-date" type="date" class="inp" value="${todayStr()}">
      <select id="exp-cat" class="inp">${VAR_CATS.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
      <input id="exp-name" class="inp" placeholder="항목 (예: 명절 상여금, 경조사비)">
      <input id="exp-mgr" class="inp" placeholder="담당자(선택)">
    </div>
    <div style="display:grid;grid-template-columns:1.1fr 1fr 1.6fr 1.1fr;gap:6px;margin-bottom:8px">
      <input id="exp-amt" type="number" class="inp" placeholder="금액">
      <select id="exp-status" class="inp"><option value="정산중">정산중</option><option value="완료">완료</option></select>
      <input id="exp-note" class="inp" placeholder="설명(선택)">
      <button class="btn btn-pri btn-sm" onclick="addExpense()"><i class="ti ti-plus"></i>지출 등록</button>
    </div>
    <div data-keepscroll id="settle-exp-list" style="max-height:38vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="border-bottom:1.5px solid var(--bd);color:var(--t2);font-size:11px"><th style="padding:6px 8px;text-align:left">일자</th><th style="padding:6px 8px;text-align:left">분류</th><th style="padding:6px 8px;text-align:left">항목</th><th style="padding:6px 8px;text-align:right">금액</th><th style="padding:6px 8px;text-align:center">상태</th><th style="padding:6px 8px;text-align:center"></th></tr></thead>
      <tbody>${expList}</tbody></table></div></div>`;
  const _fx = fixedExpenses();
  const _fxTotal = _fx.reduce((a, b) => a + (+b.amount || 0), 0);
  const _fxApplied = (state.expenses || []).filter(e => (e.date || '').startsWith(ym) && e.fixed).length;
  const fxCard = `<div class="card" style="margin-bottom:12px;padding:13px 14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px"><div style="font-size:11.5px;color:var(--t3);font-weight:700"><i class="ti ti-repeat"></i> 고정 지출 항목 (매월 반복)</div>
      <button class="btn btn-pri btn-sm" onclick="applyFixedToMonth()"><i class="ti ti-calendar-plus"></i>이번 달 반영</button></div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:9px">이번 달 반영: <b style="color:${_fxApplied >= _fx.length && _fx.length ? '#0f766e' : '#b45309'}">${_fxApplied}/${_fx.length}건</b> · 고정 합계 <b>${fmtWon(_fxTotal)}</b>원 &nbsp;— 버튼을 누르면 이번 달 지출에 자동으로 깔립니다(중복 방지). 금액은 반영 후 개별 수정 가능.</div>
    <div style="display:grid;grid-template-columns:1fr 1.7fr 1.1fr auto;gap:6px;margin-bottom:8px">
      <select id="fx-cat" class="inp">${FIXED_CATS.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
      <input id="fx-name" class="inp" placeholder="항목 (예: 창고임대, 임창걸 지사장 급여)">
      <input id="fx-amt" type="number" class="inp" placeholder="월 금액">
      <button class="btn btn-sm" onclick="addFixedItem()"><i class="ti ti-plus"></i>추가</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:5px">${_fx.length ? _fx.map((it, i) => `<div style="display:flex;align-items:center;gap:8px;background:var(--soft);border-radius:8px;padding:6px 9px">
      <span style="font-size:11px;color:var(--t3);min-width:56px">${esc(it.cat || '')}</span>
      <span style="flex:1;font-size:13px;font-weight:600">${esc(it.name || '')}</span>
      <input type="number" class="inp" style="width:120px;text-align:right" value="${+it.amount || 0}" onchange="saveFixedAmt(${i},this.value)">
      <button class="btn btn-sm" style="padding:2px 6px" onclick="delFixedItem(${i})"><i class="ti ti-trash"></i></button></div>`).join('') : `<div style="font-size:12px;color:var(--t3);text-align:center;padding:10px">등록된 고정 지출 항목이 없습니다. 위에서 매월 반복되는 항목(급여·임대·공과금 등)을 추가하세요.</div>`}</div></div>`;

  const _mb = { 자재: { rev: 0, cost: 0 }, 가공: { rev: 0, cost: 0 }, 시공: { rev: 0, cost: 0 }, 운송: { rev: 0, cost: 0 } };
  costed.forEach(q => { const b = quoteMarginBreakdown(q); ['자재', '가공', '시공', '운송'].forEach(c => { _mb[c].rev += b[c].rev; _mb[c].cost += b[c].cost; }); });
  let _mtR = 0, _mtC = 0; ['자재', '가공', '시공', '운송'].forEach(c => { _mtR += _mb[c].rev; _mtC += _mb[c].cost; });
  const marginCard = costed.length ? `<div class="card" style="margin-bottom:12px;padding:13px 14px">
    <div style="font-size:11.5px;color:var(--t3);font-weight:700;margin-bottom:9px"><i class="ti ti-chart-bar"></i> 분류별 마진 <span style="font-weight:500">(원가 입력분 ${costed.length}건)</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px">
      ${['자재', '가공', '시공', '운송'].map(c => { const m = _mb[c].rev - _mb[c].cost; const r = _mb[c].rev > 0 ? Math.round(m / _mb[c].rev * 100) : 0; return `<div style="text-align:center;padding:9px 6px;background:var(--soft);border-radius:10px"><div style="font-size:10.5px;color:var(--t2);margin-bottom:3px">${c} 마진</div><div style="font-size:14.5px;font-weight:800;color:${m >= 0 ? '#0f766e' : '#dc2626'}">${fmtWon(m)}</div><div style="font-size:10px;color:var(--t3)">매출 ${fmtWon(_mb[c].rev)} · ${r}%</div></div>`; }).join('')}
      ${(() => { const m = _mtR - _mtC; const r = _mtR > 0 ? Math.round(m / _mtR * 100) : 0; return `<div style="text-align:center;padding:9px 6px;background:var(--gl2,#eefaf5);border:1.5px solid var(--gbd,#bfe6d5);border-radius:10px"><div style="font-size:10.5px;color:var(--t2);margin-bottom:3px">총마진</div><div style="font-size:14.5px;font-weight:800;color:${m >= 0 ? '#0f766e' : '#dc2626'}">${fmtWon(m)}</div><div style="font-size:10px;color:var(--t3)">${r}%</div></div>`; })()}
    </div>
    <div style="font-size:10.5px;color:var(--t3);margin-top:7px">분류별 매출(견적) − 분류별 원가(자재·가공비·시공·운송). 가공 원가는 공장 견적 총액.</div>
  </div>` : '';
  root.innerHTML = `<div class="ph"><div><h2><i class="ti ti-report-money"></i>정산</h2><p>원가 원장 · 시공비 정산 · 회사지출 · 영업이익</p></div></div>${monthBar}${pnl}${marginCard}${expCatBar}${costLedger}${crewSettleCard()}${fxCard}${expForm}`;
}

function renderQuote() {
  if (filters.quoteSettings) { if (!document.getElementById('qset-root')) renderQuoteSettings(); return; }   // 설정 화면
  if (filters.quoteEdit) { if (!document.getElementById('qform-root')) renderQuoteForm(); return; }   // 편집 중엔 실시간 재렌더로 폼을 덮어쓰지 않음
  if (filters.taxEdit) { if (!document.getElementById('taxform-root')) renderTaxForm(); return; }   // 세금계산서 발행 화면
  if (filters.costEdit) { if (!document.getElementById('cost-root')) renderCostForm(); return; }   // 원가 정리(관리자)
  const qy = (filters.quoteSearch || '').trim().toLowerCase();
  const all = (state.quotes || []);
  const ym = todayStr().slice(0, 7);
  const unpaid = all.reduce((a, b) => a + Math.max(0, (+b.total || 0) - (+b.paidAmount || 0)), 0);
  const noTax = all.filter(q => !q.taxInvoice).length;
  const monthSum = all.filter(q => (q.date || '').startsWith(ym)).reduce((a, b) => a + (+b.total || 0), 0);
  const catAgg = {}; QCATS.forEach(c => catAgg[c] = { sum: 0, cnt: 0 });
  all.forEach(q => { if (q.category && catAgg[q.category]) { catAgg[q.category].sum += (+q.supply || 0); catAgg[q.category].cnt++; } else { const cs = {}; (q.items || []).forEach(it => { const c = itemCategory(it.name); if (catAgg[c]) { catAgg[c].sum += Math.round(+it.amt || 0); cs[c] = 1; } }); Object.keys(cs).forEach(c => catAgg[c].cnt++); } });
  const catBreak = `<div class="card" style="margin-bottom:12px;padding:11px 14px"><div style="font-size:11.5px;color:var(--t3);font-weight:700;margin-bottom:8px"><i class="ti ti-chart-pie"></i> 분류별 매출 · 견적건</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${QCATS.map(c => `<div style="text-align:center;padding:7px 4px;background:var(--soft);border-radius:9px"><div style="font-size:10.5px;color:var(--t2);margin-bottom:2px">${c}</div><div style="font-size:14.5px;font-weight:800;color:var(--gd)">${fmtWon(catAgg[c].sum)}</div><div style="font-size:10px;color:var(--t3)">${catAgg[c].cnt}건</div></div>`).join('')}</div></div>`;
  let list = all.slice().sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  if (qy) list = list.filter(q => (q.client || '').toLowerCase().includes(qy) || (q.docNo || '').toLowerCase().includes(qy) || (q.items || []).some(it => (it.name || '').toLowerCase().includes(qy)));
  const view = filters.quoteView || 'all';
  const curMonth = filters.quoteMonth || ym;
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  let body;
  if (view === 'month') {
    const mlist = list.filter(q => qDate(q).startsWith(curMonth));
    const mSum = mlist.reduce((a, b) => a + (+b.total || 0), 0);
    const byDay = {}; mlist.forEach(q => { const d = qDate(q) || '날짜미상'; (byDay[d] = byDay[d] || []).push(q); });
    const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));
    const monthBar = `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--soft);border-radius:11px;padding:8px 12px;margin-bottom:10px">
      <button class="btn btn-sm" onclick="quoteMonthNav(-1)"><i class="ti ti-chevron-left"></i></button>
      <div style="text-align:center"><div style="font-weight:800;font-size:15.5px">${esc(curMonth.replace('-', '. '))}</div><div style="font-size:11.5px;color:var(--t3)">${mlist.length}건 · <b style="color:var(--gd)">${fmtWon(mSum)}</b>원</div></div>
      <button class="btn btn-sm" onclick="quoteMonthNav(1)"><i class="ti ti-chevron-right"></i></button></div>`;
    const sections = days.length ? days.map(d => {
      const qs = byDay[d]; const dSum = qs.reduce((a, b) => a + (+b.total || 0), 0);
      const dLabel = d === '날짜미상' ? d : (d.slice(5).replace('-', '/') + ' (' + WD[new Date(d + 'T00:00').getDay()] + ')');
      return `<div style="display:flex;align-items:center;gap:8px;margin:14px 2px 8px"><div style="font-weight:800;font-size:13.5px">${esc(dLabel)}</div><div style="flex:1;height:1px;background:var(--bd)"></div><div style="font-size:12px;color:var(--t2)">${qs.length}건 · <b style="color:var(--gd)">${fmtWon(dSum)}</b>원</div></div>${qs.map(quoteCardHtml).join('')}`;
    }).join('') : `<div class="empty"><i class="ti ti-file-invoice"></i>${esc(curMonth)}에 견적이 없습니다</div>`;
    body = monthBar + sections;
  } else {
    body = list.length ? list.map(quoteCardHtml).join('') : `<div class="empty"><i class="ti ti-file-invoice"></i>${qy ? '검색 결과가 없습니다' : '작성한 견적이 없습니다. 견적 작성으로 시작하세요.'}</div>`;
  }
  const toggle = `<div style="display:flex;gap:6px;margin-bottom:10px">
    <button class="btn btn-sm ${view === 'all' ? 'btn-pri' : ''}" onclick="filters.quoteView='all';renderQuote()">전체</button>
    <button class="btn btn-sm ${view === 'month' ? 'btn-pri' : ''}" onclick="filters.quoteView='month';renderQuote()"><i class="ti ti-calendar-month"></i> 월별</button></div>`;
  el('pg-quote').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-file-invoice"></i>견적서</h2><p>견적 작성 → 출고 → 결제 · 세금계산서까지</p></div>
      <div style="display:flex;gap:6px"><button class="btn btn-sm" onclick="openQuoteSettings()"><i class="ti ti-settings"></i>견적 설정</button><button class="btn btn-pri btn-sm" onclick="openQuoteInline()"><i class="ti ti-plus"></i>견적 작성</button></div></div>
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
      <div class="stat"><div class="ic r"><i class="ti ti-cash-off"></i></div><div class="v" style="font-size:19px">${fmtWon(unpaid)}</div><div class="l">미수금(미결제)</div></div>
      <div class="stat"><div class="ic b"><i class="ti ti-file-off"></i></div><div class="v">${noTax}</div><div class="l">계산서 미발행</div></div>
      <div class="stat"><div class="ic g"><i class="ti ti-calendar-stats"></i></div><div class="v" style="font-size:19px">${fmtWon(monthSum)}</div><div class="l">이번 달 견적</div></div>
    </div>
    ${catBreak}
    ${toggle}
    <div class="search-box" style="margin-bottom:10px"><i class="ti ti-search"></i>
      <input id="q-search" placeholder="거래처·견적번호·자재 검색" value="${esc(filters.quoteSearch || '')}" oninput="filters.quoteSearch=this.value;renderQuote()" autocomplete="off" lang="ko">
      ${(filters.quoteSearch || '').trim() ? `<button class="search-x" onclick="filters.quoteSearch='';el('q-search').value='';renderQuote()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    ${body}`;
}
function quoteDocHtml(q) {
  if (q.category === '통관비용') return customsDocHtml(q);
  const e = s => esc(s == null ? '' : String(s));
  const _staff = (state.members || []).find(m => _normName(m.name) === _normName(q.by || '')); const _staffPhone = (_staff && _staff.phone) || '';
  const _salesCl = (state.clients || []).find(x => _normName(x.value) === _normName(q.client || ''));
  const _salesRep = (q.useSalesRep && _salesCl && _salesCl.salesRep) ? _salesCl.salesRep : '';
  const _salesPhone = _salesRep ? salesRepPhoneOf(_salesRep) : '';
  const items = q.items || []; const MIN = Math.max(6, items.length);
  let rows = items.map((it, i) => `<tr><td class="c">${i + 1}</td><td class="l">${e(it.name)}</td><td class="c">${e(it.spec)}</td><td class="r">${e(it.qty)}${it.unit ? ' ' + e(it.unit) : ''}</td><td class="r">${fmtWon(it.price)}</td><td class="r">${fmtWon(it.amt)}</td></tr>`).join('');
  for (let i = items.length; i < MIN; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  const co = companyInfo();
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>견적서 ${e(q.client)} ${e(q.docNo)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/static/pretendard.min.css">
<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}
@page{size:A4;margin:8mm}
#page{width:718px;height:1047px;overflow:hidden;position:relative;margin:0 auto;background:#fff}
#sheet{width:718px;padding:26px 28px;transform-origin:top left;font-family:'Pretendard Variable',Pretendard,'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#201c17;font-size:12.5px;-webkit-font-smoothing:antialiased}
.qhead{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #201c17;padding-bottom:13px}
.qhead .brand{font-size:16px;font-weight:700;color:#201c17;letter-spacing:.3px}
.qhead .brand small{display:block;font-size:9px;color:#b39a6f;font-weight:600;letter-spacing:4px;margin-top:4px}
.qhead .title{text-align:right}
.qhead .title h1{margin:0;font-size:34px;font-weight:800;letter-spacing:15px;color:#201c17;line-height:1}
.qhead .title .en{font-size:9.5px;letter-spacing:7px;color:#c2a06a;font-weight:600;margin-top:5px}
.meta{display:flex;justify-content:space-between;align-items:baseline;gap:22px;font-size:11px;color:#9a9086;margin:11px 0 18px;letter-spacing:.3px}
.meta b{color:#201c17;font-weight:600}
.info{display:flex;gap:13px;margin-bottom:16px}
.info .box{flex:1;border:1px solid #e6ddcf;border-radius:2px;overflow:hidden}
.info .bh{background:#f6f1e8;color:#8a7350;font-weight:700;font-size:10px;padding:7px 13px;border-bottom:1px solid #e6ddcf;letter-spacing:2px}
.info .bb{padding:12px 14px;font-size:11.5px;line-height:1.65;position:relative;min-height:114px;color:#4a443c}
.info .recip-name{font-size:16px;font-weight:700;margin-bottom:6px;color:#201c17}
.stamp{position:absolute;right:16px;top:12px;width:72px;height:72px;border:2px solid #c2a06a;border-radius:50%;color:#c2a06a;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.2;transform:rotate(-9deg);opacity:.9}
.stampimg{position:absolute;right:14px;top:12px;width:88px;height:88px;object-fit:contain;opacity:.92;mix-blend-mode:multiply}
.items{border-collapse:collapse;width:100%;table-layout:fixed;border-top:2px solid #201c17;border-bottom:2px solid #201c17}
.items th{background:#201c17;color:#f3ece0;font-weight:600;font-size:11px;padding:10px 6px;letter-spacing:2px}
.items td{border-bottom:1px solid #ece4d6;padding:9px 7px;font-size:12px;height:31px;color:#332f28}
.items tbody tr:nth-child(even){background:#faf7f1}
.items td.c{text-align:center}.items td.l{text-align:left;padding-left:12px;font-weight:600;color:#201c17}.items td.r{text-align:right;padding-right:12px}
.bottom{display:flex;gap:15px;margin-top:16px;align-items:stretch}
.bottom .memo{flex:1;border:1px solid #e6ddcf;border-radius:2px;overflow:hidden;display:flex;flex-direction:column}
.memo .mh{background:#f6f1e8;color:#8a7350;font-weight:700;font-size:10px;padding:7px 13px;letter-spacing:2px}
.memo .mb{padding:11px 13px;font-size:11.5px;white-space:pre-wrap;line-height:1.65;flex:1;color:#4a443c}
.sum{width:300px;border-collapse:collapse;align-self:flex-start}
.sum td{padding:10px 14px;font-size:12.5px;border-bottom:1px solid #ece4d6}
.sum .k{color:#8a8178;font-weight:500}.sum .v{text-align:right;font-weight:600;color:#201c17}
.sum .tot td{background:#201c17;color:#fff;font-size:15px;font-weight:700;border:none;padding:13px 14px;letter-spacing:1px}
.sum .tot td:last-child{color:#e2c48c}
.notice{margin-top:15px;border:1px solid #cbb089;border-radius:2px;overflow:hidden}
.notice .nh{background:#8a7350;color:#fff;font-weight:700;font-size:11.5px;padding:8px 13px;letter-spacing:1px}
.notice ul{margin:0;padding:10px 12px 10px 30px;font-size:11px;line-height:1.75;color:#6b5a3c;font-weight:500;background:#faf6ee}
.foot{margin-top:18px;border-top:1px solid #e6ddcf;padding-top:10px;font-size:9.5px;color:#b0a795;display:flex;justify-content:space-between;letter-spacing:.3px}
@media print{html,body{background:#fff}#page{margin:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
  <div id="page"><div id="sheet">
  <div class="qhead">
    <div class="brand"><img src="${DAWOO_LOGO}" alt="" style="height:42px;display:block"></div>
    <div class="title"><h1>견 적 서</h1></div>
  </div>
  <div class="meta"><span style="display:flex;flex-direction:column;gap:2px;color:#201c17;font-weight:600"><span>견적 담당자 : ${e(q.by) || '-'}${_staffPhone ? ` <span style="color:#9a9086;font-weight:500">${e(_staffPhone)}</span>` : ''}</span>${_salesRep ? `<span>영업담당자 : ${e(_salesRep)}${_salesPhone ? ` <span style="color:#9a9086;font-weight:500">${e(_salesPhone)}</span>` : ''}</span>` : ''}</span><span style="display:flex;gap:22px"><span>견적번호 <b>${e(q.docNo)}</b></span><span>견적일 <b>${e(q.date)}</b></span><span>유효기간 <b>${e(q.valid) || '-'}</b></span></span></div>
  <div class="info">
    <div class="box"><div class="bh">수신</div><div class="bb"><div class="recip-name">${e(q.client)} 귀중</div>${q.attn ? `<div style="color:#555;margin-bottom:4px">${e(q.attn)}</div>` : ''}<div style="color:#666">아래와 같이 견적합니다.</div>${q.siteAddr ? `<div style="margin-top:11px;padding-top:9px;border-top:1px dashed #e0d6c4"><span style="color:#8a7350;font-weight:700;font-size:10px;letter-spacing:1.5px">현장 주소</span><div style="color:#332f28;margin-top:3px;line-height:1.5">${e(q.siteAddr)}</div></div>` : ''}</div></div>
    <div class="box"><div class="bh">공급자</div><div class="bb">${co.stampImg ? `<img class="stampimg" src="${co.stampImg}">` : `<div class="stamp">DAWOO<br>(인)</div>`}<b style="font-size:13px;color:#111">${e(co.name)}</b><br>대표 ${e(co.ceo)}<br>사업자등록번호 ${e(co.bizno)}<br>${e(co.addr)}<br>${e(co.tel)}<br>${e(co.biztype)}</div></div>
  </div>
  <table class="items"><colgroup><col style="width:7%"><col style="width:33%"><col style="width:22%"><col style="width:10%"><col style="width:14%"><col style="width:14%"></colgroup>
    <thead><tr><th>No</th><th>품목</th><th>규격</th><th>수량</th><th>단가</th><th>금액</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom">
    <div class="memo"><div class="mh">비 고</div><div class="mb">${q.memo ? e(q.memo) : ''}</div></div>
    <table class="sum">
      <tr><td class="k">공급가액</td><td class="v">${fmtWon(q.supply)} 원</td></tr>
      <tr><td class="k">부가세 (10%)</td><td class="v">${fmtWon(q.vat)} 원</td></tr>
      ${(+q.discount || 0) > 0 ? `<tr><td class="k">할인 (D/C)</td><td class="v" style="color:#c0341d">- ${fmtWon(q.discount)} 원</td></tr>` : ''}
      <tr class="tot"><td>합계금액</td><td style="text-align:right">${fmtWon(q.total)} 원</td></tr>
    </table>
  </div>
  ${hasBasinItems(items) ? `<div class="notice"><div class="nh">⚠ 세면대 주문제작 특이사항 (필독)</div><ul>${BASIN_NOTICE.map(l => `<li>${e(l)}</li>`).join('')}</ul></div>` : ''}
  <div class="foot"><span>※ 본 견적은 유효기간 내에서만 유효하며, 부가세 별도(공급가액 기준)로 산정되었습니다.</span><span>${e(co.name)}</span></div>
  </div></div>
  <script>window.addEventListener('load',function(){var s=document.getElementById('sheet');var a=1047;if(s&&s.scrollHeight>a){s.style.transform='scale('+(a/s.scrollHeight)+')';}});</script>
</body></html>`;
}
function printQuote(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) { toast('견적을 찾을 수 없습니다'); return; }
  const w = window.open('', '_blank'); if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시'); return; }
  w.document.write(quoteDocHtml(q)); w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch (e) { } }, 500);
}
function downloadQuotePng(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) { toast('견적을 찾을 수 없습니다'); return; }
  const run = () => {
    const ifr = document.createElement('iframe'); ifr.setAttribute('aria-hidden', 'true'); ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;height:1120px;border:0;background:#fff';
    document.body.appendChild(ifr);
    const d = ifr.contentDocument; d.open(); d.write(quoteDocHtml(q)); d.close();
    setTimeout(async () => {
      try {
        const page = d.getElementById('page');
        const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', width: 718, height: 1047, windowWidth: 760 });
        const a = document.createElement('a'); a.download = '견적서_' + ((q.client || '').replace(/\s/g, '')) + '_' + (q.docNo || '') + '.png'; a.href = canvas.toDataURL('image/png'); document.body.appendChild(a); a.click(); a.remove();
        toast('PNG 저장됨');
      } catch (err) { toast('이미지 생성 실패 — 인쇄로 저장해 주세요'); }
      finally { ifr.remove(); }
    }, 750);
  };
  toast('이미지 생성 중…');
  if (window.html2canvas) run();
  else { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload = run; s.onerror = () => toast('이미지 모듈 로딩 실패'); document.head.appendChild(s); }
}
function copyQuoteImage(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) { toast('견적을 찾을 수 없습니다'); return; }
  if (!(navigator.clipboard && window.ClipboardItem)) { toast('이 브라우저는 이미지 복사를 지원하지 않습니다 — PNG로 저장해 주세요'); return; }
  toast('이미지 복사 중…');
  const makeBlob = () => new Promise((resolve, reject) => {
    const render = () => {
      const ifr = document.createElement('iframe'); ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;height:1120px;border:0;background:#fff'; document.body.appendChild(ifr);
      const d = ifr.contentDocument; d.open(); d.write(quoteDocHtml(q)); d.close();
      setTimeout(async () => {
        try {
          const page = d.getElementById('page');
          const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', width: 718, height: 1047, windowWidth: 760 });
          canvas.toBlob(b => { ifr.remove(); b ? resolve(b) : reject(new Error('blob')); }, 'image/png');
        } catch (e) { ifr.remove(); reject(e); }
      }, 750);
    };
    if (window.html2canvas) render();
    else { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; sc.onload = render; sc.onerror = () => reject(new Error('load')); document.head.appendChild(sc); }
  });
  try {
    navigator.clipboard.write([new ClipboardItem({ 'image/png': makeBlob() })])
      .then(() => toast('이미지가 복사되었습니다 · Ctrl+V로 붙여넣기'))
      .catch(() => toast('복사 실패 — PNG로 저장해 주세요'));
  } catch (e) { toast('복사 실패 — PNG로 저장해 주세요'); }
}
function downloadQuoteXls(id) {
  const q = (state.quotes || []).find(x => x.id === id); if (!q) { toast('견적을 찾을 수 없습니다'); return; }
  const TH = (t, w) => `<th style="background:#0F6E56;color:#fff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:6px 9px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 9px;${st || ''}">${t}</td>`;
  const R = 'text-align:right;mso-number-format:\\#\\,\\#\\#0';
  const body = (q.items || []).map((it, i) => `<tr>${TD(i + 1, 'text-align:center')}${TD('<b>' + esc(it.name) + '</b>')}${TD(esc(it.spec || ''))}${TD(esc(it.qty) + (it.unit ? ' ' + esc(it.unit) : ''), 'text-align:right')}${TD(it.price, R)}${TD(it.amt, R)}</tr>`).join('');
  let html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>`;
  html += `<table><tr><td colspan="6" style="font-size:15pt;font-weight:bold;color:#0F6E56;padding:6px 4px">견적서 · ${esc(q.client)}</td></tr>`;
  html += `<tr><td colspan="6" style="font-size:10pt;color:#555;padding:2px 4px">견적번호 ${esc(q.docNo)} · 견적일 ${esc(q.date)} · 유효기간 ${esc(q.valid || '-')}${q.by ? ' · 담당 ' + esc(q.by) : ''}</td></tr></table>`;
  html += `<table style="border-collapse:collapse;margin-top:6px"><tr>${TH('No', 40)}${TH('품목', 200)}${TH('규격', 150)}${TH('수량', 60)}${TH('단가', 90)}${TH('금액', 100)}</tr>${body}`;
  html += `<tr><td colspan="5" style="border:0.5pt solid #cfd8d4;text-align:right;font-weight:bold;padding:6px 9px">공급가액</td>${TD('<b>' + fmtWon(q.supply) + '</b>', R)}</tr>`;
  html += `<tr><td colspan="5" style="border:0.5pt solid #cfd8d4;text-align:right;font-weight:bold;padding:6px 9px">부가세(10%)</td>${TD('<b>' + fmtWon(q.vat) + '</b>', R)}</tr>`;
  if ((+q.discount || 0) > 0) html += `<tr><td colspan="5" style="border:0.5pt solid #cfd8d4;text-align:right;font-weight:bold;padding:6px 9px;color:#c0341d">할인(D/C)</td>${TD('<b>-' + fmtWon(q.discount) + '</b>', R)}</tr>`;
  html += `<tr><td colspan="5" style="border:0.5pt solid #cfd8d4;background:#e1f5ee;text-align:right;font-weight:bold;padding:6px 9px">합계금액</td><td style="border:0.5pt solid #cfd8d4;background:#e1f5ee;text-align:right;font-weight:bold;padding:5px 9px">${fmtWon(q.total)}</td></tr></table>`;
  if (q.memo) html += `<table style="margin-top:8px"><tr><td style="font-weight:bold">비고 : ${esc(q.memo)}</td></tr></table>`;
  if (hasBasinItems(q.items)) html += `<table style="margin-top:8px;border-collapse:collapse"><tr><td style="background:#c0341d;color:#fff;font-weight:bold;padding:6px 9px">⚠ 세면대 주문제작 특이사항 (필독)</td></tr>` + BASIN_NOTICE.map(l => `<tr><td style="border:0.5pt solid #e0b4ad;color:#8a1c10;font-weight:bold;padding:5px 9px">· ${esc(l)}</td></tr>`).join('') + `</table>`;
  html += `</body></html>`;
  const blob = new Blob(['﻿', html], { type: 'application/vnd.ms-excel' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '견적서_' + (q.client || '') + '_' + (q.date || todayStr()) + '.xls'; document.body.appendChild(a); a.click(); a.remove();
  toast('엑셀 다운로드');
}
/* 연도별 월별 출고 집계 (헤베·장수·두께별) */
function shipMonthlyStats(yr) {
  const mHebe = Array(12).fill(0), mJang = Array(12).fill(0);
  const thick = {};   // { '12T': [12 months], ... }
  state.transactions.forEach(t => {
    if (t.type !== 'out') return; const d = t.date || ''; if (!d.startsWith(yr + '-')) return;
    const mi = parseInt(d.slice(5, 7), 10) - 1; if (mi < 0 || mi > 11) return; const j = +t.jang || 0;
    mHebe[mi] += (+t.hebe || 0); mJang[mi] += j;
    const it = (state.inventory || []).find(i => _normName(i.name) === _normName(t.itemName));
    let spec = t.spec || (it ? it.spec : '');
    const isB = /세면대/.test(t.itemName || '') || (it && itemCat(it) === '세면대');
    const key = isB ? '세면대' : (parseThick(t.itemName, spec) || '기타');
    (thick[key] = thick[key] || Array(12).fill(0))[mi] += j;
  });
  return { mHebe, mJang, thick };
}
/* 월별 분석 엑셀 다운로드 (.xls) — 월별 출고 + 두께별 + 상위 제품/업체(선택월 반영) */
function downloadMonthlyXls() {
  const yr = new Date().getFullYear();
  const { mHebe, mJang, thick } = shipMonthlyStats(yr);
  const prods = shipTopProducts(), clients = shipTopClients();
  const label = shipStatLabel();
  const TH = (t, w) => `<th style="background:#0F6E56;color:#fff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:6px 9px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 9px;${st || ''}">${t}</td>`;
  const R = 'text-align:right';
  const thickKeys = Object.keys(thick).sort((a, b) => { const rk = k => k === '세면대' ? -2 : (k === '기타' ? -3 : (parseInt(k) || 0)); return rk(b) - rk(a); });
  let html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>`;
  html += `<table><tr><td colspan="14" style="font-size:15pt;font-weight:bold;color:#0F6E56;padding:6px 4px">다우세라믹앤석재 · ${yr}년 월별 출고 분석</td></tr></table>`;
  // 월별 출고
  html += `<table style="border-collapse:collapse;margin-top:6px"><tr><td colspan="14" style="font-weight:bold;padding:4px">■ 월별 출고 (${yr}년)</td></tr>`;
  html += `<tr>${TH('구분', 90)}${Array.from({ length: 12 }, (_, i) => TH((i + 1) + '월', 55)).join('')}${TH('합계', 70)}</tr>`;
  html += `<tr>${TD('<b>장수(장)</b>')}${mJang.map(v => TD(v, R + ';mso-number-format:\\#\\,\\#\\#0')).join('')}${TD('<b>' + mJang.reduce((a, b) => a + b, 0) + '</b>', R)}</tr>`;
  html += `<tr>${TD('<b>헤베(㎡)</b>')}${mHebe.map(v => TD(v.toFixed(1), R)).join('')}${TD('<b>' + mHebe.reduce((a, b) => a + b, 0).toFixed(1) + '</b>', R)}</tr>`;
  thickKeys.forEach(k => { const arr = thick[k]; const unit = k === '세면대' ? '개' : '장'; const lab = k === '세면대' ? '세면대' : (k === '기타' ? '기타' : k.replace('T', '티')); html += `<tr>${TD(lab + '(' + unit + ')')}${arr.map(v => TD(v || '', R)).join('')}${TD('<b>' + arr.reduce((a, b) => a + b, 0) + '</b>', R)}</tr>`; });
  html += `</table>`;
  // 상위 제품
  html += `<table style="border-collapse:collapse;margin-top:12px"><tr><td colspan="6" style="font-weight:bold;padding:4px">■ 출고 상위 제품 (${label})</td></tr>`;
  html += `<tr>${TH('#', 40)}${TH('자재', 200)}${TH('규격', 150)}${TH('건수', 60)}${TH('장수', 70)}${TH('헤베(㎡)', 80)}</tr>`;
  html += prods.map((x, i) => `<tr>${TD(i + 1, 'text-align:center')}${TD('<b>' + esc(x.name) + '</b>')}${TD(esc(x.spec || ''))}${TD(x.cnt, R)}${TD(x.jang, R)}${TD(x.hebe.toFixed(1), R)}</tr>`).join('');
  html += `</table>`;
  // 상위 업체
  html += `<table style="border-collapse:collapse;margin-top:12px"><tr><td colspan="5" style="font-weight:bold;padding:4px">■ 거래량 많은 업체 (${label})</td></tr>`;
  html += `<tr>${TH('#', 40)}${TH('거래처', 200)}${TH('건수', 60)}${TH('장수', 70)}${TH('헤베(㎡)', 80)}</tr>`;
  html += clients.map((x, i) => `<tr>${TD(i + 1, 'text-align:center')}${TD('<b>' + esc(x.name) + '</b>')}${TD(x.cnt, R)}${TD(x.jang, R)}${TD(x.hebe.toFixed(1), R)}</tr>`).join('');
  html += `</table></body></html>`;
  const blob = new Blob(['﻿', html], { type: 'application/vnd.ms-excel' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '월별출고분석_' + yr + '_' + todayStr() + '.xls'; document.body.appendChild(a); a.click(); a.remove();
  toast('엑셀 다운로드');
}
/* 월별 출고 그래프(장수) PNG 다운로드 */
function downloadMonthlyChart() {
  const yr = new Date().getFullYear();
  const { mJang } = shipMonthlyStats(yr);
  const dpr = 2, W = 900, H = 440;
  const cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0F6E56'; g.font = 'bold 20px "Malgun Gothic",sans-serif'; g.fillText(`${yr}년 월별 출고 (장수)`, 24, 34);
  const padL = 56, padR = 24, padT = 58, padB = 42; const cw = W - padL - padR, ch = H - padT - padB;
  const max = Math.max(1, ...mJang);
  // y grid
  g.strokeStyle = '#e5e7eb'; g.fillStyle = '#9ca3af'; g.font = '11px sans-serif'; g.textAlign = 'right';
  for (let s = 0; s <= 4; s++) { const y = padT + ch - ch * s / 4; const val = Math.round(max * s / 4); g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillText(val.toLocaleString(), padL - 6, y + 4); }
  const bw = cw / 12 * 0.62, gap = cw / 12;
  g.textAlign = 'center';
  mJang.forEach((v, i) => {
    const x = padL + gap * i + (gap - bw) / 2; const bh = ch * v / max; const y = padT + ch - bh;
    g.fillStyle = (i === new Date().getMonth()) ? '#2f6fed' : '#5DCAA5'; g.fillRect(x, y, bw, bh);
    if (v) { g.fillStyle = '#374151'; g.font = 'bold 11px sans-serif'; g.fillText(v.toLocaleString(), x + bw / 2, y - 5); }
    g.fillStyle = '#6b7280'; g.font = '12px sans-serif'; g.fillText((i + 1) + '월', x + bw / 2, H - padB + 20);
  });
  cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = '월별출고그래프_' + yr + '_' + todayStr() + '.png'; document.body.appendChild(a); a.click(); a.remove(); toast('그래프 이미지 저장'); }, 'image/png');
}
/* 출고 화면 탭 전환 — 재렌더 없이 섹션만 표시/숨김 (검색·필터·스크롤 유지) */
function goShipTab(v) {
  filters.shipTab = v;
  document.querySelectorAll('#pg-ship .ship-sec').forEach(s => { s.style.display = (s.dataset.tab === v) ? '' : 'none'; });
  document.querySelectorAll('#ship-seg button').forEach(b => b.classList.toggle('on', b.dataset.t === v));
  const pg = el('pg-ship'); if (pg) pg.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
}
/* 자재의 롯트가 (입고 기준) 딱 하나면 그 롯트 반환 */
function theOnlyLot(name) {
  const lots = [...new Set(state.transactions.filter(x => _normName(x.itemName) === _normName(name) && x.type === 'in').map(x => (x.lot || '').trim()).filter(l => l && l !== '(미지정)'))];
  return lots.length === 1 ? lots[0] : '';
}
/* 기출고 중 롯트 미지정건 — 자재에 롯트가 하나뿐이면 자동 연결 */
async function autoLinkSoleLots() {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const targets = state.transactions.filter(t => t.type === 'out' && !((t.lot || '').trim()));
  const doable = targets.filter(t => theOnlyLot(t.itemName));
  if (!doable.length) { toast('자동연결할 미지정 출고가 없습니다 (롯트가 하나뿐인 자재만 대상)'); return; }
  if (!confirm(`롯트 미지정 출고 ${doable.length}건을, 해당 자재의 단일 롯트로 자동 연결할까요?`)) return;
  let n = 0;
  for (const t of doable) { const l = theOnlyLot(t.itemName); if (l) { try { await Store.update('transactions', t.id, { lot: l }); n++; } catch (e) { } } }
  toast(`${n}건 롯트 자동연결 완료`);
}
/* 출고 내역 조회·추출 (거래처/자재/기간별) */
function shipReportList() {
  const from = el('r-from') && el('r-from').value, to = el('r-to') && el('r-to').value;
  const cl = el('r-client') && el('r-client').value, mt = el('r-mat') && el('r-mat').value;
  const q = (filters.shipSearch || '').trim().toLowerCase();
  return state.transactions.filter(t => t.type === 'out')
    .filter(t => (!from || (t.date || '') >= from) && (!to || (t.date || '') <= to) && (!cl || t.targetName === cl) && (!mt || t.itemName === mt)
      && (!q || (t.itemName || '').toLowerCase().includes(q) || (t.targetName || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (outTs(b) - outTs(a)));
}
function shipReport() {
  const list = shipReportList();
  const tj = list.reduce((a, b) => a + (+b.jang || 0), 0), th = list.reduce((a, b) => a + (+b.hebe || 0), 0);
  if (el('r-body')) el('r-body').innerHTML = list.length ? list.map(t => `<tr style="cursor:pointer" onclick="openOutEdit('${t.id}')" title="탭하면 롯트·패턴·장수 수정"><td>${esc(t.date || '')}</td><td><b>${esc(t.targetName || '')}</b></td><td>${esc(t.itemName || '')}${t.lot || t.pattern ? `<div style="font-size:10.5px;color:var(--t3)">${[t.lot ? '롯트 ' + esc(t.lot) : '', t.pattern ? '패턴 ' + esc(t.pattern) : ''].filter(Boolean).join(' · ')}</div>` : ''}</td><td>${+t.jang || 0}장</td><td>${(+t.hebe || 0).toFixed(1)}㎡</td><td>${esc(t.dest || t.factory || '')}</td></tr>`).join('') : `<tr><td colspan="6"><div class="empty" style="padding:18px"><i class="ti ti-search-off"></i>해당 출고 내역이 없습니다</div></td></tr>`;
  if (el('r-sum')) el('r-sum').innerHTML = `${list.length}건 · 합계 <b style="color:var(--t1)">${tj}장 · ${th.toFixed(1)}㎡</b>`;
  if (el('r-daily')) {
    const dmap = {};
    list.forEach(t => { const d = t.date || '(미상)'; if (!dmap[d]) dmap[d] = { date: d, cnt: 0, jang: 0, hebe: 0 }; dmap[d].cnt++; dmap[d].jang += (+t.jang || 0); dmap[d].hebe += (+t.hebe || 0); });
    const days = Object.values(dmap).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const wd = ['일', '월', '화', '수', '목', '금', '토'];
    const dayLbl = d => { const p = String(d).split('-'); if (p.length !== 3) return esc(d); const dt = new Date(+p[0], +p[1] - 1, +p[2]); return `${+p[1]}/${+p[2]}<span style="color:var(--t3)">(${wd[dt.getDay()]})</span>`; };
    el('r-daily').innerHTML = days.length ? `<details open><summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--t2);padding:4px 2px"><i class="ti ti-calendar-stats"></i> 일별 출고 <span style="font-weight:500;color:var(--t3)">· ${days.length}일 · 탭하면 그 날짜만 조회</span></summary>
      <div class="tbl-wrap" style="max-height:200px;overflow:auto;margin-top:6px;border:0.5px solid var(--bd);border-radius:10px">
        <table class="tbl"><thead><tr><th>날짜</th><th>건수</th><th>장수</th><th>헤베</th></tr></thead><tbody>
        ${days.map(d => `<tr style="cursor:pointer" onclick="shipReportPickDay('${d.date}')" title="이 날짜만 조회"><td>${dayLbl(d.date)}</td><td>${d.cnt}건</td><td><b style="color:var(--t1)">${d.jang}장</b></td><td style="color:var(--gd)">${d.hebe.toFixed(1)}㎡</td></tr>`).join('')}
        </tbody></table>
      </div></details>` : '';
  }
}
function shipReportPickDay(d) {
  if (el('r-from')) el('r-from').value = d;
  if (el('r-to')) el('r-to').value = d;
  shipReport();
}
function downloadShipXls() {
  const list = shipReportList();
  if (!list.length) { toast('내보낼 내역이 없습니다'); return; }
  const from = el('r-from') && el('r-from').value, to = el('r-to') && el('r-to').value;
  const cl = el('r-client') && el('r-client').value, mt = el('r-mat') && el('r-mat').value;
  const period = (from || to) ? `${from || '처음'} ~ ${to || todayStr()}` : '전체 기간';
  const tj = list.reduce((a, b) => a + (+b.jang || 0), 0), th = list.reduce((a, b) => a + (+b.hebe || 0), 0);
  const TH = (t, w) => `<th style="background:#0F6E56;color:#ffffff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const body = list.map((t, i) => {
    const bg = i % 2 ? 'background:#f3f6f4;' : '';
    return `<tr>${TD(esc(t.date || ''), bg)}${TD('<b>' + esc(t.itemName || '') + '</b>', bg)}${TD(esc(t.spec || ''), bg)}${TD((+t.jang || 0), bg + 'mso-number-format:\\#\\,\\#\\#0;text-align:right')}${TD((+t.hebe || 0).toFixed(2), bg + 'text-align:right')}${TD(esc(t.dest || t.factory || ''), bg)}${TD(esc(t.targetName || ''), bg)}${TD(esc(t.lot || ''), bg)}${TD(esc(t.by || ''), bg)}</tr>`;
  }).join('');
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>출고내역</x:Name><x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="9" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 출고 내역</td></tr>
<tr><td colspan="9" style="font-size:9pt;color:#777;padding:0 4px 10px">기간 ${period}  ·  거래처 ${cl || '전체'}  ·  자재 ${mt || '전체'}  ·  생성일 ${todayStr()}  ·  총 ${list.length}건</td></tr>
<tr>${TH('출고일', 90)}${TH('자재명', 150)}${TH('규격', 110)}${TH('장수', 60)}${TH('헤베(㎡)', 80)}${TH('출고지', 120)}${TH('거래처', 120)}${TH('롯트', 110)}${TH('담당', 80)}</tr>
${body}
<tr><td colspan="3" style="${sumStyle};text-align:right">합계</td><td style="${sumStyle};text-align:right">${tj}</td><td style="${sumStyle};text-align:right">${th.toFixed(2)}</td><td colspan="4" style="${sumStyle}"></td></tr>
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '출고내역_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('엑셀 다운로드 (' + list.length + '건)');
}
/* 시공 통계 엑셀 — 시공팀별/업체별 현장 수 + 비율 + 현장 많은 업체 순위 */
function downloadSiteStatsXls() {
  const sites = state.sites || [];
  const total = sites.length;
  if (!total) { toast('현장 데이터가 없습니다'); return; }
  const group = (keyFn) => { const m = {}; sites.forEach(s => { const k = (keyFn(s) || '').trim() || '(미지정)'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const teamRows = group(s => s.team);
  const clientRows = group(s => s.client);
  const pct = n => (n / total * 100).toFixed(1) + '%';
  const TH = (t, w) => `<th style="background:#0F6E56;color:#ffffff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center"${w ? ' width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const section = (title, rows, label) => {
    const body = rows.map(([nm, n], i) => { const bg = i % 2 ? 'background:#f3f6f4;' : ''; return `<tr>${TD(i + 1, bg + 'text-align:center')}${TD('<b>' + esc(nm) + '</b>', bg)}${TD(n, bg + 'text-align:right')}${TD(pct(n), bg + 'text-align:right')}</tr>`; }).join('');
    return `<tr><td colspan="4" style="font-size:12pt;font-weight:bold;color:#0F6E56;padding:12px 4px 4px">${title}</td></tr>
      <tr>${TH('순위', 50)}${TH(label, 200)}${TH('현장 수', 80)}${TH('비율', 80)}</tr>
      ${body}
      <tr><td colspan="2" style="${sumStyle};text-align:right">합계</td>${TD(total, sumStyle + ';text-align:right')}${TD('100%', sumStyle + ';text-align:right')}</tr>`;
  };
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="4" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 시공 통계</td></tr>
<tr><td colspan="4" style="font-size:9pt;color:#777;padding:0 4px 6px">생성일 ${todayStr()}  ·  전체 현장 ${total}건</td></tr>
${section('■ 시공팀별 현장 수', teamRows, '시공팀')}
<tr><td colspan="4" style="padding:6px"></td></tr>
${section('■ 업체별 현장 수 (현장 많은 업체 순)', clientRows, '업체')}
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '시공통계_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('시공 통계 엑셀 다운로드');
}
/* 출고 내역 수정 — 롯트·패턴 재배정(재고 자동 재계산) + 장수 보정 */
function openOutEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'out'); if (!t) return;
  const mine = state.transactions.filter(x => _normName(x.itemName) === _normName(t.itemName));
  const lotOpts = [...new Set(mine.map(x => (x.lot || '').trim()).filter(l => l && l !== '(미지정)'))].sort();
  const patOpts = [...new Set(mine.flatMap(x => x.type === 'in' ? (x.patterns || []).map(p => (p.pattern || '').trim()) : [(x.pattern || '').trim()]).filter(p => p && p !== '-'))].sort();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-edit"></i>출고 내역 수정</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(t.itemName || '')}</b>${t.spec ? ' · ' + esc(t.spec) : ''}</div>
    <div class="frm">
      <div class="fld"><label>출고일</label><input type="date" id="oe-date" value="${esc(t.date || '')}"></div>
      <div class="fld"><label>장수</label><input id="oe-jang" inputmode="numeric" value="${esc(t.jang || 0)}"></div>
      <div class="fld full"><label>롯트 넘버 <span style="color:var(--t3);font-weight:500">(실제 출고된 롯트로 지정 · 미지정 해소)</span></label><input id="oe-lot" list="oe-lot-list" value="${esc(t.lot || '')}" placeholder="롯트 넘버 입력/선택"><datalist id="oe-lot-list">${lotOpts.map(l => `<option value="${esc(l)}">`).join('')}</datalist></div>
      <div class="fld full"><label>패턴 <span style="color:var(--t3);font-weight:500">(실제 출고된 패턴으로 지정)</span></label><input id="oe-pat" list="oe-pat-list" lang="ko" value="${esc(t.pattern || '')}" placeholder="패턴 입력/선택"><datalist id="oe-pat-list">${patOpts.map(p => `<option value="${esc(p)}">`).join('')}</datalist></div>
      <div class="fld"><label>거래처</label><input id="oe-target" lang="ko" value="${esc(t.targetName || '')}"></div>
      <div class="fld"><label>출고지</label><input id="oe-dest" lang="ko" value="${esc(t.dest || t.factory || '')}"></div>
      <div class="fld full"><label>메모</label><input id="oe-note" lang="ko" value="${esc(t.note || '')}"></div>
      <div class="fld full" style="background:#fff2f0;border-radius:9px;padding:10px 12px"><label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;color:#b42318"><input type="checkbox" id="oe-damaged" ${((t.damaged === true) || (t.damaged === undefined && /파손/.test(t.note || ''))) ? 'checked' : ''} style="width:18px;height:18px"> <i class="ti ti-alert-square-rounded"></i>파손 자재 출고 <span style="font-weight:400;color:var(--t3);font-size:12px">(체크 시 파손 재고에서 차감)</span></label></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 롯트·패턴을 바꾸면 롯트별/패턴별 재고가 자동으로 다시 계산됩니다. 장수를 바꾸면 실재고도 함께 보정됩니다.</div>
    </div>
    <div class="frm-foot">${isAdmin() ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="delShip('${t.id}');closeModal()"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitOutEdit('${t.id}')"><i class="ti ti-check"></i>저장</button></div>`);
}
async function submitOutEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'out'); if (!t) return;
  const oldJang = +t.jang || 0;
  const newJang = Math.max(0, parseFloat(el('oe-jang').value) || 0);
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  const per = it ? (+it.hebePerJang || 0) : 0;
  const patch = {
    jang: newJang,
    lot: (el('oe-lot').value || '').trim(),
    pattern: (el('oe-pat').value || '').trim(),
    hebe: +(newJang * per).toFixed(2),
    date: el('oe-date').value || t.date || '',
    targetName: (el('oe-target').value || '').trim(),
    dest: (el('oe-dest').value || '').trim(),
    note: (el('oe-note').value || '').trim(),
    damaged: !!(el('oe-damaged') && el('oe-damaged').checked)   // 파손 자재 출고 지정(체크 해제 시 파손 차감 취소)
  };
  patch.factory = patch.dest;
  await Store.update('transactions', id, patch);
  // 장수 변경 시 실재고 보정: 출고 줄이면 +재고, 늘리면 -재고
  if (it && newJang !== oldJang) {
    await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) + (oldJang - newJang)) });
  }
  closeModal(); toast('출고 내역이 수정되었습니다');
}
/* 출고표(출고증) 인쇄 — 회사 양식 기준. 출고 묶음(shipId) 단위로 발행 */
const DAWOO_CO_DEFAULT = {
  name: '주식회사 다우세라믹앤석재',
  addr: '경기도 용인시 처인구 모현읍 곡현로 425, 2동',
  tel: 'Tel ) 070-8211-0144　Fax ) 0503-8379-3628',
  biztype: '건설업 도소매',
  ceo: 'LIN CHANGJIE',
  bizno: '711-86-03547',
  email: 'dawoost@naver.com',
  web: 'www.dawoostone.kr'
};
const DAWOO_LOGO = 'data:image/png;base64,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';
/* 회사 정보 · 도장 (설정에서 수정, 기본값 위에 덮어씀) */
function companyInfo() { const m = (state.appmeta || []).find(x => x.key === 'companyInfo'); return Object.assign({}, DAWOO_CO_DEFAULT, (m && m.info) || {}); }
function companyStamp() { const m = (state.appmeta || []).find(x => x.key === 'companyInfo'); return (m && m.info && m.info.stampImg) || ''; }
async function saveCompanyField(field, val) { const m = (state.appmeta || []).find(x => x.key === 'companyInfo'); const info = Object.assign({}, (m && m.info) || {}); info[field] = val; if (m) await Store.update('appmeta', m.id, { info }); else await Store.add('appmeta', { key: 'companyInfo', info }); }
function companyStampImport(input) {
  const f = input.files && input.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = e => { const img = new Image(); img.onload = async () => {
    const max = 280; let w = img.width, h = img.height; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
    try { await saveCompanyField('stampImg', c.toDataURL('image/png')); toast('도장 이미지 저장됨'); } catch (err) { toast('저장 실패 — 이미지가 너무 큽니다'); }
    input.value = ''; setTimeout(() => { if (filters.quoteSettings) renderQuoteSettings(); }, 300);
  }; img.src = e.target.result; };
  rd.readAsDataURL(f);
}
async function removeStamp() { if (!confirm('도장 이미지를 제거할까요?')) return; await saveCompanyField('stampImg', ''); toast('도장 제거됨'); setTimeout(() => { if (filters.quoteSettings) renderQuoteSettings(); }, 300); }
function printShipSlip(key) {
  const items = state.transactions.filter(t => t.type === 'out' && (t.shipId || t.id) === key)
    .sort((a, b) => (a.itemName || '').localeCompare(b.itemName || ''));
  if (!items.length) { toast('출고 내역을 찾을 수 없습니다'); return; }
  const g = items[0];
  const e = s => esc(s == null ? '' : String(s));
  const totJang = items.reduce((a, b) => a + (+b.jang || 0), 0);
  const totHebe = items.reduce((a, b) => a + (+b.hebe || 0), 0);
  // 문서번호: 출고일(YYYYMMDD) + 당일 출고 순번
  const dayKeys = [...new Set(state.transactions.filter(t => t.type === 'out' && (t.date || '') === (g.date || '')).map(t => t.shipId || t.id))].sort();
  const seq = Math.max(1, dayKeys.indexOf(key) + 1);
  const docNo = (g.date || '').replace(/-/g, '') + '-' + seq;
  const route = (g.dest || '') ? '다우세라믹 상차 →<br>' + e(g.dest) + ' 하차' : '';
  // 출고 확인 도장 (가운데에 출고일자)
  const stamp = `<svg viewBox="0 0 200 200" width="150" height="150" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs><path id="arcTop" d="M 30,100 A 70,70 0 0 1 170,100"/></defs>
    <circle cx="100" cy="100" r="94" fill="none" stroke="#111" stroke-width="4"/>
    <text font-size="15" font-weight="700" fill="#111" letter-spacing="1"><textPath xlink:href="#arcTop" href="#arcTop" startOffset="50%" text-anchor="middle">주식회사 다우세라믹앤석재</textPath></text>
    <text x="100" y="68" text-anchor="middle" font-size="30" font-weight="800" fill="#111">출고</text>
    <line x1="32" y1="84" x2="168" y2="84" stroke="#111" stroke-width="3"/>
    <text x="100" y="110" text-anchor="middle" font-size="17" font-weight="700" fill="#111">${e(g.date)}</text>
    <line x1="32" y1="122" x2="168" y2="122" stroke="#111" stroke-width="3"/>
    <text x="100" y="152" text-anchor="middle" font-size="30" font-weight="800" fill="#111">확인</text>
  </svg>`;
  const MINROWS = 8;
  let rows = items.map((t, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td class="l">${e(t.itemName)}</td>
      <td class="c">${e(t.unit || '㎡')}</td>
      <td class="c">${e(t.spec)}</td>
      <td class="r">${t.hebe ? (+t.hebe).toFixed(2) : ''}</td>
      <td class="r">${+t.jang || 0}</td>
      <td class="l">${e([t.pattern, t.lot ? '롯트 ' + t.lot : ''].filter(Boolean).join(' · '))}</td>
    </tr>`).join('');
  for (let i = items.length; i < MINROWS; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출고표 ${e(g.targetName)} ${e(g.date)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111;margin:0;padding:22px 26px}
  table{border-collapse:collapse;width:100%}
  .top{table-layout:fixed}
  .top td{border:1px solid #444;padding:8px 10px;vertical-align:middle}
  .doc{padding:0!important;text-align:center}
  .doc .dl{border-bottom:1px solid #444;padding:9px 6px;letter-spacing:4px;font-size:13px;font-weight:600}
  .doc .dv{padding:9px 6px;font-size:13.5px}
  .title{text-align:center;font-size:30px;font-weight:800;letter-spacing:16px}
  .issue{text-align:center;font-size:13px}
  .issue .ik{letter-spacing:3px;font-weight:600}
  .issue .iv{font-size:14px;font-weight:600;margin-top:5px;white-space:nowrap}
  .conm{text-align:center;font-size:18px;font-weight:800}
  .recip{text-align:center;vertical-align:middle}
  .recip .rn{font-size:24px;font-weight:800}
  .recip .rt{font-size:15px;font-weight:600;margin-top:22px;word-break:keep-all;line-height:1.55}
  .ck{text-align:center;font-weight:700;background:#f4f4f4;white-space:nowrap}
  .cv{font-size:13.5px}
  .cv .tel{font-size:12px;color:#333}
  .web{text-align:center;font-weight:800;text-decoration:underline;letter-spacing:1px}
  .items{table-layout:fixed;margin-top:14px}
  .items th{border:1px solid #444;background:#eee;padding:8px 6px;font-size:13.5px;font-weight:700}
  .items td{border:1px solid #444;padding:7px 6px;font-size:13px;height:31px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .items tfoot td{font-weight:800;background:#faf7ee}
  .bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:12px}
  .who{table-layout:fixed;flex:1}
  .who td{border:1px solid #444;padding:10px 10px;font-size:13px}
  .who .wk{text-align:center;font-weight:700;background:#f4f4f4;width:16%}
  .stamp{flex:none;width:150px;height:150px}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <table class="top">
    <colgroup><col style="width:27%"><col style="width:14%"><col style="width:59%"></colgroup>
    <tr>
      <td class="doc"><div class="dl">문 서 번 호</div><div class="dv">${docNo}</div></td>
      <td class="title" colspan="2">출 고 표</td>
    </tr>
    <tr>
      <td class="issue"><div class="ik">발 행 일 자</div><div class="iv">${e(g.date)}</div></td>
      <td class="conm" colspan="2">${companyInfo().name}</td>
    </tr>
    <tr>
      <td class="recip" rowspan="6"><div class="rn">${e(g.targetName)}</div><div class="rt">${route}</div></td>
      <td class="ck">주 소</td><td class="cv">${companyInfo().addr}<br><span class="tel">${companyInfo().tel}</span></td>
    </tr>
    <tr><td class="ck">업 태</td><td class="cv">${companyInfo().biztype}</td></tr>
    <tr><td class="ck">대표이사</td><td class="cv">${companyInfo().ceo}</td></tr>
    <tr><td class="ck">등록번호</td><td class="cv">${companyInfo().bizno}</td></tr>
    <tr><td class="ck">E-mail</td><td class="cv">${companyInfo().email}</td></tr>
    <tr><td class="web" colspan="2">${companyInfo().web}</td></tr>
  </table>
  <table class="items">
    <colgroup><col style="width:6%"><col style="width:30%"><col style="width:8%"><col style="width:16%"><col style="width:12%"><col style="width:10%"><col style="width:18%"></colgroup>
    <thead><tr><th>NO</th><th>품명</th><th>단위</th><th>규격</th><th>면적</th><th>수량</th><th>비고</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td class="c" colspan="4">합 계</td><td class="r">${totHebe.toFixed(2)}</td><td class="r">${totJang}</td><td></td></tr></tfoot>
  </table>
  <div class="bottom">
    <table class="who"><tr><td class="wk">담당자</td><td>${e(g.by)}</td></tr>${(g.note && g.note.trim()) ? `<tr><td class="wk">메모</td><td style="white-space:pre-wrap">${e(g.note)}</td></tr>` : ''}</table>
    <div class="stamp">${stamp}</div>
  </div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}

/* ================= 세면대(오더베이스) 발주 · 출고 라인 ================= */
const BASIN_STAGES = ['견적', '발주', '출항', '입항', '국내입고', '완료'];
const BASIN_STAGE_META = {
  '견적': { c: '#5b6472', bg: '#eef1f5' },
  '발주': { c: '#2f6fed', bg: '#eaf1fe' },
  '출항': { c: '#0e9f6e', bg: '#e7f7ef' },
  '입항': { c: '#b5730a', bg: '#fdf3e3' },
  '국내입고': { c: '#7a44c9', bg: '#f2ebfd' },
  '완료': { c: '#0a5b46', bg: '#e6f6ef' }
};
function basinStageIndex(b) { let s = b.stage || '견적'; if (s === '입항대기') s = '입항'; return Math.max(0, BASIN_STAGES.indexOf(s)); }
/* 석종(컬러) — 한국어 / 중국어 / 두께. 팬텀·아스팬·알래스카는 기장 1500mm 제한 */
const BASIN_STONES = [
  { k: '볼라카스', c: '爵士白', t: '15mm' },
  { k: '퓨어 화이트', c: '纯白', t: '15mm' },
  { k: '화이트 트라버티노', c: '罗马印记', t: '15mm' },
  { k: '피스마우골드', c: '鱼肚金', t: '15mm' },
  { k: '크레마 나카', c: '象牙米黄', t: '15mm' },
  { k: '실버 트라버티노', c: '巴洛克灰洞', t: '14.5mm' },
  { k: '아만베이지', c: '阿曼米黄', t: '15mm' },
  { k: '베이지 트라버티노', c: '黄洞石', t: '15mm' },
  { k: '깔라까타 마로네', c: '宝格丽紫', t: '15mm' },
  { k: '아메리칸 블랙', c: '美洲砂岩', t: '15mm' },
  { k: '퓨어 블랙', c: '', t: '15mm' },
  { k: '플래티넘 그레이', c: '', t: '15mm' },
  { k: '팬텀 화이트', c: '罗马幻影白', t: '12mm', maxLen: 1500 },
  { k: '아스팬라이트그레이', c: '塞浦路斯', t: '', maxLen: 1500 },
  { k: '알래스카 화이트', c: '阿拉斯加白', t: '12mm', maxLen: 1500 }
];
const BASIN_BOWLS = ['중방볼', '좌방볼', '우방볼', '타원볼', '물방울볼', '기둥볼', '무봉(심리스)', '평판', '기타'];
function basinStoneMeta(name) { return BASIN_STONES.find(s => s.k === name) || null; }
const BASIN_FILTERS = [
  { k: 'all', label: '진행중', match: b => (b.stage || '견적') !== '완료' },
  { k: '견적', label: '견적', match: b => (b.stage || '견적') === '견적' },
  { k: '발주', label: '발주', match: b => b.stage === '발주' },
  { k: '출항', label: '출항', match: b => b.stage === '출항' },
  { k: '입항', label: '입항', match: b => b.stage === '입항' || b.stage === '입항대기' },
  { k: '국내입고', label: '국내입고', match: b => b.stage === '국내입고' },
  { k: '완료', label: '완료', match: b => b.stage === '완료' }
];
function basinFilteredList() {
  const f = filters.basinTab || 'all';
  const fdef = BASIN_FILTERS.find(x => x.k === f) || BASIN_FILTERS[0];
  let l = (state.basins || []).filter(fdef.match);
  const q = (filters.basinSearch || '').trim().toLowerCase();
  if (q) l = l.filter(b => {
    const hay = [b.vendor, b.address].concat(basinItems(b).flatMap(it => [it.stone, it.spec, it.orderNo, it.quoteNo]));
    return hay.some(v => (v || '').toLowerCase().includes(q));
  });
  l.sort((a, b) => (b.orderDate || '0000').localeCompare(a.orderDate || '0000'));   // 발주일 최신순
  return l;
}
function renderBasin() {
  const f = filters.basinTab || 'all';
  const list = basinFilteredList();
  const chips = BASIN_FILTERS.map(x => {
    const n = (state.basins || []).filter(x.match).length;
    return `<button class="chip ${f === x.k ? 'active' : ''}" onclick="filters.basinTab='${x.k}';renderBasin()">${x.label}${n ? ` <b style="opacity:.7">${n}</b>` : ''}</button>`;
  }).join('');
  el('pg-basin').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-bath"></i>세면대 발주·출고</h2><p>오더베이스 · 탭하면 상세 · 국내입고 후 출고증</p></div>
      <button class="btn btn-pri btn-sm" onclick="openBasinForm()"><i class="ti ti-plus"></i>발주 등록</button></div>
    <div class="chips">${chips}</div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="basin-search" placeholder="업체·석종·규격·주문번호 검색" value="${esc(filters.basinSearch || '')}" oninput="filterBasin()" autocomplete="off" lang="ko">
      ${filters.basinSearch ? `<button class="search-x" onclick="el('basin-search').value='';filters.basinSearch='';renderBasin()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn btn-sm" style="flex:2" onclick="basinPackingUpload()"><i class="ti ti-file-spreadsheet"></i> 인보이스 업로드 → 출항</button>
      <button class="btn btn-sm" style="flex:1" onclick="openBasinStats()"><i class="ti ti-chart-bar"></i> 수주 통계</button>
    </div>
    <button class="btn btn-sm btn-block" style="margin-bottom:10px;color:#b42318;border-color:#e6a9a9" onclick="openBasinIssueForm()"><i class="ti ti-alert-triangle"></i> 세면대 이슈 등록 <span style="color:var(--t3);font-weight:500">(파손·납기지연 등)</span></button>
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px">검색 결과 <b id="basin-count" style="color:var(--t1)">${list.length}건</b></div>
    <div class="site-grid" id="basin-list">${basinListHtml(list)}</div>`;
}
function basinListHtml(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>해당하는 발주가 없습니다</div>`;
  return list.map(basinCard).join('');
}
function filterBasin() {
  filters.basinSearch = (el('basin-search') && el('basin-search').value) || '';
  const list = basinFilteredList();
  if (el('basin-list')) el('basin-list').innerHTML = basinListHtml(list);
  if (el('basin-count')) el('basin-count').textContent = list.length + '건';
}
function basinPill(stage) {
  const m = BASIN_STAGE_META[stage] || BASIN_STAGE_META['견적'];
  return `<span class="pill" style="background:${m.bg};color:${m.c}">${esc(stage || '견적')}</span>`;
}
function basinItems(b) {
  if (b.items && b.items.length) return b.items;
  if (b.stone || b.spec || b.qty) return [{ stone: b.stone || '', spec: b.spec || '', qty: b.qty || '', quoteNo: b.quoteNo || '', price: b.price || '' }];   // 구버전 단일품목 호환
  return [];
}
function basinTotalQty(b) { return basinItems(b).reduce((a, it) => a + (parseInt(it.qty, 10) || 0), 0); }
function basinCard(b) {
  const idx = basinStageIndex(b);
  const done = b.stage === '완료';
  const tnodes = BASIN_STAGES.map((st, i) => {
    const cls = i < idx ? 'done' : (i === idx ? 'cur' : '');
    const d = (b.history && b.history[st]) ? b.history[st].slice(5) : '';
    return `<div class="tnode ${cls}"><span class="c">${i < idx ? "<i class='ti ti-check'></i>" : ''}</span><span class="lb">${st}</span><span class="dt">${d}</span></div>`;
  }).join('');
  const items = basinItems(b);
  const totQty = basinTotalQty(b);
  const itemLines = items.slice(0, 4).map(it => `<div style="font-size:12px;color:var(--t2);padding:4px 0;border-top:1px solid var(--bd);display:flex;justify-content:space-between;gap:8px"><span><b style="color:var(--t1);font-weight:600">${esc(it.stone || '-')}</b>${it.spec ? ' · ' + esc(it.spec) : ''}${it.orderNo ? ` <span style="color:var(--t3)">· 주문 ${esc(it.orderNo)}</span>` : ''}</span><span style="flex:none;color:var(--t3)">${it.qty ? esc(it.qty) + '개' : ''}</span></div>`).join('');
  const more = items.length > 4 ? `<div style="font-size:11.5px;color:var(--t3);padding-top:4px">외 ${items.length - 4}개 품목</div>` : '';
  let act = '';
  if (idx > 0) act += `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();basinBack('${b.id}')" title="이전 단계"><i class="ti ti-chevron-left"></i></button>`;
  if (idx <= 3) act += `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();basinAdvance('${b.id}')">다음 단계<i class="ti ti-chevron-right"></i></button>`;
  else if (idx === 4) act += `<button class="btn btn-sm" style="background:#0a5b46;color:#fff;border-color:#0a5b46" onclick="event.stopPropagation();basinShipOut('${b.id}')"><i class="ti ti-truck-delivery"></i>출고 처리 · 출고증</button>`;
  else if (done) act += `<button class="btn btn-sm" onclick="event.stopPropagation();printBasinSlip('${b.id}')"><i class="ti ti-printer"></i>출고증 인쇄</button>`;
  return `<div class="site" onclick="openBasinForm('${b.id}')">
    <div class="site-top">
      <div><div class="nm">${esc(b.vendor || '(업체미정)')}</div><div class="ad">${b.address ? `<i class="ti ti-map-pin" style="font-size:13px"></i>${esc(b.address)}` : `<span style="color:var(--t3)">주소 미지정</span>`}</div></div>
      <div style="text-align:right;flex:none">${basinPill(b.stage || '견적')}${(() => { const sc = shipConfirm('basin', b.id); return sc && sc.confirmed ? `<div style="margin-top:5px"><span class="pill" style="background:#e8f7f0;color:#0F6E56;font-size:10px"><i class="ti ti-checks"></i> 출하확인</span></div>` : ''; })()}</div>
    </div>
    <div class="site-meta">
      <div class="mi"><i class="ti ti-stack-2"></i><span class="k">품목</span><b>${items.length}건 · 총 ${totQty}개</b></div>
      <div class="mi"><i class="ti ti-calendar"></i><span class="k">발주일</span><b>${esc(b.orderDate || '-')}</b></div>
    </div>
    ${itemLines ? `<div style="margin:8px 0 2px">${itemLines}${more}</div>` : ''}
    <div class="date-row">
      <div class="db"><div class="k">발주일</div><div class="v">${esc(b.orderDate || '미정')}</div></div>
      <div class="db"><div class="k">출고일</div><div class="v">${esc((done ? b.shipDate : '') || '—')}</div></div>
    </div>
    <div class="tline">${tnodes}</div>
    <div style="display:flex;gap:6px;margin-top:11px;flex-wrap:wrap">${act}</div>
  </div>`;
}
async function basinSetStage(id, stage, extra) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  const history = Object.assign({}, b.history || {});
  if (!history[stage]) history[stage] = todayStr();
  await Store.update('basins', id, Object.assign({ stage, history }, extra || {}));
}
async function basinAdvance(id) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  const i = basinStageIndex(b); if (i >= BASIN_STAGES.length - 1) return;
  await basinSetStage(id, BASIN_STAGES[i + 1]);
}
async function basinBack(id) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  const i = basinStageIndex(b); if (i <= 0) return;
  const extra = (b.stage === '완료') ? { shipDate: '' } : null;   // 완료에서 되돌리면 출고일 해제
  await basinSetStage(id, BASIN_STAGES[i - 1], extra);
}
async function basinShipOut(id) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  if (!confirm('출고 처리하고 완료로 옮길까요?\n출고 대기열에 등록되고 출고증을 발행합니다.')) return;
  await basinSetStage(id, '완료', { shipDate: todayStr() });
  // 출고 대기열(출고관리)에 등록 — 세면대 출고. 소리 알림은 '출고 지시' 낼 때만.
  try {
    const its = basinItems(b);
    const qItems = its.map(it => ({ name: it.stone || '세면대', qty: (parseInt(it.qty, 10) || 0), spec: it.spec || '', unit: '개' }));
    if (qItems.length) await Store.add('chulgoReqs', { docNo: chulgoNextDocNo('출고'), reqType: '출고', client: b.vendor || '', items: qItems, status: '대기열', stockApplied: true, sourceBasinId: b.id, dispatchDest: b.address || '', memo: b.note || '', sender: (me && me.name) || '', createdAt: Date.now() });
  } catch (e) { }
  toast('출고 완료 · 대기열 등록 · 출고증 인쇄');
  setTimeout(() => printBasinSlip(id), 250);
}
function basinStoneSelectHtml(cls, val) {
  return `<select class="${cls}" onchange="basinLenHint()" style="width:100%;font-size:15px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px;background:#fff">${'<option value="">— 석종(컬러) 선택 —</option>' + BASIN_STONES.map(s => `<option value="${esc(s.k)}" ${val === s.k ? 'selected' : ''}>${esc(s.k)}${s.t ? ' · ' + s.t : ''}${s.maxLen ? ' · 최대' + s.maxLen : ''}</option>`).join('')}</select>`;
}
function basinItemRowHtml(it) {
  it = it || {};
  const inp = 'font-size:16px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px';
  return `<div class="bi-row" style="border:1px solid var(--bd2);border-radius:10px;padding:9px 10px;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:11.5px;color:var(--t3);font-weight:700">품목</span><button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.bi-row').remove();basinLenHint()" aria-label="삭제"><i class="ti ti-x"></i></button></div>
    ${basinStoneSelectHtml('bi-stone', it.stone)}
    <div style="display:flex;gap:6px;margin-top:6px">
      <input class="bi-spec" lang="en" placeholder="규격 예:1060*473*550" value="${esc(it.spec || '')}" oninput="basinLenHint()" style="flex:2;min-width:0;${inp}">
      <input class="bi-qty" inputmode="numeric" placeholder="수량" value="${esc(it.qty || '')}" style="flex:1;min-width:50px;${inp}">
    </div>
    <div style="display:flex;gap:6px;margin-top:6px">
      <input class="bi-order" placeholder="주문번호" value="${esc(it.orderNo || '')}" style="flex:1;min-width:0;${inp}">
      <input class="bi-quote" placeholder="견적번호" value="${esc(it.quoteNo || '')}" style="flex:1;min-width:0;${inp}">
    </div>
    <input class="bi-cny" inputmode="decimal" placeholder="위안화 원가 (¥)" value="${esc(it.priceCny || it.price || '')}" style="width:100%;margin-top:6px;${inp}">
    <input class="bi-krw" inputmode="numeric" placeholder="한화 원가 (통관비 포함, ₩) · 통관 담당자 기록" value="${esc(it.priceKrw || '')}" style="width:100%;margin-top:6px;${inp}">
  </div>`;
}
function addBasinItemRow() { const c = el('basin-items'); if (c) c.insertAdjacentHTML('beforeend', basinItemRowHtml({})); }
function collectBasinItems() {
  const items = [];
  [...document.querySelectorAll('#basin-items .bi-row')].forEach(r => {
    const g = sel => { const e2 = r.querySelector(sel); return e2 ? (e2.value || '').trim() : ''; };
    const stone = g('.bi-stone'), spec = g('.bi-spec'), qty = g('.bi-qty');
    if (stone || spec || qty) items.push({ stone, spec, qty, orderNo: g('.bi-order'), quoteNo: g('.bi-quote'), priceCny: g('.bi-cny'), priceKrw: g('.bi-krw') });
  });
  return items;
}
let _basinFromQuote = '';
function openBasinForm(id, pre) {
  _basinFromQuote = (pre && pre.quoteId) || '';
  const b = id ? (state.basins || []).find(x => x.id === id) : null;
  const v = b || pre || {};
  const rows = basinItems(v);
  const rowsHtml = (rows.length ? rows : [{}]).map(basinItemRowHtml).join('');
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-bath"></i>${b ? '세면대 발주 수정' : '세면대 발주 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>발주 업체명<span class="req">*</span></label>${searchBox('b-vendor', '업체명 검색·입력', v.vendor, 'companyNames', '')}</div>
      <div class="fld"><label>발주일</label><input type="date" id="b-orderDate" value="${esc(v.orderDate || todayStr())}"></div>
      <div class="fld full"><label>품목 (석종·규격·수량·주문번호)<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(한 업체 여러 세면대면 '품목 추가')</span></label>
        <div id="basin-items">${rowsHtml}</div>
        <div id="b-lenhint" style="display:none;margin:0 0 8px"></div>
        <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addBasinItemRow()"><i class="ti ti-plus"></i>품목 추가</button>
      </div>
      <div class="fld"><label>진행 단계</label><select id="b-stage">${BASIN_STAGES.map(st => `<option ${(v.stage || '견적') === st ? 'selected' : ''}>${st}</option>`).join('')}</select></div>
      <div class="fld full"><label>현장 주소 <span style="color:var(--t3);font-weight:500">(출고증에 표시)</span></label><input id="b-address" lang="ko" placeholder="현장 주소지" value="${esc(v.address || '')}"></div>
      <div class="fld full"><label>비고</label><input id="b-note" lang="ko" placeholder="선택" value="${esc(v.note || '')}"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);line-height:1.5;background:var(--soft);border-radius:9px;padding:9px 11px"><i class="ti ti-info-circle"></i> 납기 약 30~33일 · 세면대 1개당 브라켓 1SET 포함(팝업·수전·트랩 별도) · 발주 후 수정 불가</div>
    </div>
    <div class="frm-foot">${b ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="deleteBasin('${b.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitBasin('${b ? b.id : ''}')"><i class="ti ti-check"></i>${b ? '저장' : '등록'}</button></div>`);
  basinLenHint();
}
function basinLen(spec) { const m = String(spec || '').match(/\d+/); return m ? +m[0] : 0; }
function basinLenHint() {
  const box = el('b-lenhint'); if (!box) return;
  let msg = '';
  for (const r of [...document.querySelectorAll('#basin-items .bi-row')]) {
    const stone = (r.querySelector('.bi-stone') || {}).value || '';
    const sm = basinStoneMeta(stone);
    const len = basinLen((r.querySelector('.bi-spec') || {}).value || '');
    if (sm && sm.maxLen && len > sm.maxLen) { msg = `<b>${esc(stone)}</b>는 기장 ${sm.maxLen}mm까지만 제작 가능합니다 (현재 ${len}mm)`; break; }
  }
  if (msg) {
    box.style.display = 'block';
    box.innerHTML = `<div style="font-size:12px;color:#d64545;background:#fdeaea;border:1px solid #e6a9a9;border-radius:9px;padding:8px 10px"><i class="ti ti-alert-triangle"></i> ${msg}</div>`;
  } else { box.style.display = 'none'; box.innerHTML = ''; }
}
async function submitBasin(id) {
  const vendor = (el('b-vendor').value || '').trim();
  if (!vendor) { toast('발주 업체명을 입력하세요'); return; }
  const items = collectBasinItems();
  if (!items.some(it => it.stone)) { toast('품목의 석종(컬러)을 선택하세요'); return; }
  for (const it of items) {
    const sm = basinStoneMeta(it.stone);
    const len = basinLen(it.spec);
    if (sm && sm.maxLen && len > sm.maxLen) {
      if (!confirm(`${it.stone}는 기장 ${sm.maxLen}mm까지만 제작 가능합니다.\n현재 ${len}mm — 그래도 저장할까요?`)) return;
    }
  }
  const stage = el('b-stage').value || '견적';
  const cur = id ? (state.basins || []).find(x => x.id === id) : null;
  const history = Object.assign({}, (cur && cur.history) || {});
  if (!history[stage]) history[stage] = todayStr();
  const obj = {
    vendor, items,
    orderDate: el('b-orderDate').value || '',
    stage, history,
    address: (el('b-address').value || '').trim(),
    note: (el('b-note').value || '').trim(),
    orderNo: '', stone: '', spec: '', qty: '', quoteNo: '', price: ''   // 구버전 단일필드 정리
  };
  if (stage === '완료') obj.shipDate = (cur && cur.shipDate) ? cur.shipDate : todayStr();
  else obj.shipDate = '';
  await ensureClient(vendor);   // 신규 거래처 자동 등록
  if (id) await Store.update('basins', id, obj);
  else await Store.add('basins', obj);
  if (_basinFromQuote) { try { await Store.update('quotes', _basinFromQuote, { basinDone: true, basinDoneAt: Date.now() }); } catch (e) { } _basinFromQuote = ''; }
  closeModal();
  toast(id ? '수정되었습니다' : '세면대 발주가 등록되었습니다');
}
async function deleteBasin(id) {
  if (!guardDelete('이 발주 건을 삭제할까요?')) return;
  await Store.remove('basins', id);
  closeModal(); toast('삭제되었습니다');
}
/* ===== 인보이스/패킹리스트 업로드 → 업체명+규격 일치 발주를 '출항'으로 ===== */
function basinPackingUpload() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv';
  inp.onchange = () => basinPackingParse(inp);
  inp.click();
}
/* 규격 치수 3개를 순서 무관하게 정규화 (가로*세로*높이 vs 두께*폭*길이 차이 흡수) */
function _specKey(s) { const n = (String(s || '').match(/\d+/g) || []).map(Number).filter(x => x >= 10).sort((a, b) => a - b); return n.join('x'); }
function basinPackingParse(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const cells = [];
      wb.SheetNames.forEach(sn => {
        XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' })
          .forEach(row => row.forEach(c => { const s = String(c == null ? '' : c).trim(); if (s) cells.push(s); }));
      });
      basinPackingMatch(cells);
    } catch (err) { toast('파일을 읽지 못했습니다'); }
  };
  reader.readAsArrayBuffer(f);
}
function basinPackingMatch(cells) {
  const shipIdx = BASIN_STAGES.indexOf('출항');
  const specKeys = new Set();
  cells.forEach(s => { if (/\d{2,}\s*[*xX×]\s*\d{2,}\s*[*xX×]\s*\d{2,}/.test(s)) specKeys.add(_specKey(s)); });
  const lower = cells.map(c => c.toLowerCase());
  const matches = (state.basins || []).filter(b => {
    if ((b.stage || '견적') === '완료' || basinStageIndex(b) >= shipIdx) return false;   // 이미 출항 이후·완료는 제외
    const vendorHit = b.vendor && lower.some(c => c.includes(b.vendor.toLowerCase()));
    const specHit = basinItems(b).some(it => it.spec && specKeys.has(_specKey(it.spec)));
    return specHit && vendorHit;
  });
  if (!specKeys.size) { toast('파일에서 규격(치수)을 찾지 못했습니다'); return; }
  if (!matches.length) { toast('인보이스와 일치하는 발주(업체+규격)를 찾지 못했습니다'); return; }
  const list = matches.slice(0, 12).map(b => '· ' + (b.vendor || '') + ' (' + basinItems(b).length + '품목)').join('\n');
  if (!confirm(`인보이스와 일치하는 발주 ${matches.length}건을 '출항' 단계로 넘길까요?\n(업체명 + 규격 기준)\n\n${list}${matches.length > 12 ? '\n…' : ''}`)) return;
  basinPackingApply(matches.map(b => b.id));
}
async function basinPackingApply(ids) {
  let n = 0;
  for (const id of ids) { try { await basinSetStage(id, '출항'); n++; } catch (e) { } }
  toast(n + '건을 출항 단계로 이동했습니다');
}
/* ===== 세면대 수주 통계 (석종별 / 사이즈별) ===== */
function basinSizeBucket(spec) {
  const nums = (String(spec || '').match(/\d+/g) || []).map(Number).filter(x => x >= 10);
  if (!nums.length) return '미상';
  const max = Math.max(...nums);
  if (max <= 800) return '~800';
  if (max <= 1200) return '801~1200';
  if (max <= 1600) return '1201~1600';
  if (max <= 2200) return '1601~2200';
  return '2200~';
}
function openBasinStats() {
  const items = [];
  (state.basins || []).forEach(b => basinItems(b).forEach(it => items.push(it)));
  const qOf = it => parseInt(it.qty, 10) || 0;
  const totQty = items.reduce((a, it) => a + qOf(it), 0);
  const byStone = {}, bySize = {};
  items.forEach(it => {
    const sk = it.stone || '미상'; (byStone[sk] = byStone[sk] || { c: 0, q: 0 }); byStone[sk].c++; byStone[sk].q += qOf(it);
    const zk = basinSizeBucket(it.spec); (bySize[zk] = bySize[zk] || { c: 0, q: 0 }); bySize[zk].c++; bySize[zk].q += qOf(it);
  });
  const stoneRows = Object.entries(byStone).sort((a, b) => b[1].q - a[1].q || b[1].c - a[1].c);
  const sizeOrder = ['~800', '801~1200', '1201~1600', '1601~2200', '2200~', '미상'];
  const sizeRows = sizeOrder.filter(k => bySize[k]).map(k => [k, bySize[k]]);
  const palette = ['#0e9f6e', '#2f6fed', '#b5730a', '#7a44c9', '#d84b4a', '#0891b2', '#65a30d', '#db2777', '#5b6472', '#ca8a04', '#0a5b46', '#9333ea', '#e11d48', '#0369a1', '#4d7c0f'];
  const pct = v => totQty ? Math.round(v / totQty * 100) : 0;
  const stackBar = rows => totQty ? `<div style="display:flex;height:15px;border-radius:7px;overflow:hidden;margin-bottom:12px;background:var(--soft)">${rows.map(([k, o], i) => `<div title="${esc(k)} ${pct(o.q)}%" style="width:${o.q / totQty * 100}%;background:${palette[i % palette.length]}"></div>`).join('')}</div>` : '';
  const rowHtml = rows => rows.length ? rows.map(([k, o], i) => {
    const col = palette[i % palette.length];
    return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px;align-items:center;gap:8px"><span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="width:11px;height:11px;border-radius:3px;background:${col};flex:none"></span><b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(k)}</b></span><span style="color:var(--t2);flex:none;white-space:nowrap"><b style="color:var(--t1)">${o.q}개</b> · ${o.c}건 · ${pct(o.q)}%</span></div><div style="height:8px;background:var(--soft);border-radius:5px;overflow:hidden;margin-top:5px"><div style="width:${totQty ? o.q / totQty * 100 : 0}%;height:100%;background:${col}"></div></div></div>`;
  }).join('') : '<div style="color:var(--t3);font-size:13px">데이터 없음</div>';
  // 월별 (발주일 기준)
  const byMonth = {};
  (state.basins || []).forEach(b => {
    const m = ((b.orderDate || '').slice(0, 7)) || '미상';
    const its = basinItems(b);
    (byMonth[m] = byMonth[m] || { o: 0, c: 0, q: 0 });
    byMonth[m].o++; byMonth[m].c += its.length; its.forEach(it => byMonth[m].q += qOf(it));
  });
  const monthRows = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const maxMonthQ = Math.max(1, ...monthRows.map(r => r[1].q));
  const monthHtml = monthRows.length ? monthRows.map(([m, o]) => {
    const label = m === '미상' ? '미상' : m.replace('-', '.');
    return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px"><b>${esc(label)}</b><span style="color:var(--t2)"><b style="color:var(--t1)">${o.q}개</b> · ${o.o}발주 · ${o.c}품목</span></div><div style="height:8px;background:var(--soft);border-radius:5px;overflow:hidden;margin-top:5px"><div style="width:${Math.round(o.q / maxMonthQ * 100)}%;height:100%;background:#7a44c9"></div></div></div>`;
  }).join('') : '<div style="color:var(--t3);font-size:13px">데이터 없음</div>';
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-chart-bar"></i>세면대 수주 통계</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <div style="flex:1;background:var(--soft);border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:var(--t3)">발주</div><div style="font-size:18px;font-weight:800">${(state.basins || []).length}건</div></div>
      <div style="flex:1;background:var(--soft);border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:var(--t3)">품목</div><div style="font-size:18px;font-weight:800">${items.length}건</div></div>
      <div style="flex:1;background:var(--soft);border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:var(--t3)">수량</div><div style="font-size:18px;font-weight:800">${totQty}개</div></div>
    </div>
    <div style="font-weight:700;margin:6px 0 10px"><i class="ti ti-calendar-stats"></i> 월별 수주 <span style="color:var(--t3);font-weight:500;font-size:12px">(발주일 기준)</span></div>
    ${monthHtml}
    <div style="font-weight:700;margin:20px 0 10px"><i class="ti ti-color-swatch"></i> 석종(자재)별 수주 <span style="color:var(--t3);font-weight:500;font-size:12px">(개수·비율)</span></div>
    ${stackBar(stoneRows)}
    ${rowHtml(stoneRows)}
    <div style="font-weight:700;margin:20px 0 10px"><i class="ti ti-ruler-2"></i> 사이즈별 수주 <span style="color:var(--t3);font-weight:500;font-size:12px">(최대 치수 기준 · 개수·비율)</span></div>
    ${stackBar(sizeRows)}
    ${rowHtml(sizeRows)}
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="basinExportExcel()"><i class="ti ti-download"></i> 엑셀 다운로드</button><button class="btn btn-pri" style="flex:1" onclick="closeModal()">닫기</button></div>`);
}
/* 세면대 발주 내역 → 엑셀 (품목 1줄씩) */
function basinExportExcel() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const rows = [];
  (state.basins || []).slice()
    .sort((a, b) => (a.orderDate || '').localeCompare(b.orderDate || ''))
    .forEach(b => basinItems(b).forEach(it => {
      rows.push({
        '발주일': b.orderDate || '',
        '월': (b.orderDate || '').slice(0, 7),
        '업체명': b.vendor || '',
        '단계': b.stage || '견적',
        '석종': it.stone || '',
        '규격': it.spec || '',
        '수량': it.qty || '',
        '주문번호': it.orderNo || '',
        '견적번호': it.quoteNo || '',
        '위안화원가': it.priceCny || it.price || '',
        '한화원가(통관포함)': it.priceKrw || '',
        '현장주소': b.address || '',
        '출고일': b.shipDate || '',
        '비고': b.note || ''
      });
    }));
  if (!rows.length) { toast('내보낼 발주 내역이 없습니다'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '세면대발주');
  XLSX.writeFile(wb, `세면대발주내역_${todayStr()}.xlsx`);
  toast('엑셀 ' + rows.length + '줄 다운로드');
}
/* 세면대 출고증 — 회사 양식 재사용 + 현장주소 표시 (단일 발주 건 발행) */
function printBasinSlip(id) {
  const b = (state.basins || []).find(x => x.id === id);
  if (!b) { toast('발주 내역을 찾을 수 없습니다'); return; }
  const e = s => esc(s == null ? '' : String(s));
  const date = b.shipDate || todayStr();
  const sameDay = (state.basins || []).filter(x => x.stage === '완료' && (x.shipDate || '') === date).map(x => x.id).sort();
  const seq = Math.max(1, sameDay.indexOf(id) + 1);
  const docNo = date.replace(/-/g, '') + '-B' + seq;
  const route = b.address ? '다우세라믹 상차 →<br>' + e(b.address) + ' 하차' : '';
  const stamp = `<svg viewBox="0 0 200 200" width="150" height="150" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs><path id="arcTop" d="M 30,100 A 70,70 0 0 1 170,100"/></defs>
    <circle cx="100" cy="100" r="94" fill="none" stroke="#111" stroke-width="4"/>
    <text font-size="15" font-weight="700" fill="#111" letter-spacing="1"><textPath xlink:href="#arcTop" href="#arcTop" startOffset="50%" text-anchor="middle">주식회사 다우세라믹앤석재</textPath></text>
    <text x="100" y="68" text-anchor="middle" font-size="30" font-weight="800" fill="#111">출고</text>
    <line x1="32" y1="84" x2="168" y2="84" stroke="#111" stroke-width="3"/>
    <text x="100" y="110" text-anchor="middle" font-size="17" font-weight="700" fill="#111">${e(date)}</text>
    <line x1="32" y1="122" x2="168" y2="122" stroke="#111" stroke-width="3"/>
    <text x="100" y="152" text-anchor="middle" font-size="30" font-weight="800" fill="#111">확인</text>
  </svg>`;
  const items = basinItems(b);
  const MINROWS = Math.max(8, items.length);
  let rows = items.map((it, i) => `<tr><td class="c">${i + 1}</td><td class="l">${e(it.stone)}</td><td class="c">개</td><td class="c">${e(it.spec)}</td><td class="r">${e(it.qty)}</td><td class="l">${e([it.orderNo ? '주문 ' + it.orderNo : '', it.quoteNo ? '견적 ' + it.quoteNo : ''].filter(Boolean).join(' / '))}</td></tr>`).join('');
  for (let i = items.length; i < MINROWS; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>세면대 출고표 ${e(b.vendor)} ${e(date)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111;margin:0;padding:22px 26px}
  table{border-collapse:collapse;width:100%}
  .top{table-layout:fixed}
  .top td{border:1px solid #444;padding:8px 10px;vertical-align:middle}
  .doc{padding:0!important;text-align:center}
  .doc .dl{border-bottom:1px solid #444;padding:9px 6px;letter-spacing:4px;font-size:13px;font-weight:600}
  .doc .dv{padding:9px 6px;font-size:13.5px}
  .title{text-align:center;font-size:30px;font-weight:800;letter-spacing:16px}
  .issue{text-align:center;font-size:13px}
  .issue .ik{letter-spacing:3px;font-weight:600}
  .issue .iv{font-size:14px;font-weight:600;margin-top:5px;white-space:nowrap}
  .conm{text-align:center;font-size:18px;font-weight:800}
  .recip{text-align:center;vertical-align:middle}
  .recip .rn{font-size:24px;font-weight:800}
  .recip .rt{font-size:15px;font-weight:600;margin-top:22px;word-break:keep-all;line-height:1.55}
  .ck{text-align:center;font-weight:700;background:#f4f4f4;white-space:nowrap}
  .cv{font-size:13.5px}
  .cv .tel{font-size:12px;color:#333}
  .web{text-align:center;font-weight:800;text-decoration:underline;letter-spacing:1px}
  .items{table-layout:fixed;margin-top:14px}
  .items th{border:1px solid #444;background:#eee;padding:8px 6px;font-size:13.5px;font-weight:700}
  .items td{border:1px solid #444;padding:7px 6px;font-size:13px;height:31px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:12px}
  .who{table-layout:fixed;flex:1}
  .who td{border:1px solid #444;padding:10px 10px;font-size:13px}
  .who .wk{text-align:center;font-weight:700;background:#f4f4f4;width:16%}
  .stamp{flex:none;width:150px;height:150px}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <table class="top">
    <colgroup><col style="width:27%"><col style="width:14%"><col style="width:59%"></colgroup>
    <tr>
      <td class="doc"><div class="dl">문 서 번 호</div><div class="dv">${docNo}</div></td>
      <td class="title" colspan="2">출 고 표</td>
    </tr>
    <tr>
      <td class="issue"><div class="ik">발 행 일 자</div><div class="iv">${e(date)}</div></td>
      <td class="conm" colspan="2">${companyInfo().name}</td>
    </tr>
    <tr>
      <td class="recip" rowspan="6"><div class="rn">${e(b.vendor)}</div><div class="rt">${route}</div></td>
      <td class="ck">주 소</td><td class="cv">${companyInfo().addr}<br><span class="tel">${companyInfo().tel}</span></td>
    </tr>
    <tr><td class="ck">업 태</td><td class="cv">${companyInfo().biztype}</td></tr>
    <tr><td class="ck">대표이사</td><td class="cv">${companyInfo().ceo}</td></tr>
    <tr><td class="ck">등록번호</td><td class="cv">${companyInfo().bizno}</td></tr>
    <tr><td class="ck">E-mail</td><td class="cv">${companyInfo().email}</td></tr>
    <tr><td class="web" colspan="2">${companyInfo().web}</td></tr>
  </table>
  <table class="items">
    <colgroup><col style="width:6%"><col style="width:32%"><col style="width:10%"><col style="width:22%"><col style="width:12%"><col style="width:18%"></colgroup>
    <thead><tr><th>NO</th><th>품명</th><th>단위</th><th>규격</th><th>수량</th><th>비고</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="bottom">
    <table class="who"><tr><td class="wk">담당자</td><td>${e(me ? me.name : '')}</td></tr><tr><td class="wk">현장주소</td><td>${e(b.address || '')}</td></tr>${b.note ? `<tr><td class="wk">비 고</td><td>${e(b.note)}</td></tr>` : ''}</table>
    <div class="stamp">${stamp}</div>
  </div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}
let _shipFromQuote = '';
function openShipForm(pre) {
  _mrowPattern = true; _mrowDepot = true;
  _shipFromQuote = (pre && pre.quoteId) || '';
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-logout"></i>출고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>업체명<span class="req">*</span></label>${searchBox('o-targetName', '업체명 검색·입력', (pre && pre.targetName) || '', 'companyNames', '')}</div>
      <div class="fld full"><label>출고 자재 / 장수 / 롯트 / 패턴<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 자재는 '자재 추가')</span></label>${matRowsHtml(pre && pre.items && pre.items.length ? pre.items : (pre && pre.material ? [{ name: pre.material, qty: pre.jang, lot: pre.lot, pattern: pre.pattern }] : [{}]), '장수')}</div>
      <div class="fld"><label>출고일<span class="req">*</span></label><input type="date" id="o-date" value="${todayStr()}"></div>
      <div class="fld"><label>출고 창고 <span style="color:var(--t3);font-weight:500">(창고 여러 곳일 때만)</span></label><input id="o-depot" list="o-depot-list" placeholder="창고(선택)"><datalist id="o-depot-list">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full"><label>출고지(공장/현장)<span class="req">*</span></label>
        <select id="o-dest" onchange="onShipDest()">
          <option value="">선택…</option>
          <option value="업체 배차">🚚 업체 배차 (업체가 직접 수령·배차 — 출고지 입력 불필요)</option>
          ${state.factories.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(f => `<option value="${esc(f.value)}">${esc(f.value)} (공장)</option>`).join('')}
          <option value="__manual">직접 입력 (현장·기타)</option>
        </select>
      </div>
      <div class="fld full hidden" id="o-dest-manual"><label>출고지 직접 입력</label><input id="o-dest-text" placeholder="현장명/출고지 입력" autocomplete="off"></div>
      <div class="fld full"><label>메모</label><input id="o-note" placeholder="선택"></div>
      <div class="fld full" style="background:#fff2f0;border-radius:9px;padding:10px 12px"><label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;color:#b42318"><input type="checkbox" id="o-damaged" style="width:18px;height:18px"> <i class="ti ti-alert-square-rounded"></i>파손 자재 출고 <span style="font-weight:400;color:var(--t3);font-size:12px">(체크 시 파손 재고에서 차감 — 폐기·반품)</span></label></div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitShip()"><i class="ti ti-check"></i>출고 등록</button></div>`);
  if (pre && pre.targetName && el('o-targetName')) el('o-targetName').value = pre.targetName;
  mrowLotRefresh();
}
function pickOutItem() {
  const id = el('o-pick') && el('o-pick').value; if (!id) return;
  const it = state.inventory.find(i => i.id === id); if (!it) return;
  el('o-material').value = it.name; computeOutHebe();
}
function onShipDest() {
  const sel = el('o-dest'), box = el('o-dest-manual');
  if (!sel || !box) return;
  if (sel.value === '__manual') { box.classList.remove('hidden'); setTimeout(() => el('o-dest-text') && el('o-dest-text').focus(), 50); }
  else box.classList.add('hidden');
}
function shipDestValue() {
  const sel = el('o-dest'); if (!sel) return '';
  if (sel.value === '__manual') return (el('o-dest-text') && el('o-dest-text').value || '').trim();
  return sel.value;
}
function shipMatchedItem() { const nm = (el('o-material') && el('o-material').value || '').trim(); return nm ? state.inventory.find(i => i.name === nm) : null; }
function computeOutHebe() {
  const info = el('o-hebe-info');
  const nm = (el('o-material') && el('o-material').value || '').trim();
  // 롯트별 재고 표시 + 선택
  const wrap = el('o-lot-wrap');
  if (wrap) {
    const lots = lotStock(nm).filter(l => l.lot !== '(미지정)');
    if (lots.length) {
      const sel = el('o-lot'); const cur = sel ? sel.value : '';
      if (sel) sel.innerHTML = lotSelectHtml(nm, cur);
      if (el('o-lot-bd')) el('o-lot-bd').innerHTML = lotBreakdownText(nm);
      wrap.style.display = '';
    } else { wrap.style.display = 'none'; }
  }
  const pwrap = el('o-pattern-wrap');
  if (pwrap) {
    const pats = patternList(nm);
    if (pats.length) { const psel = el('o-pattern'); const pcur = psel ? psel.value : ''; if (psel) psel.innerHTML = patternSelectHtml(nm, pcur); pwrap.style.display = ''; }
    else { pwrap.style.display = 'none'; }
  }
  if (!info) return;
  const it = shipMatchedItem(); const jang = parseFloat(el('o-jang').value) || 0;
  if (it) info.innerHTML = `<span class="rl">재고 연동</span><span class="rv"><b>${(jang * (+it.hebePerJang || 0)).toFixed(2)}㎡</b><small>${esc(it.name)} · 출고 시 ${jang}장 차감</small></span>`;
  else info.innerHTML = `<span class="rl">재고 미연동</span><span class="rv" style="color:var(--t3)">출고 기록만 남김 (재고 차감 없음)</span>`;
}
async function submitShip() {
  const targetName = el('o-targetName').value.trim();
  const rows = collectMaterialRows();
  const date = el('o-date').value;
  if (!targetName) { toast('업체명을 입력하세요'); return; }
  if (!rows.length) { toast('출고 자재와 장수를 입력하세요'); return; }
  if (!date) { toast('출고일을 선택하세요'); return; }
  const dest = shipDestValue();
  if (!dest) { toast('출고지(공장/현장)를 입력하세요'); return; }
  if (_busy) return; _busy = true;
  try {
    await ensureClient(targetName);   // 신규 거래처 자동 등록
    const shipId = 'S' + Date.now();
    const note = el('o-note').value.trim();
    const damaged = !!(el('o-damaged') && el('o-damaged').checked);   // 파손 자재 출고
    let totalJang = 0; const zeroed = [];
    for (const r of rows) {
      const material = r.name, jang = r.qty;
      const it = state.inventory.find(i => i.name === material);
      const oldJang = it ? (+it.jang || 0) : 0;
      const newJang = Math.max(0, oldJang - jang);
      const hebe = it ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
      const lot = (r.lot && r.lot.trim()) ? r.lot.trim() : soleLot(material);   // 롯트 미지정인데 남은 롯트가 하나면 자동 연동
      const oDepot = (r.depot && r.depot.trim()) ? r.depot.trim() : (el('o-depot') && el('o-depot').value || '').trim();   // 행별 창고 우선(창고별 재고), 없으면 폼 상단 창고
      if (it) await Store.update('inventory', it.id, { jang: newJang });
      await Store.add('transactions', { type: 'out', shipId, itemId: it ? it.id : '', itemName: material, spec: it ? it.spec : '', hebe, jang, lot, pattern: r.pattern, depot: oDepot, dest, factory: dest, target: '', targetName, date, note, damaged, createdAt: Date.now(), by: me.name });
      totalJang += jang;
      if (it && oldJang > 0 && newJang <= 0) zeroed.push(material);
    }
    if (_holdConfirm) { await Store.update('holdings', _holdConfirm, { status: '확정', shippedDate: date, shippedJang: totalJang, confirmShipId: shipId }); _holdConfirm = null; }
    for (const nm of zeroed) notifyStockOut(nm);   // 재고 소진 → 즉시 푸시
    // 출고 대기열(출고관리)에 등록 — 재고는 위에서 이미 차감됨(stockApplied). 소리 알림은 '출고 지시' 낼 때만.
    try {
      const qItems = rows.map(r => ({ name: r.name, qty: r.qty, spec: r.lot || '', unit: '장' }));
      await Store.add('chulgoReqs', { docNo: chulgoNextDocNo('출고'), reqType: '출고', client: targetName, items: qItems, status: '대기열', stockApplied: true, sourceShipId: shipId, dispatchDest: dest, memo: note || '', sender: (me && me.name) || '', createdAt: Date.now() });
    } catch (e) { }
    if (_shipFromQuote) { try { await Store.update('quotes', _shipFromQuote, { shipped: true, shippedAt: Date.now() }); } catch (e) { } _shipFromQuote = ''; }
    closeModal();
    toast(`출고 등록 · 대기열 등록 · 출고증 인쇄`);
    filters.shipTab = 'slip'; go('ship');   // 출고증 인쇄 페이지로 이동
    setTimeout(() => { try { printShipSlip(shipId); } catch (e) { } }, 800);   // 바로 인쇄
  } finally { _busy = false; }
}
/* 출고 삭제 (관리자) — 재고 연동분 자동 복구(+장수) */
async function delShip(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  if (!guardDelete(`이 출고를 삭제할까요?\n${t.itemName} ${t.jang}장 · ${t.date}\n재고 연동분은 자동 복구됩니다.`)) return;
  if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); }
  await Store.remove('transactions', id);
  const key = t.shipId || t.id;
  // 같은 출고건이 더 없으면, 이 출고로 '확정'된 홀딩을 홀딩 상태로 되돌림(출고완료 해제) + 출고관리 항목 제거
  if (!state.transactions.some(x => x.id !== id && x.type === 'out' && (x.shipId || x.id) === key)) {
    await revertHoldsForShip(key);
    for (const cr of (state.chulgoReqs || []).filter(r => r.sourceShipId === key)) { try { await Store.remove('chulgoReqs', cr.id); } catch (e) { } }
  }
  toast('출고 삭제됨 (재고 복구)');
}
/* 이 출고(shipId)로 확정됐던 홀딩을 되돌림 — 출고완료 해제 → 홀딩 */
async function revertHoldsForShip(key) {
  for (const h of state.holdings.filter(h => h.confirmShipId === key)) {
    await Store.update('holdings', h.id, { status: '홀딩', shippedDate: '', shippedJang: 0, confirmShipId: '' });
  }
}
/* 출고 묶음 삭제 (관리자) — 같은 shipId 전체 복구 */
async function delShipGroup(key) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const list = state.transactions.filter(t => t.type === 'out' && (t.shipId || t.id) === key);
  if (!list.length) return;
  if (!guardDelete(`이 출고(${list.length}건)를 삭제할까요?\n${list.map(t => `${t.itemName} ${t.jang}장`).join(', ')}\n재고 연동분은 자동 복구됩니다.`)) return;
  for (const t of list) {
    if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); }
    await Store.remove('transactions', t.id);
  }
  await revertHoldsForShip(key); // 출고완료됐던 홀딩 되돌리기
  for (const cr of (state.chulgoReqs || []).filter(r => r.sourceShipId === key)) { try { await Store.remove('chulgoReqs', cr.id); } catch (e) { } }   // 출고관리 대기열/지시도 함께 제거
  toast(`출고 ${list.length}건 삭제됨 (재고 복구)`);
}
/* 입고 삭제 (관리자) — 오입고 정정: 재고에서 그만큼 차감(되돌림) */
async function delIn(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  if (!guardDelete(`이 입고를 삭제할까요?\n${t.itemName} ${t.jang}장 · 롯트 ${t.lot || '-'} · ${t.date}\n재고에서 그만큼 되돌립니다. (수정하려면 삭제 후 다시 입고)`)) return;
  if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - (+t.jang || 0)) }); }
  await Store.remove('transactions', id);
  toast('입고 삭제됨 (재고 되돌림)');
}

/* ===================================================================
   홀딩 (업체 · 장수/헤베 · 사용일정)
   =================================================================== */
function holdMatchesSearch(h) {
  const q = (filters.holdSearch || '').trim().toLowerCase();
  if (!q) return true;
  if ((h.vendor || '').toLowerCase().includes(q)) return true;
  if ((h.forSiteName || '').toLowerCase().includes(q)) return true;
  return holdItems(h).some(it => (it.materialName || '').toLowerCase().includes(q));
}
function holdCardHtml(h) {
  const d = daysFromNow(h.useDate);
  const conf = h.status === '확정';
  const plan = h.status === '예정';
  const rel = h.status === '해제';
  const cls = conf ? 'p-done' : (d != null && d >= 0 && d <= 3 ? 'p-wait' : 'p-hold');
  const foot = rel ? `<div style="display:flex;gap:8px"><button class="btn btn-sm" style="flex:1" onclick="restoreHold('${h.id}')"><i class="ti ti-refresh"></i>복원</button>${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>영구삭제</button>` : ''}</div>` : (conf ? `<div style="display:flex;gap:8px"><button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}</div>` : (plan ? `
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}
        </div>` : `
        <div style="display:flex;gap:8px">
          <button class="btn btn-pri btn-sm" style="flex:1" onclick="holdToSite('${h.id}')"><i class="ti ti-building-community"></i>현장으로</button>
          <button class="btn btn-pri btn-sm" style="flex:1;background:var(--blue);border-color:var(--blue)" onclick="holdToShip('${h.id}')"><i class="ti ti-truck-delivery"></i>출고로</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}
        </div>`));
  return `<div class="card hold-card" style="margin-bottom:11px;${conf ? 'opacity:.92' : ''}">
        <div class="hold-card-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div><div style="font-size:14px;font-weight:600;color:var(--t2)"><i class="ti ti-briefcase" style="font-size:13px"></i> ${esc(h.vendor || '-')}</div>${h.forSiteName ? `<div style="margin-top:5px"><span class="pill p-hold"><i class="ti ti-building-community"></i>${esc(h.forSiteName)}</span></div>` : ''}</div>
          ${rel ? `<span class="pill p-gray"><i class="ti ti-lock-open"></i>해제됨</span>` : (conf ? `<span class="pill p-done"><i class="ti ti-circle-check"></i>확정</span>` : (plan ? `<span class="pill p-wait"><i class="ti ti-clock-pause"></i>예정 · 입고대기</span>` : `<span class="pill ${cls}"><i class="ti ti-calendar"></i>${h.useDate || '미정'}${d != null && d >= 0 && d <= 7 ? ' · D-' + d : ''}</span>`))}
        </div>
        <div style="margin:6px 0 4px">
          ${holdItems(h).map(it => `<div style="margin-bottom:3px"><span style="font-size:15px;font-weight:700;color:var(--t1);word-break:keep-all">${esc(it.materialName || '-')}</span> <span style="color:var(--t2);font-size:12.5px">· ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}${it.lot ? ` · 롯트 ${esc(it.lot)}` : ''}${it.pattern ? ` · 패턴 ${esc(it.pattern)}` : ''}</span>${it.planned ? ` <span style="font-size:10.5px;font-weight:700;color:#9a6a12;background:#fef3e2;border-radius:5px;padding:1px 6px">예정</span>` : (!plan && holdItems(h).some(x => x.planned) ? ` <span style="font-size:10.5px;font-weight:700;color:#0F6E56;background:var(--gl2,#e8f7f0);border-radius:5px;padding:1px 6px">확보</span>` : '')}</div>`).join('')}
        </div>
        ${!plan && !conf && !rel && holdItems(h).some(x => x.planned) ? `<div style="font-size:12px;color:var(--amber-t);margin-top:4px"><i class="ti ti-clock-pause"></i> '예정' 품목은 입고되면 자동으로 확보됩니다</div>` : ''}
        ${conf ? `<div style="font-size:12px;color:var(--lime-t);margin-top:4px"><i class="ti ti-truck-delivery"></i> 출고 완료 ${esc(h.shippedDate || '')} · ${+h.shippedJang || 0}장</div>` : ''}
        ${plan ? `<div style="font-size:12px;color:var(--amber-t);margin-top:4px"><i class="ti ti-clock-pause"></i> 입고되면 자동으로 홀딩으로 전환됩니다</div>` : ''}
        ${rel && h.releasedAuto ? `<div style="font-size:12px;color:var(--t3);margin-top:4px"><i class="ti ti-history"></i> 사용예정일 경과로 자동 해제됨 (${esc(h.releasedDate || '')})</div>` : ''}
        ${h.note ? `<div style="font-size:12px;color:var(--t3);margin-top:6px">${esc(h.note)}</div>` : ''}
        ${!conf && !rel && holdItems(h).some(x => x.planned) ? `<button class="btn btn-sm btn-block" style="margin-top:8px;color:#7a5b2e;border-color:#e0c088;background:#fdf6ea" onclick="pullStockForHold('${h.id}')"><i class="ti ti-transfer-in"></i> 다른 홀딩에서 재고 당겨오기</button>` : ''}
        </div>
        <div class="hold-card-foot" style="margin-top:10px">${foot}</div>
      </div>`;
}
/* 홀딩 목록 → 2칸 카드 그리드 */
function holdTableHtml(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  return `<div class="hold-grid">${list.map(holdCardHtml).join('')}</div>`;
}
function openHoldDetail(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  openModal(`<div class="sheet-h"><h3><i class="ti ti-lock"></i>홀딩 상세</h3><button class="x" onclick="closeModal()">×</button></div>${holdCardHtml(h)}`);
}
function holdGroupedHtml(list, keyFn, icon) {
  const map = new Map();
  list.forEach(h => keyFn(h).forEach(k => {
    if (!map.has(k)) map.set(k, []);
    const arr = map.get(k); if (!arr.some(x => x.id === h.id)) arr.push(h);
  }));
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  if (!keys.length) return `<div class="empty"><i class="ti ti-lock-off"></i>해당하는 홀딩이 없습니다</div>`;
  return keys.map(k => `<div class="sec-label" style="margin-top:8px"><i class="ti ${icon}"></i> ${esc(k)} <span style="color:var(--t3);font-weight:500">· ${map.get(k).length}건</span></div>${holdTableHtml(map.get(k))}`).join('');
}
/* 홀딩 화면 보기 전환: 'active'(진행+예정) / 'done'(출고완료) / 'released'(지난·해제) */
function goHoldView(v) { filters.holdDone = (v === 'done'); filters.holdArchive = (v === 'released'); renderHold(); }
/* 현재 보기/검색이 적용된 홀딩 목록 (기한 임박순). 기본은 출고완료·해제 제외 */
function holdFilteredList() {
  const isResv = h => (h.status || '홀딩') === '홀딩';
  let base;
  if (filters.holdArchive) base = state.holdings.filter(h => h.status === '해제');
  else if (filters.holdDone) base = state.holdings.filter(h => h.status === '확정');
  else base = state.holdings.filter(h => !['해제', '확정'].includes(h.status));   // 진행 홀딩 + 예정홀딩
  return base.filter(holdMatchesSearch).sort((a, b) => {
    const ra = isResv(a) ? 0 : 1, rb = isResv(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'); // 기한 임박순
  });
}
function holdStatusText(h) { const s = h.status || '홀딩'; return s === '확정' ? '출고완료' : s; }
/* 홀딩 목록 → 엑셀(.xls) 다운로드. 업체별로 묶어 한눈에 */
function downloadHoldXls() {
  const list = holdFilteredList().slice().sort((a, b) => (a.vendor || '').localeCompare(b.vendor || '') || (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'));
  const rows = [];
  list.forEach(h => holdItems(h).forEach(it => rows.push({ vendor: h.vendor || '', mat: it.materialName || '', jang: +it.jang || 0, hebe: +it.hebe || 0, lot: it.lot || '', pattern: it.pattern || '', useDate: h.useDate || '', site: h.forSiteName || '', status: holdStatusText(h), note: h.note || '' })));
  if (!rows.length) { toast('내보낼 홀딩이 없습니다'); return; }
  const tj = rows.reduce((a, b) => a + b.jang, 0), th = rows.reduce((a, b) => a + b.hebe, 0);
  const TH = (t, w) => `<th style="background:#0F6E56;color:#fff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const body = rows.map((r, i) => {
    const bg = i % 2 ? 'background:#f3f6f4;' : '';
    return `<tr>${TD(esc(r.vendor), bg)}${TD('<b>' + esc(r.mat) + '</b>', bg)}${TD(r.jang, bg + 'text-align:right')}${TD(r.hebe.toFixed(2), bg + 'text-align:right')}${TD(esc(r.lot), bg)}${TD(esc(r.pattern), bg)}${TD(esc(r.useDate), bg)}${TD(esc(r.site), bg)}${TD(esc(r.status), bg)}${TD(esc(r.note), bg)}</tr>`;
  }).join('');
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const scope = (filters.holdSearch || '').trim() ? `검색 "${esc(filters.holdSearch.trim())}"` : (filters.holdArchive ? '지난·해제' : (filters.holdDone ? '출고완료' : '진행중'));
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>홀딩내역</x:Name><x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="10" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 자재 홀딩 내역</td></tr>
<tr><td colspan="10" style="font-size:9pt;color:#777;padding:0 4px 10px">범위 ${scope}  ·  생성일 ${todayStr()}  ·  총 ${rows.length}건</td></tr>
<tr>${TH('업체', 130)}${TH('자재명', 160)}${TH('장수', 60)}${TH('헤베(㎡)', 80)}${TH('롯트', 110)}${TH('패턴', 100)}${TH('사용예정일', 100)}${TH('현장', 130)}${TH('상태', 80)}${TH('비고', 160)}</tr>
${body}
<tr><td colspan="2" style="${sumStyle};text-align:right">합계</td><td style="${sumStyle};text-align:right">${tj}</td><td style="${sumStyle};text-align:right">${th.toFixed(2)}</td><td colspan="6" style="${sumStyle}"></td></tr>
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '홀딩내역_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('홀딩 엑셀 다운로드 (' + rows.length + '건)');
}
/* 홀딩 목록 → 한눈에 보는 표(내역). 출고내역처럼 따로 스크롤 */
function holdListTableHtml(list) {
  const rows = [];
  list.forEach(h => holdItems(h).forEach(it => rows.push({ h, it })));
  if (!rows.length) return `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  const stColor = st => st === '예정' ? 'var(--amber-t)' : (st === '출고완료' ? 'var(--gd)' : (st === '해제' ? 'var(--t3)' : 'var(--blue)'));
  const body = rows.map(({ h, it }) => {
    const st = it.planned && (h.status || '홀딩') === '홀딩' ? '예정' : holdStatusText(h);   // 품목별 예정 반영
    return `<tr onclick="openHoldDetail('${h.id}')" style="cursor:pointer">
      <td>${esc(h.useDate || '-')}</td>
      <td><b>${esc(h.vendor || '-')}</b></td>
      <td style="word-break:keep-all">${esc(it.materialName || '-')}</td>
      <td style="text-align:right">${(+it.jang || 0)}</td>
      <td style="text-align:right">${(+it.hebe || 0).toFixed(1)}</td>
      <td>${esc(h.forSiteName || '-')}</td>
      <td style="color:${stColor(st)};font-weight:700">${esc(st)}</td>
    </tr>`;
  }).join('');
  return `<div class="tbl-wrap" id="holdlist-wrap" data-keepscroll style="max-height:calc(100vh - 320px);overflow:auto">
    <table class="tbl"><thead><tr><th>예정일</th><th>거래처</th><th>자재</th><th>장수</th><th>헤베</th><th>현장</th><th>상태</th></tr></thead><tbody>${body}</tbody></table>
  </div>`;
}
/* 홀딩 목록 본문만 계산 (검색 시 이 부분만 갱신 → 입력 포커스 유지) */
function holdBodyHtml() {
  const list = holdFilteredList();
  if ((filters.holdLayout || 'card') === 'table') return holdListTableHtml(list);
  const g = filters.holdGroup || 'none';
  let inner;
  if (!list.length) inner = `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  else if (g === 'material') inner = holdGroupedHtml(list, h => { const ms = holdItems(h).map(it => it.materialName || '(자재 미지정)'); return ms.length ? [...new Set(ms)] : ['(자재 미지정)']; }, 'ti-box');
  else if (g === 'vendor') inner = holdGroupedHtml(list, h => [h.vendor || '(업체 미지정)'], 'ti-briefcase');
  else inner = holdTableHtml(list);
  return `<div class="hold-scroll">${inner}</div>`;
}
/* 검색어 입력 시: 전체 재렌더 없이 목록 영역만 교체 (모바일 한글 입력 끊김 방지) */
function filterHold() {
  filters.holdSearch = el('hold-search') ? el('hold-search').value : '';
  if (el('hold-body')) el('hold-body').innerHTML = holdBodyHtml();
  const x = el('hold-search-x'); if (x) x.style.display = (filters.holdSearch || '').trim() ? '' : 'none';
}
function clearHoldSearch() {
  filters.holdSearch = ''; if (el('hold-search')) el('hold-search').value = '';
  filterHold(); const i = el('hold-search'); if (i) i.focus();
}
/* 직원용 고객 홀딩 요청 검토 섹션 (홀딩 화면 상단) */
function staffHoldReqHtml() {
  const all = (state.holdRequests || []).slice().sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  if (!all.length) return '';
  const pending = all.filter(r => (r.status || '대기') === '대기');
  const past = all.filter(r => (r.status || '대기') !== '대기');
  const showArch = !!filters.holdReqArchive;
  const rowFn = (r, isPending) => {
    const items = (r.items || []).map(it => `<b>${esc(it.materialName || '-')}</b> ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}`).join(', ');
    const when = r.createdAt ? new Date(+r.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '';
    const st = r.status || '대기';
    const badge = st === '승인' ? `<span style="flex:none;font-size:11px;font-weight:700;background:var(--gl2,#e8f7f0);color:#0F6E56;border-radius:999px;padding:3px 10px">승인</span>` : (st === '취소' ? `<span style="flex:none;font-size:11px;font-weight:700;background:var(--soft);color:var(--t3);border-radius:999px;padding:3px 10px">취소</span>` : '');
    return `<div style="border-top:0.5px solid var(--bd);padding:10px 13px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="min-width:0"><div style="font-size:13.5px;word-break:keep-all"><b style="color:var(--blue)">${esc(r.vendor || '')}</b> · ${items}</div>
        <div style="font-size:11.5px;color:var(--t3);margin-top:3px">${r.useDate ? '사용예정 ' + esc(r.useDate) + ' · ' : ''}요청 ${when}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
        ${!isPending ? badge : ''}
      </div>
      ${!isPending && st === '취소' && r.rejectReason ? `<div style="font-size:11.5px;color:var(--red-t);margin-top:5px;background:#fff2f0;border-radius:8px;padding:6px 9px"><i class="ti ti-message-2" style="font-size:12px"></i> 취소 사유: ${esc(r.rejectReason)}</div>` : ''}
      ${isPending ? `<div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-sm btn-pri" style="flex:1" onclick="prefillHoldFromReq('${r.id}')"><i class="ti ti-lock-check"></i>확인 · 홀딩 등록</button>
        <button class="btn btn-sm btn-danger" style="flex:none" onclick="rejectHoldReq('${r.id}')"><i class="ti ti-x"></i>취소</button>
      </div>` : ''}
    </div>`;
  };
  const pendHtml = pending.length ? pending.map(r => rowFn(r, true)).join('') : `<div style="padding:12px 13px;font-size:12.5px;color:var(--t3)">대기 중인 요청이 없습니다</div>`;
  return `<div class="card" style="padding:0;margin-bottom:12px;border:1.5px solid ${pending.length ? '#f0b048' : 'var(--bd)'};overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 13px;background:${pending.length ? '#fef3e2' : 'var(--soft)'}">
      <div style="font-weight:700;font-size:14px"><i class="ti ti-bell-ringing" style="color:${pending.length ? '#9a6a12' : 'var(--t3)'}"></i> 고객 홀딩 요청${pending.length ? ` <span style="color:#9a6a12">· 대기 ${pending.length}</span>` : ''}</div>
      ${past.length ? `<button class="btn btn-ghost btn-sm" onclick="filters.holdReqArchive=${showArch ? 'false' : 'true'};renderHold()">${showArch ? '지난 요청 숨기기' : `지난 요청 (${past.length})`}</button>` : ''}
    </div>
    ${pendHtml}
    ${showArch ? past.map(r => rowFn(r, false)).join('') : ''}
  </div>`;
}
async function rejectHoldReq(id) {
  const r = (state.holdRequests || []).find(x => x.id === id); if (!r) return;
  const reason = prompt('취소 사유를 입력하세요 (고객에게 그대로 전달됩니다)', '');
  if (reason === null) return;   // 취소 안 함
  await Store.update('holdRequests', id, { status: '취소', rejectReason: (reason || '').trim(), handledBy: me.name, handledAt: Date.now() });
  toast('요청을 취소 처리했습니다 (사유 전달)');
}
/* 요청 → 홀딩 등록 연동: 등록 완료 시 해당 요청을 '승인'으로 표시하기 위한 링크 */
let _holdReqLink = '';
function prefillHoldFromReq(id) {
  const r = (state.holdRequests || []).find(x => x.id === id); if (!r) return;
  openHoldForm('', { vendor: r.vendor, useDate: r.useDate || '', note: r.note || '', items: (r.items || []).map(it => ({ materialName: it.materialName, jang: it.jang })) });
  _holdReqLink = id;   // openHoldForm 이 먼저 초기화하므로 그 뒤에 설정
}
function renderHold() {
  const isResv = h => (h.status || '홀딩') === '홀딩';
  const released = state.holdings.filter(h => h.status === '해제');
  const active = state.holdings.filter(h => h.status !== '해제');
  const reserved = active.filter(isResv);
  const planned = active.filter(h => h.status === '예정');
  const confirmed = active.filter(h => h.status === '확정');
  const soon = reserved.filter(h => { const d = daysFromNow(h.useDate); return d != null && d >= 0 && d <= 3; });
  const g = filters.holdGroup || 'none';
  const view = filters.holdArchive ? 'released' : (filters.holdDone ? 'done' : 'active');
  const gchip = (v, label, ic) => `<button class="chip ${g === v ? 'active' : ''}" onclick="filters.holdGroup='${v}';renderHold()"><i class="ti ${ic}"></i> ${label}</button>`;
  const viewBanner = view === 'done' ? `<div class="banner info" style="margin-bottom:10px"><i class="ti ti-circle-check"></i> <b>출고완료</b> 홀딩 내역입니다. 위 '진행 홀딩으로'를 누르면 돌아갑니다.</div>`
    : (view === 'released' ? `<div class="banner info" style="margin-bottom:10px"><i class="ti ti-history"></i> <b>지난·해제</b> 홀딩 내역입니다.</div>` : '');
  const viewBtns = view !== 'active'
    ? `<button class="btn btn-block" style="margin-bottom:10px" onclick="goHoldView('active')"><i class="ti ti-arrow-left"></i>진행 홀딩으로 돌아가기</button>`
    : `<div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="btn" style="flex:1" onclick="goHoldView('done')"><i class="ti ti-circle-check"></i>출고완료 내역${confirmed.length ? ' (' + confirmed.length + ')' : ''}</button>
        <button class="btn" style="flex:1" onclick="goHoldView('released')"><i class="ti ti-history"></i>지난·해제${released.length ? ' (' + released.length + ')' : ''}</button>
      </div>`;
  el('pg-hold').innerHTML = `
    <div>
      <div class="ph"><div><h2><i class="ti ti-lock"></i>자재 홀딩</h2><p>홀딩 ${reserved.length} · 예정 ${planned.length} · 확정 ${confirmed.length}${soon.length ? ' · 임박 ' + soon.length : ''}</p></div>
        <button class="btn btn-pri btn-sm" onclick="openHoldForm()"><i class="ti ti-plus"></i>홀딩 등록</button></div>
      <div class="search-box">
        <i class="ti ti-search"></i>
        <input id="hold-search" placeholder="업체명·자재명 검색" value="${esc(filters.holdSearch || '')}" oninput="filterHold()" autocomplete="off">
        <button class="search-x" id="hold-search-x" style="${(filters.holdSearch || '').trim() ? '' : 'display:none'}" onclick="clearHoldSearch()"><i class="ti ti-x"></i></button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">
        <div class="chips" style="margin:0">${gchip('none', '전체', 'ti-list')}${gchip('material', '자재별', 'ti-box')}${gchip('vendor', '업체별', 'ti-briefcase')}</div>
        <div style="display:flex;gap:8px;align-items:center;flex:none">
          <div class="chips" style="margin:0">
            <button class="chip ${(filters.holdLayout || 'card') === 'card' ? 'active' : ''}" onclick="filters.holdLayout='card';renderHold()"><i class="ti ti-layout-grid"></i> 카드</button>
            <button class="chip ${filters.holdLayout === 'table' ? 'active' : ''}" onclick="filters.holdLayout='table';renderHold()"><i class="ti ti-table"></i> 표</button>
          </div>
          <button class="btn btn-sm" style="flex:none" onclick="downloadHoldXls()"><i class="ti ti-file-spreadsheet"></i>엑셀</button>
        </div>
      </div>
      ${staffHoldReqHtml()}
      ${viewBtns}
      ${viewBanner}
      <div id="hold-body">${holdBodyHtml()}</div>
    </div>`;
}
function openHoldForm(id, pre) {
  const h = id ? state.holdings.find(x => x.id === id) : null; const v = h || Object.assign({}, pre || {});
  _mrowPattern = true; _mrowDepot = false; _holdReqLink = '';   // 일반 홀딩 등록이면 요청 연동 없음
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-lock-plus"></i>${h ? '홀딩 수정' : '홀딩 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      ${state.sites.length ? `<div class="fld full"><label><i class="ti ti-building-community" style="font-size:13px;color:var(--blue)"></i> 현장에서 선택 <span style="color:var(--t3);font-weight:500">— 고르면 자재·수량·시공일 자동 입력</span></label><select id="h-site" onchange="pickHoldSite()"><option value="">— 직접 입력 —</option>${siteOptions(v.forSiteId || '')}</select></div>` : ''}
      <div class="fld"><label>업체/거래처<span class="req">*</span></label>${searchBox('h-vendor', '업체명 검색·입력', v.vendor, 'companyNames', '')}</div>
      <div class="fld"><label>사용 예정일</label><input type="date" id="h-useDate" value="${esc(v.useDate || '')}"></div>
      <div class="fld full"><label>자재 / 장수 / 롯트 <span style="color:var(--t3);font-weight:500">(여러 종류면 '자재 추가')</span></label>${matRowsHtml(holdItems(v).map(it => ({ name: it.materialName, qty: it.jang || '', lot: it.lot })), '장수')}</div>
      <div class="fld full"><label>메모</label><input id="h-note" value="${esc(v.note || '')}" placeholder="선택"></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitHold('${id || ''}')"><i class="ti ti-check"></i>${h ? '저장' : '등록'}</button>
    </div>`);
  mrowLotRefresh();
}
/* 홀딩 자재명 옆에 잔여 재고 표시 + 헤베 자동환산 */
function onHoldMaterial() {
  const nm = (el('h-material') && el('h-material').value || '').trim();
  const box = el('h-stock');
  const it = state.inventory.find(i => i.name === nm);
  if (box) {
    if (it) { const av = availJang(it); box.innerHTML = `· 가용 <b style="color:${av <= 0 ? 'var(--red-t)' : 'var(--gd)'}">${av}장</b> / 실재고 ${+it.jang || 0}장`; }
    else if (nm) box.innerHTML = `· <span style="color:var(--amber-t)">재고에 없는 자재 (입고 시 자동 전환)</span>`;
    else box.textContent = '';
  }
  const wrap = el('h-lot-wrap');
  if (wrap) {
    const lots = lotStock(nm).filter(l => l.lot !== '(미지정)');
    if (lots.length) {
      const sel = el('h-lot'); const cur = sel ? sel.value : '';
      if (sel) sel.innerHTML = lotSelectHtml(nm, cur);
      if (el('h-lot-bd')) el('h-lot-bd').innerHTML = lotBreakdownText(nm);
      wrap.style.display = '';
    } else { wrap.style.display = 'none'; }
  }
  onHoldQty();
}
/* 홀딩 장수 → 헤베 자동환산 (자재가 재고에 있을 때, 장당 헤베 사용) */
function onHoldQty() {
  const nm = (el('h-material') && el('h-material').value || '').trim();
  const it = state.inventory.find(i => i.name === nm);
  const jang = parseFloat(el('h-jang') && el('h-jang').value) || 0;
  if (it && el('h-hebe')) el('h-hebe').value = (jang * (+it.hebePerJang || 0)).toFixed(2);
}
function pickHoldSite() {
  const id = el('h-site').value; if (!id) return;
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const box = el('mat-rows');
  if (box) { box.innerHTML = ''; const its = siteItems(s); (its.length ? its : [{}]).forEach(it => addMaterialRow({ name: it.name, qty: it.qty, lot: it.lot }, '장수')); }
  if (s.constructDate && !el('h-useDate').value) el('h-useDate').value = s.constructDate;
  if (el('h-vendor') && s.client) el('h-vendor').value = s.client; // 업체(거래처) 자동 채움
  toast('현장 정보를 불러왔습니다');
}
async function submitHold(id) {
  const vendor = el('h-vendor').value.trim(); if (!vendor) { toast('업체를 입력하세요'); return; }
  const siteId = el('h-site') ? el('h-site').value : '';
  const siteName = siteId ? ((state.sites.find(s => s.id === siteId) || {}).name || '') : '';
  const rows = collectMaterialRows();
  if (!rows.length) { toast('자재명과 장수를 입력하세요'); return; }
  const items = rows.map(r => { const it = state.inventory.find(i => i.name === r.name); return { materialName: r.name, jang: r.qty, hebe: it ? +(r.qty * (+it.hebePerJang || 0)).toFixed(2) : 0, lot: r.lot, pattern: r.pattern || '' }; });
  // 모든 자재가 가용 범위(편집 중인 자신 제외)에 들면 '홀딩', 하나라도 부족하면 '예정'
  function availExcl(mat) {
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); const phys = it ? +it.jang || 0 : 0;
    let held = 0; state.holdings.forEach(h => { if (h.id === id) return; if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(x => { if (_normName(x.materialName) === _normName(mat) && !x.planned) held += (+x.jang || 0); }); });
    return phys - held;
  }
  const useDate = el('h-useDate').value, note = el('h-note').value.trim();
  // 한 건 안에서 품목별로 재고 있으면 확보(planned:false), 부족하면 예정(planned:true) — 같은 자재 여러 줄이면 누적 차감
  const used = {};
  const outItems = items.map(it => {
    const k = _normName(it.materialName);
    const avail = availExcl(it.materialName) - (used[k] || 0);
    const planned = !(avail >= it.jang);
    if (!planned) used[k] = (used[k] || 0) + it.jang;
    return { materialName: it.materialName, jang: it.jang, hebe: it.hebe, lot: it.lot, pattern: it.pattern || '', planned: planned };
  });
  const allPlanned = outItems.every(x => x.planned);
  const anyPlanned = outItems.some(x => x.planned);
  const status = allPlanned ? '예정' : '홀딩';   // 하나라도 재고 있으면 활성 홀딩(카드 1개), 전부 부족하면 예정
  const first = outItems[0];
  const obj = { vendor, items: outItems, materialName: first.materialName, jang: first.jang, hebe: first.hebe, lot: first.lot, useDate, note, status, forSiteId: siteId, forSiteName: siteName, by: me.name };
  await ensureClient(vendor);   // 신규 거래처 자동 등록
  if (id) await Store.update('holdings', id, obj);
  else {
    await Store.add('holdings', obj);
    // 고객 요청에서 넘어온 등록이면 해당 요청을 '승인'으로 마킹
    if (_holdReqLink) { try { await Store.update('holdRequests', _holdReqLink, { status: '승인', handledBy: me.name, handledAt: Date.now() }); } catch (e) { } _holdReqLink = ''; }
  }
  toast(allPlanned ? '예정홀딩으로 등록 — 입고되면 자동 전환' : (anyPlanned ? '홀딩 등록 — 일부 품목은 예정(입고 대기)' : (id ? '저장됨' : '홀딩 등록 완료')));
  closeModal();
}
async function releaseHold(id) { if (!confirm('홀딩을 해제할까요? (기록은 남고 목록에서만 빠집니다 — 지난·해제 내역 보기에서 다시 볼 수 있음)')) return; await Store.update('holdings', id, { status: '해제' }); toast('홀딩 해제됨'); }
/* 특정 자재의 가용 장수(이 홀딩 제외, 활성 '홀딩'만 차감) */
function holdAvailExcl(mat, excludeId) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); const phys = it ? +it.jang || 0 : 0;
  let held = 0;
  state.holdings.forEach(h => { if (h.id === excludeId) return; if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(x => { if (_normName(x.materialName) === _normName(mat) && !x.planned) held += (+x.jang || 0); }); });
  return phys - held;
}
function holdFitsStock(h) { return holdItems(h).every(it => holdAvailExcl(it.materialName, h.id) >= (+it.jang || 0)); }
async function restoreHold(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  const status = holdFitsStock(h) ? '홀딩' : '예정';   // 재고 부족하면 예정홀딩으로 복원
  await Store.update('holdings', id, { status, releasedAuto: false, releasedDate: '' });
  toast(status === '예정' ? '재고 부족 — 예정홀딩으로 복원 (입고 시 자동 전환)' : '홀딩으로 복원됨');
}
async function delHold(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  if (!guardDelete(`이 홀딩을 완전히 삭제할까요?\n${h.vendor || ''} · ${h.materialName || ''} ${h.jang || 0}장`)) return;
  await Store.remove('holdings', id); toast('홀딩 삭제됨');
}

/* 홀딩 → 현장 연결 (홀딩은 그대로 살아있고, 현장에 연결만) */
function holdToSite(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  _holdLinkSite = id;
  openSiteForm(null, { items: holdItems(h).map(it => ({ name: it.materialName, qty: it.jang, lot: it.lot })), client: h.vendor, note: '홀딩 연결' });
}
/* 홀딩 → 출고 (출고가 찍히면 그 홀딩이 '확정'으로). 다자재면 첫 자재부터 — 나머지는 따로 출고 */
function holdToShip(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  _holdConfirm = id;
  openShipForm({ items: holdItems(h).map(it => ({ name: it.materialName, qty: it.jang, lot: it.lot, pattern: it.pattern })), targetName: h.vendor || h.forSiteName || '' });
}

/* ===================================================================
   설정
   =================================================================== */
/* ================= 출고관리 (사무실 요청 → 창고 확인) — 이식 1단계 ================= */
function chulgoSide() { return filters.chulgoSide || 'office'; }
function chulgoGoSide(v) { filters.chulgoSide = v; renderChulgo(); }
let _crN = 0;
function crItemRow(d) {
  d = d || {}; const i = _crN++;
  return `<div class="cr-row" style="border:1px solid var(--bd2);border-radius:10px;padding:8px 9px;margin-bottom:8px">
    <div style="display:flex;gap:6px;align-items:center">
      <div style="flex:2.1;min-width:0">${searchBox('crm-' + i, '자재명 검색·입력', d.name || '', 'matNames', '')}</div>
      <input class="cr-qty" inputmode="numeric" placeholder="수량" value="${esc(d.qty || '')}" style="flex:1;min-width:50px;font-size:15px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px">
      <input class="cr-unit" placeholder="단위" value="${esc(d.unit || '')}" style="flex:none;width:52px;font-size:14px;padding:9px 6px;border:1.5px solid var(--bd2);border-radius:9px">
      <button type="button" class="btn btn-ghost btn-sm" style="flex:none" onclick="this.closest('.cr-row').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
    </div>
    <input class="cr-spec" lang="ko" placeholder="규격/롯트·패턴(선택)" value="${esc(d.spec || '')}" style="width:100%;margin-top:6px;font-size:14px;padding:8px 9px;border:1.5px solid var(--bd2);border-radius:9px">
  </div>`;
}
function addCrRow() { const c = el('cr-rows'); if (c) c.insertAdjacentHTML('beforeend', crItemRow({})); }
function collectCrItems() { const rows = []; document.querySelectorAll('#cr-rows .cr-row').forEach(r => { const inp = r.querySelector('input.sb-in'); const name = inp ? (inp.value || '').trim() : ''; const qty = parseFloat(r.querySelector('.cr-qty').value) || 0; const unit = (r.querySelector('.cr-unit').value || '').trim(); const spec = (r.querySelector('.cr-spec').value || '').trim(); if (name) rows.push({ name: name, qty: qty, unit: unit, spec: spec }); }); return rows; }
function chulgoNextDocNo(reqType) { const d = todayStr().replace(/-/g, ''); const n = (state.chulgoReqs || []).filter(r => (r.docNo || '').startsWith(d)).length + 1; const p = reqType === '입고' ? 'I' : (reqType === '입고알림' ? 'A' : 'O'); return d + '-' + p + String(n).padStart(2, '0'); }
function chulgoReqCard(r, forWarehouse) {
  const st = r.status || '대기열';
  const cls = st === '완료' ? 'p-done' : (st === '확인' ? 'p-prog' : (st === '지시' ? 'p-hold' : 'p-wait'));
  const urg = r.urgency || (r.urgent ? '긴급' : '보통');
  const urgBadge = urg === '즉시' ? '<span class="pill" style="background:#fde8e8;color:#a01212;font-size:10px">즉시</span> ' : (urg === '긴급' ? '<span class="pill" style="background:#fde8e8;color:#c0341d;font-size:10px">긴급</span> ' : '');
  const items = (r.items || []).map(it => `<div style="font-size:12.5px;color:var(--t2)">· <b style="color:var(--t1)">${esc(it.name)}</b> ${+it.qty || 0}${it.unit ? esc(it.unit) : ''}${it.spec ? ` <span style="color:var(--t3)">(${esc(it.spec)})</span>` : ''}</div>`).join('');
  const when = r.createdAt ? new Date(+r.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const fl = r.flags || {}; const flTxt = [fl.basin ? '세면대' : '', fl.pack ? '포장' : '', fl.pallet ? '파렛트' : ''].filter(Boolean).join(' · ');
  const sub = [r.schedDate ? '예정 ' + r.schedDate : '', r.companyDispatch ? '🚚 업체 배차' : (r.driver ? '기사 ' + r.driver : ''), r.loadTime ? '상차 ' + r.loadTime : '', r.dispatchDest ? '→ ' + r.dispatchDest : ''].filter(Boolean).join(' · ');
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px;border-left:4px solid ${r.urgent ? '#e23b3b' : 'var(--bd2)'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0"><div style="font-weight:700;font-size:14px">${urgBadge}${esc(r.reqType || '출고')} · ${esc(r.client || '-')}${flTxt ? ` <span style="font-size:10.5px;color:var(--blue)">[${flTxt}]</span>` : ''}</div>
        <div style="font-size:11.5px;color:var(--t3);margin-top:2px">${esc(r.docNo || '')} · ${esc(r.sender || '')} · ${when}</div></div>
      <span class="pill ${cls}" style="flex:none">${esc(st)}</span>
    </div>
    <div style="margin-top:7px">${items}</div>
    ${sub ? `<div style="margin-top:5px;font-size:11.5px;color:var(--t3)"><i class="ti ti-truck" style="font-size:12px"></i> ${esc(sub)}</div>` : ''}
    ${r.memo ? `<div style="margin-top:6px;font-size:12.5px;color:var(--t2);border-top:1px dashed var(--bd2);padding-top:6px"><i class="ti ti-note"></i> ${esc(r.memo)}</div>` : ''}
    ${st !== '대기' && r.ackedBy ? `<div style="margin-top:6px;font-size:11.5px;color:var(--gd)"><i class="ti ti-checks"></i> ${esc(r.ackedBy)} 확인${r.ackedAt ? ' ' + new Date(+r.ackedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>` : ''}
    ${r.stockApplied ? `<div style="margin-top:4px;font-size:11.5px;color:var(--blue)"><i class="ti ti-package"></i> 실재고 반영됨 (재고 앱 ${esc(r.reqType || '출고')} 내역 기록)</div>` : ''}
    <div class="frm-foot" style="margin-top:9px">
      ${forWarehouse && (st === '지시' || st === '대기열') ? `<button class="btn btn-pri btn-sm" style="flex:1" onclick="chulgoAck('${r.id}')"><i class="ti ti-check"></i>접수</button>` : ''}
      ${forWarehouse && (st === '지시' || st === '확인' || st === '대기열') ? `<button class="btn btn-sm" style="flex:1" onclick="chulgoDone('${r.id}')"><i class="ti ti-circle-check"></i>완료</button>` : ''}
      <button class="btn btn-sm" onclick="openChulgoChat('${r.id}')"><i class="ti ti-message"></i>채팅${(() => { const u = chulgoUnread(r); return u ? ` <span style="background:#e23b3b;color:#fff;border-radius:9px;padding:0 5px;font-size:10px">${u}</span>` : ((r.chats || []).length ? ` <span style="color:var(--t3)">${(r.chats || []).length}</span>` : ''); })()}</button>
      <button class="btn btn-sm" onclick="chulgoPrint('${r.id}')"><i class="ti ti-printer"></i>지시서</button>
      ${isAdmin() ? `<button class="btn btn-danger btn-sm" onclick="delChulgoReq('${r.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>
  </div>`;
}
/* 출고/입고 지시서 인쇄 — 회사 레터헤드 + 품목표 + 확인란 */
function chulgoPrint(id) {
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) { toast('요청을 찾을 수 없습니다'); return; }
  const e = s => esc(s == null ? '' : String(s));
  const isIn = (r.reqType === '입고');
  const title = isIn ? '입 고 지 시 서' : '출 고 지 시 서';
  const urg = r.urgency || (r.urgent ? '긴급' : '보통');
  const fl = r.flags || {}; const flTxt = [fl.basin ? '세면대' : '', fl.pack ? '포장' : '', fl.pallet ? '파렛트' : ''].filter(Boolean).join(' / ') || '-';
  const items = r.items || [];
  const MIN = Math.max(8, items.length);
  let rows = items.map((it, i) => `<tr><td class="c">${i + 1}</td><td class="l">${e(it.name)}</td><td class="l">${e(it.spec)}</td><td class="r">${e(it.qty)}</td><td class="c">${e(it.unit)}</td></tr>`).join('');
  for (let i = items.length; i < MIN; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title} ${e(r.client)} ${e(r.docNo)}</title>
<style>
  *{box-sizing:border-box} body{font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111;margin:0;padding:22px 26px}
  h1{text-align:center;font-size:26px;font-weight:800;letter-spacing:12px;margin:0 0 4px} .co{text-align:center;font-size:13px;color:#333;margin-bottom:14px}
  table{border-collapse:collapse;width:100%} .info td{border:1px solid #444;padding:7px 9px;font-size:13px} .info .k{background:#f2f2f2;font-weight:700;text-align:center;white-space:nowrap;width:14%}
  .urg{color:#c0341d;font-weight:800} .items{margin-top:12px;table-layout:fixed} .items th{border:1px solid #444;background:#eee;padding:7px 6px;font-size:13px} .items td{border:1px solid #444;padding:6px;font-size:12.5px;height:30px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .foot{margin-top:12px} .foot td{border:1px solid #444;padding:12px 10px;font-size:12.5px} .foot .k{background:#f2f2f2;font-weight:700;text-align:center;width:16%}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <h1>${title}</h1>
  <div class="co">${e(companyInfo().name)} · ${e(companyInfo().tel)}</div>
  <table class="info">
    <tr><td class="k">문서번호</td><td>${e(r.docNo)}</td><td class="k">발행일자</td><td>${e(todayStr())}</td></tr>
    <tr><td class="k">거래처</td><td>${e(r.client)}</td><td class="k">${isIn ? '입고' : '출고'}예정일</td><td>${e(r.schedDate) || '-'}</td></tr>
    <tr><td class="k">긴급도</td><td class="${urg !== '보통' ? 'urg' : ''}">${e(urg)}</td><td class="k">요청자</td><td>${e(r.sender)}</td></tr>
    <tr><td class="k">기사 / 배차</td><td>${r.companyDispatch ? '업체 배차' : (e(r.driver) || '-')}${r.loadTime ? ' · 상차 ' + e(r.loadTime) : ''}</td><td class="k">구분표시</td><td>${e(flTxt)}</td></tr>
  </table>
  <table class="items"><colgroup><col style="width:8%"><col style="width:40%"><col style="width:28%"><col style="width:14%"><col style="width:10%"></colgroup>
    <thead><tr><th>No</th><th>품목명</th><th>규격 / 롯트·패턴</th><th>수량</th><th>단위</th></tr></thead><tbody>${rows}</tbody></table>
  ${r.memo ? `<div style="margin-top:8px;font-size:12.5px;border:1px solid #444;padding:8px 10px"><b>메모</b> : ${e(r.memo)}</div>` : ''}
  <table class="foot"><tr><td class="k">요청자</td><td></td><td class="k">${isIn ? '입고' : '출고'}담당</td><td></td><td class="k">확인자</td><td></td></tr></table>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}
/* ── 출고 지시 묶음(dispatch): 여러 대기열 건을 한 dispatchId로 묶어 한 건으로 처리 ── */
function chulgoDispatchGroups() {
  const disp = (state.chulgoReqs || []).filter(r => r.dispatchId && ['지시', '확인', '완료'].includes(r.status || ''));
  const map = {};
  disp.forEach(r => { (map[r.dispatchId] = map[r.dispatchId] || []).push(r); });
  return Object.keys(map).map(k => {
    const reqs = map[k].sort((a, b) => (+a.createdAt || 0) - (+b.createdAt || 0));
    const rep = reqs[0]; const sts = reqs.map(r => r.status || '');
    // 업체별로 묶고, 하차지는 업체별로 각각 유지 (같은 차량이라도 하차지 다름)
    const stopMap = {};
    reqs.forEach(r => {
      const c = r.client || '-';
      if (!stopMap[c]) stopMap[c] = { client: c, dests: new Set(), items: [], companyDispatch: false };
      if (r.companyDispatch) stopMap[c].companyDispatch = true;
      else if ((r.dispatchDest || '').trim()) stopMap[c].dests.add((r.dispatchDest || '').trim());
      (r.items || []).forEach(it => stopMap[c].items.push(it));
    });
    const stops = Object.values(stopMap).map(s => ({ client: s.client, dest: s.companyDispatch ? '업체 배차' : [...s.dests].join(' / '), items: s.items }));
    return {
      dispatchId: k, reqs,
      status: sts.includes('지시') ? '지시' : (sts.includes('확인') ? '확인' : '완료'),
      vehicle: rep.vehicle || '', driver: rep.driver || '', companyDispatch: !!rep.companyDispatch, loadTime: rep.loadTime || '', packing: reqs.some(r => r.packing),
      dispatchDest: [...new Set(reqs.map(r => (r.dispatchDest || '').trim()).filter(Boolean))].join(' / '),
      stops,
      handler: (reqs.find(r => r.handler) || {}).handler || '', memos: reqs.map(r => (r.memo || '').trim()).filter(Boolean),
      dispatchNote: (reqs.find(r => (r.dispatchNote || '').trim()) || {}).dispatchNote || '',
      dispatchedAt: rep.dispatchedAt || 0, dispatchedBy: rep.dispatchedBy || '',
      urgent: reqs.some(r => r.urgent),
      clients: [...new Set(reqs.map(r => r.client).filter(Boolean))],
      items: [].concat(...reqs.map(r => (r.items || []).map(it => Object.assign({ _client: r.client }, it)))),
      docNos: reqs.map(r => r.docNo).filter(Boolean)
    };
  }).sort((a, b) => { const ua = a.status === '지시' ? 0 : 1, ub = b.status === '지시' ? 0 : 1; if (ua !== ub) return ua - ub; return (+b.dispatchedAt || 0) - (+a.dispatchedAt || 0); });
}
function chulgoDispatchCard(g, forWarehouse) {
  const st = g.status; const cls = st === '완료' ? 'p-done' : (st === '확인' ? 'p-prog' : 'p-hold');
  const urgBadge = g.urgent ? '<span class="pill" style="background:#fde8e8;color:#c0341d;font-size:10px">긴급</span> ' : '';
  const packBadge = g.packing ? '<span class="pill" style="background:#e6f0ff;color:#1b4fb0;font-size:10px;font-weight:700">📦 포장</span> ' : '';
  const packBar = g.packing ? '<div style="margin-top:6px;background:#e6f0ff;color:#1b4fb0;font-weight:700;font-size:12.5px;text-align:center;border-radius:8px;padding:5px 8px"><i class="ti ti-package"></i> 포장 건 — 포장 후 출고</div>' : '';
  const multiStop = (g.stops || []).length > 1;
  const items = (g.stops || []).map(s => `<div style="margin-top:7px">
      <div style="font-size:12.5px;font-weight:700;color:#1b4fb0"><i class="ti ti-map-pin" style="font-size:13px;vertical-align:-1px"></i> ${esc(s.client)}${s.dest ? ' <span style="color:var(--t2)">· 하차 ' + esc(s.dest) + '</span>' : ''}</div>
      ${s.items.map(it => `<div style="font-size:12.5px;color:var(--t2);padding-left:5px">· <b style="color:var(--t1)">${esc(it.name)}</b> ${+it.qty || 0}${esc(it.unit || '')}${it.spec ? ` <span style="color:var(--t3)">(${esc(it.spec)})</span>` : ''}</div>`).join('')}
    </div>`).join('');
  const when = g.dispatchedAt ? new Date(+g.dispatchedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const veh = [g.companyDispatch ? '🚚 업체 배차' : (g.driver ? '기사 ' + g.driver : ''), g.loadTime ? '상차 ' + g.loadTime : '', multiStop ? '하차지 ' + g.stops.length + '곳' : ''].filter(Boolean).join(' · ');
  const chatRep = g.reqs[0]; const chatUnread = chatRep ? chulgoUnread(chatRep) : 0;
  const chatBtn = chatRep ? `<button class="btn btn-sm" style="position:relative" onclick="openChulgoChat('${chatRep.id}')"><i class="ti ti-messages"></i>채팅${chatUnread ? ` <span style="background:#e23b3b;color:#fff;border-radius:9px;padding:0 5px;font-size:10px;font-weight:700">${chatUnread}</span>` : ''}</button>` : '';
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px;border-left:4px solid ${g.urgent ? '#e23b3b' : '#2f6fed'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0"><div style="font-weight:700;font-size:14px">${urgBadge}${packBadge}출고 지시 · ${esc(g.clients.join(', ') || '-')}${g.reqs.length > 1 ? ` <span style="font-size:11px;color:var(--t3)">(${g.reqs.length}건 묶음)</span>` : ''}</div>
        <div style="font-size:11.5px;color:var(--t3);margin-top:2px">${esc(g.docNos.join(', '))} · ${when}${g.dispatchedBy ? ' · ' + esc(g.dispatchedBy) : ''}</div></div>
      <span class="pill ${cls}" style="flex:none">${esc(st)}</span></div>
    ${veh ? `<div style="margin-top:5px;font-size:12.5px;color:#2f6fed;font-weight:600">${esc(veh)}</div>` : ''}
    ${packBar}
    ${g.dispatchNote ? `<div style="margin-top:6px;font-size:12.5px;background:#fffbe6;border:1px solid #f0d98a;border-radius:8px;padding:6px 9px;color:#7a5a00"><i class="ti ti-note"></i> <b>비고</b> · ${esc(g.dispatchNote)}</div>` : ''}
    <div style="margin-top:7px">${items}</div>
    <div class="frm-foot" style="margin-top:9px">
      ${forWarehouse && st === '지시' ? `<button class="btn btn-pri btn-sm" style="flex:1.4" onclick="chulgoAckDispatch('${g.dispatchId}')"><i class="ti ti-check"></i>접수 (요청서 인쇄)</button>` : ''}
      ${forWarehouse && (st === '지시' || st === '확인') ? `<button class="btn btn-sm" style="flex:1" onclick="chulgoDoneDispatch('${g.dispatchId}')"><i class="ti ti-circle-check"></i>완료</button>` : ''}
      ${chatBtn}
      <button class="btn btn-sm" onclick="chulgoPrintDispatch('${g.dispatchId}')"><i class="ti ti-printer"></i>요청서${forWarehouse ? ' 재인쇄' : ''}</button>
      ${!forWarehouse && st !== '완료' ? `<button class="btn btn-sm" style="color:var(--red-t)" onclick="cancelDispatch('${g.dispatchId}')" title="출고 지시 취소 · 대기열로 되돌림"><i class="ti ti-arrow-back-up"></i></button>` : ''}
    </div>
  </div>`;
}
function _chulgoDoneTs(g) { return (g.reqs.find(r => r.doneAt) || {}).doneAt || g.dispatchedAt || 0; }
function _chulgoDoneDay(g) { const ts = _chulgoDoneTs(g); if (!ts) return '(날짜미상)'; const d = new Date(+ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
let _chulgoCalYM = '', _chulgoCalDay = '';
function chulgoCalNav(delta) { const [y, m] = (_chulgoCalYM || todayStr().slice(0, 7)).split('-').map(Number); const d = new Date(y, m - 1 + delta, 1); _chulgoCalYM = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); _chulgoCalDay = ''; renderChulgo(); }
function chulgoCalPick(key) { _chulgoCalDay = (_chulgoCalDay === key ? '' : key); renderChulgo(); }
function chulgoCompletedSection() {
  const done = chulgoDispatchGroups().filter(g => g.status === '완료');
  if (!done.length) return '';
  const wd = ['일', '월', '화', '수', '목', '금', '토'];
  const dayLbl = day => { const p = String(day).split('-'); if (p.length !== 3) return esc(day); const dt = new Date(+p[0], +p[1] - 1, +p[2]); return `${+p[0]}년 ${+p[1]}월 ${+p[2]}일 (${wd[dt.getDay()]})`; };
  const byDay = {}; done.forEach(g => { const d = _chulgoDoneDay(g); (byDay[d] = byDay[d] || []).push(g); });
  const allDays = Object.keys(byDay).sort();
  if (!_chulgoCalYM) _chulgoCalYM = (allDays[allDays.length - 1] || todayStr()).slice(0, 7);
  const [Y, M] = _chulgoCalYM.split('-').map(Number);
  const startDow = new Date(Y, M - 1, 1).getDay();
  const dim = new Date(Y, M, 0).getDate();
  const cellBase = 'position:relative;min-height:40px;border:0.5px solid var(--bd);border-radius:8px;padding:3px 4px;text-align:left';
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div style="${cellBase};border-color:transparent"></div>`;
  for (let d = 1; d <= dim; d++) {
    const key = `${Y}-${String(M).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const gs = byDay[key] || []; const cnt = gs.length; const dow = (startDow + d - 1) % 7;
    const dcol = dow === 0 ? '#c0341d' : (dow === 6 ? '#1b4fb0' : 'var(--t2)');
    const sel = _chulgoCalDay === key;
    const bg = sel ? 'background:#2f6fed;' : (cnt ? 'background:#eaf1ff;' : '');
    const numCol = sel ? '#fff' : dcol;
    cells += `<div ${cnt ? `onclick="chulgoCalPick('${key}')"` : ''} style="${cellBase};${bg}cursor:${cnt ? 'pointer' : 'default'}">
      <div style="font-size:11.5px;font-weight:700;color:${numCol}">${d}</div>
      ${cnt ? `<div style="position:absolute;right:3px;bottom:3px;background:${sel ? '#fff' : '#2f6fed'};color:${sel ? '#2f6fed' : '#fff'};border-radius:9px;min-width:16px;text-align:center;font-size:10.5px;font-weight:800;padding:0 4px;line-height:16px">${cnt}</div>` : ''}</div>`;
  }
  const monthTot = allDays.filter(d => d.slice(0, 7) === _chulgoCalYM).reduce((a, d) => a + byDay[d].length, 0);
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin:4px 2px 8px">
      <button class="btn btn-ghost btn-sm" style="flex:none" onclick="chulgoCalNav(-1)"><i class="ti ti-chevron-left"></i></button>
      <div style="font-size:14px;font-weight:800">${Y}년 ${M}월 <span style="font-size:11.5px;color:var(--t3);font-weight:500">· 완료 ${monthTot}건</span></div>
      <button class="btn btn-ghost btn-sm" style="flex:none" onclick="chulgoCalNav(1)"><i class="ti ti-chevron-right"></i></button></div>`;
  const dowRow = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:3px">${wd.map((w, i) => `<div style="text-align:center;font-size:10.5px;font-weight:700;color:${i === 0 ? '#c0341d' : (i === 6 ? '#1b4fb0' : 'var(--t3)')}">${w}</div>`).join('')}</div>`;
  const grid = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">${cells}</div>`;
  const selList = (_chulgoCalDay && byDay[_chulgoCalDay])
    ? `<div style="margin-top:10px"><div style="font-size:12.5px;font-weight:700;margin:0 2px 6px"><i class="ti ti-calendar-event" style="font-size:13px"></i> ${dayLbl(_chulgoCalDay)} · ${byDay[_chulgoCalDay].length}건</div><div data-keepscroll style="max-height:40vh;overflow:auto">${byDay[_chulgoCalDay].sort((a, b) => _chulgoDoneTs(b) - _chulgoDoneTs(a)).map(chulgoCompletedRow).join('')}</div></div>`
    : `<div style="font-size:12px;color:var(--t3);text-align:center;padding:12px 6px">파란 숫자 배지가 있는 날짜를 누르면 그날 완료된 출고가 나옵니다.</div>`;
  return `<details style="margin-top:14px"><summary style="font-size:13px;color:var(--t2);cursor:pointer;padding:6px 2px;font-weight:600"><i class="ti ti-calendar-check"></i> 완료 내역 <span style="color:var(--t3);font-weight:400">(달력 · ${done.length}건 · 재인쇄/되돌리기)</span></summary>
    <div style="margin-top:8px;border:0.5px solid var(--bd);border-radius:12px;padding:10px 11px;background:#fff">${head}${dowRow}${grid}${selList}</div></details>`;
}
function chulgoCompletedRow(g) {
  const doneAt = (g.reqs.find(r => r.doneAt) || {}).doneAt;
  const when = doneAt ? new Date(+doneAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const doneBy = (g.reqs.find(r => r.doneBy) || {}).doneBy || '';
  return `<div class="card" style="margin-bottom:8px;padding:9px 11px;border-left:3px solid #9ca3af">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <div style="min-width:0"><div style="font-weight:700;font-size:13px">${esc(g.clients.join(', ') || '-')}${g.reqs.length > 1 ? ` <span style="font-size:10.5px;color:var(--t3)">(${g.reqs.length}건)</span>` : ''}</div>
        <div style="font-size:10.5px;color:var(--t3);margin-top:1px">완료 ${when}${doneBy ? ' · ' + esc(doneBy) : ''}</div></div>
      <span class="pill p-done" style="flex:none">완료</span></div>
    <div class="frm-foot" style="margin-top:7px">
      <button class="btn btn-sm" onclick="chulgoPrintDispatch('${g.dispatchId}')"><i class="ti ti-printer"></i>요청서</button>
      ${isAdmin() ? `<button class="btn btn-sm" style="color:var(--blue)" onclick="chulgoRestoreDispatch('${g.dispatchId}')" title="진행 중(지시)으로 되돌림"><i class="ti ti-arrow-back-up"></i>되돌리기</button>` : ''}
    </div></div>`;
}
async function chulgoRestoreDispatch(dispatchId) {
  if (!isAdmin()) { toast('관리자만 되돌릴 수 있습니다'); return; }
  const reqs = (state.chulgoReqs || []).filter(r => r.dispatchId === dispatchId && (r.status || '') === '완료');
  if (!reqs.length) { toast('되돌릴 건이 없습니다'); return; }
  if (!confirm(`이 완료건(${reqs.length}건)을 진행 중(지시)으로 되돌릴까요?`)) return;
  for (const r of reqs) { try { await Store.update('chulgoReqs', r.id, { status: '지시', doneAt: 0, doneBy: '' }); } catch (e) { } }
  toast('진행 중(지시)으로 되돌림'); renderChulgo();
}
function chulgoHandlerNames() { return (state.chulgoHandlers || []).map(h => (h.name || h.value || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)); }
function chulgoAckDispatch(dispatchId) { openChulgoAckModal(dispatchId); }
function openChulgoAckModal(dispatchId) {
  const names = chulgoHandlerNames();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-clipboard-check"></i>출고 접수 · 담당자 선택</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>출고 담당자 <span style="color:var(--t3);font-weight:500">— 요청서에 기록됩니다</span></label>
        <select id="ack-handler" style="width:100%;font-size:16px;padding:10px 11px;border:1.5px solid var(--bd2);border-radius:10px">
          <option value="">— 담당자 선택 —</option>
          ${names.map(n => `<option>${esc(n)}</option>`).join('')}
        </select>
        ${!names.length ? `<div style="font-size:12px;color:var(--t3);margin-top:6px">등록된 담당자가 없습니다.${isAdmin() ? ' 아래에서 추가하세요.' : ' 관리자에게 담당자 등록을 요청하세요.'}</div>` : ''}
      </div>
      ${isAdmin() ? `<div class="fld full"><label>담당자 관리 <span style="color:var(--t3);font-weight:500">(관리자)</span></label>
        <div style="display:flex;gap:6px"><input id="ack-newh" lang="ko" placeholder="담당자 이름" autocomplete="off" style="flex:1;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"><button class="btn btn-sm" onclick="chulgoAddHandler('${dispatchId}')"><i class="ti ti-plus"></i>추가</button></div>
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${(state.chulgoHandlers || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(h => `<span class="pill p-gray" style="display:inline-flex;align-items:center;gap:5px">${esc(h.name || '')} <i class="ti ti-x" style="cursor:pointer;color:var(--red-t)" onclick="chulgoDelHandler('${h.id}','${dispatchId}')"></i></span>`).join('') || '<span style="color:var(--t3);font-size:12px">등록된 담당자가 없습니다</span>'}</div>
      </div>` : ''}
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="chulgoAckConfirm('${dispatchId}')"><i class="ti ti-check"></i>접수 · 요청서 인쇄</button></div>`);
}
async function chulgoAddHandler(dispatchId) {
  const v = (el('ack-newh') && el('ack-newh').value || '').trim(); if (!v) { toast('담당자 이름을 입력하세요'); return; }
  if (!(state.chulgoHandlers || []).some(h => (h.name || '') === v)) await Store.add('chulgoHandlers', { name: v });
  setTimeout(() => openChulgoAckModal(dispatchId), 250);
}
async function chulgoDelHandler(id, dispatchId) {
  await Store.remove('chulgoHandlers', id);
  setTimeout(() => openChulgoAckModal(dispatchId), 250);
}
async function chulgoAckConfirm(dispatchId) {
  const handler = (el('ack-handler') && el('ack-handler').value || '').trim();
  if (!handler) { toast('출고 담당자를 선택하세요'); return; }
  const reqs = (state.chulgoReqs || []).filter(r => r.dispatchId === dispatchId && (r.status || '') === '지시');
  for (const r of reqs) { try { await Store.update('chulgoReqs', r.id, { status: '확인', handler, ackedBy: (me && me.name) || '', ackedAt: Date.now() }); } catch (e) { } }
  closeModal();
  toast('접수 처리 · 요청서 인쇄');
  setTimeout(() => chulgoPrintDispatch(dispatchId), 200);
}
async function chulgoDoneDispatch(dispatchId) {
  if (!confirm('이 출고 지시를 완료 처리할까요?')) return;
  const reqs = (state.chulgoReqs || []).filter(r => r.dispatchId === dispatchId && ['지시', '확인'].includes(r.status || ''));
  for (const r of reqs) { try { await Store.update('chulgoReqs', r.id, { status: '완료', doneBy: (me && me.name) || '', doneAt: Date.now() }); } catch (e) { } }
  toast('완료 처리됨');
}
function chulgoPrintDispatch(dispatchId) {
  const g = chulgoDispatchGroups().find(x => x.dispatchId === dispatchId);
  if (!g) { toast('지시를 찾을 수 없습니다'); return; }
  const e = s => esc(s == null ? '' : String(s));
  const urg = g.urgent ? '긴급' : '보통';
  const stops = g.stops || [{ client: g.clients.join(', '), dest: g.dispatchDest, items: g.items }];
  const kdate = ds => { const p = String(ds || '').split('-'); if (p.length !== 3) return e(ds || todayStr()); const dt = new Date(+p[0], +p[1] - 1, +p[2]); const w = ['일', '월', '화', '수', '목', '금', '토'][dt.getDay()]; return `${+p[0]}년 ${+p[1]}월 ${+p[2]}일 (${w})`; };
  const ktime = tm => { const m = String(tm || '').match(/^(\d{1,2}):(\d{2})/); if (!m) return e(tm) || '-'; let h = +m[1]; const mm = m[2]; const ap = h < 12 ? '오전' : '오후'; let hh = h % 12; if (hh === 0) hh = 12; return `${ap} ${hh}시${mm !== '00' ? ' ' + (+mm) + '분' : ''}`; };
  const ackAt = (g.reqs.find(r => r.ackedAt) || {}).ackedAt;
  const ackTime = ackAt ? new Date(+ackAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const isBasin = g.reqs.some(r => r.sourceBasinId);
  const banner = isBasin ? '🛁　세 면 대　출 고 · 주 문 제 작' : (g.packing ? '📦　포 장 건' + (g.dispatchNote ? '　·　' + g.dispatchNote : '') : '');
  const driverTxt = g.companyDispatch ? '업체 직접 상차' : (e(g.driver) || '-');
  let rows = ''; let no = 0;
  stops.forEach(s => {
    rows += `<tr><td class="grp" colspan="6">◼&nbsp; 거래처 : <b>${e(s.client)}</b> <span style="font-weight:600;color:#555">(${(s.items || []).length}품목)</span></td></tr>`;
    (s.items || []).forEach(it => { no++; rows += `<tr><td class="c">${no}</td><td class="l">${e(it.name)}</td><td class="c">${e(it.spec)}</td><td class="c">${e(it.qty)}</td><td class="c">${e(it.unit)}</td><td class="l">${g.companyDispatch ? '업체 직접 수령' : e(s.dest)}</td></tr>`; });
  });
  const MIN = Math.max(6, no);
  for (let i = no; i < MIN; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  const memoTxt = [g.dispatchNote || '', ...(g.memos || [])].filter(Boolean).join('  /  ');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출고 요청서 ${e(g.clients.join(','))} ${e(g.docNos[0] || '')}</title>
<style>*{box-sizing:border-box}body{font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111;margin:0;padding:20px 28px;position:relative}
h1{text-align:center;font-size:30px;font-weight:800;letter-spacing:16px;margin:2px 0 2px}
.sub{text-align:center;font-size:12.5px;color:#666;margin-bottom:14px;letter-spacing:.5px}
.docno{position:absolute;top:20px;right:28px;font-size:13px;font-weight:700}
table{border-collapse:collapse;width:100%}
.info td{border:1px solid #333;padding:8px 10px;font-size:13px}.info .k{background:#f2f2f2;font-weight:700;text-align:center;white-space:nowrap;width:15%}
.banner{border:2px solid #111;border-radius:10px;text-align:center;font-size:19px;font-weight:800;letter-spacing:3px;padding:11px;margin:0 0 12px}
.urg{color:#c0341d;font-weight:800}
.items{margin-top:0}.items th{border:1px solid #333;background:#efefef;padding:8px 6px;font-size:13px;color:#333}.items td{border:1px solid #333;padding:7px 6px;font-size:13px;height:32px}
.items td.c{text-align:center}.items td.l{text-align:left;padding-left:10px}.items td.grp{background:#eaf1ff;font-size:13px;text-align:left;padding-left:10px}
.detail{margin-top:12px}.detail td{border:1px solid #333;padding:11px 10px;font-size:13px}.detail .k{background:#f2f2f2;font-weight:700;text-align:center;white-space:nowrap;width:15%}
.sign{margin-top:14px}.sign td{border:1px solid #333;font-size:12.5px;text-align:center}.sign .k{background:#f2f2f2;font-weight:700;padding:9px 6px;width:12%}.sign .v{padding:9px 6px;height:48px;vertical-align:top;width:21.3%}
.co{text-align:center;font-size:15px;font-weight:800;margin-top:14px}
@media print{body{padding:10px 12px}}</style></head><body>
  <div class="docno">No. ${e(g.docNos[0] || '')}${g.docNos.length > 1 ? ' 외 ' + (g.docNos.length - 1) : ''}</div>
  <h1>출 고 요 청 서</h1>
  <div class="sub">${companyInfo().name}　|　Material Dispatch Order</div>
  ${banner ? `<div class="banner">${e(banner)}</div>` : ''}
  <table class="info">
    <tr><td class="k">문서번호</td><td>${e(g.docNos.join(', '))}</td><td class="k">발행일자</td><td>${kdate(todayStr())}</td></tr>
    <tr><td class="k">출고예정일</td><td><b>${kdate(todayStr())}</b></td><td class="k">긴급도</td><td class="${urg !== '보통' ? 'urg' : ''}">${e(urg)}</td></tr>
    <tr><td class="k">요청자</td><td colspan="3">${e(g.dispatchedBy) || '-'}</td></tr>
  </table>
  <table class="items" style="margin-top:12px"><colgroup><col style="width:7%"><col style="width:30%"><col style="width:20%"><col style="width:9%"><col style="width:9%"><col style="width:25%"></colgroup>
    <thead><tr><th>No</th><th>품목명</th><th>규격</th><th>수량</th><th>단위</th><th>출고지</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="detail">
    <tr><td class="k">배송차량</td><td>${e(g.vehicle) || '-'}</td><td class="k">기사명</td><td>${driverTxt}</td></tr>
    <tr><td class="k">상차예정</td><td>${ktime(g.loadTime)}</td><td class="k">출고확인시각</td><td>${ackTime || '<span style="color:#aaa">　　　:　　</span>'}</td></tr>
    <tr><td class="k">비 고</td><td colspan="3">${e(memoTxt)}</td></tr>
    <tr><td class="k">창고 코멘트</td><td colspan="3" style="height:40px"></td></tr>
  </table>
  <table class="sign">
    <tr><td class="k">요청</td><td class="v">${e(g.dispatchedBy) || ''}</td><td class="k">출고담당<br>(확인자)</td><td class="v">${e(g.handler) || ''}</td><td class="k">차량인수</td><td class="v"></td></tr>
  </table>
  <div class="co">${companyInfo().name}</div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}
function chulgoQueueRow(r) {
  const items = (r.items || []).map(it => `${esc(it.name)} ${+it.qty || 0}${esc(it.unit || '')}`).join(', ');
  return `<label class="cq-item" style="display:flex;gap:9px;align-items:flex-start;padding:9px 8px;border-bottom:0.5px solid var(--bd)">
    <input type="checkbox" class="cq-chk" value="${r.id}" style="width:19px;height:19px;margin-top:2px">
    <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13.5px">${r.urgent ? '<span class="pill" style="background:#fde8e8;color:#c0341d;font-size:10px">긴급</span> ' : ''}${esc(r.client || '-')}</div>
      <div style="font-size:12px;color:var(--t2);margin-top:2px;word-break:break-word">${items}</div>
      ${(r.dispatchDest || '').trim() ? `<div style="font-size:11px;color:#1b4fb0;margin-top:2px"><i class="ti ti-map-pin" style="font-size:12px;vertical-align:-1px"></i> 하차 ${esc(r.dispatchDest)}</div>` : ''}
      <div style="font-size:10.5px;color:var(--t3);margin-top:2px">${esc(r.docNo || '')} · ${esc(r.sender || '')}</div></div>
    <button class="btn btn-ghost btn-sm" style="flex:none" onclick="event.preventDefault();chulgoPrint('${r.id}')" title="출고증/지시서"><i class="ti ti-printer"></i></button>
    ${isAdmin() ? `<button class="btn btn-ghost btn-sm" style="flex:none;color:var(--gd)" onclick="event.preventDefault();chulgoQueueComplete('${r.id}')" title="바로 완료 처리(관리자) — 이미 기출고된 건"><i class="ti ti-circle-check"></i></button>` : ''}
    <button class="btn btn-ghost btn-sm" style="flex:none;color:var(--red-t)" onclick="event.preventDefault();delChulgoReq('${r.id}')" title="출고 취소(재고 복구)"><i class="ti ti-x"></i></button>
  </label>`;
}
async function chulgoQueueComplete(id) {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return;
  if (!confirm('이 건을 바로 완료 처리할까요?\n(등록 시 재고는 이미 차감됨 · 완료로만 정리)')) return;
  await Store.update('chulgoReqs', id, { status: '완료', dispatchId: r.dispatchId || ('D' + Date.now()), doneBy: (me && me.name) || '', doneAt: Date.now(), dispatchedAt: r.dispatchedAt || Date.now(), dispatchedBy: r.dispatchedBy || (me && me.name) || '' });
  toast('완료 처리됨'); renderChulgo();
}
async function chulgoQueueCompleteAll() {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const queue = (state.chulgoReqs || []).filter(r => r.reqType === '출고' && (r.status || '') === '대기열');
  if (!queue.length) { toast('대기열이 비어 있습니다'); return; }
  if (!confirm(`대기열 ${queue.length}건을 모두 완료 처리할까요?\n(등록 시 재고는 이미 차감됨 · 완료로만 정리)`)) return;
  const now = Date.now();
  for (const r of queue) { try { await Store.update('chulgoReqs', r.id, { status: '완료', dispatchId: r.dispatchId || ('D' + now + '_' + r.id), doneBy: (me && me.name) || '', doneAt: now, dispatchedAt: r.dispatchedAt || now, dispatchedBy: r.dispatchedBy || (me && me.name) || '' }); } catch (e) { } }
  toast(`대기열 ${queue.length}건 완료 처리됨`); renderChulgo();
}
function chulgoDispatchDrivers() { return [...new Set((state.chulgoReqs || []).map(r => (r.driver || '').trim()).filter(d => d && d !== '업체 배차'))].sort((a, b) => a.localeCompare(b)); }
function chulgoDispatchDests() { return [...new Set((state.chulgoReqs || []).map(r => (r.dispatchDest || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function chulgoDriverChanged() {
  const sel = el('dsp-driver-sel'); if (!sel) return; const v = sel.value;
  const other = el('dsp-driver-other'); if (other) { if (v === '__other') { other.classList.remove('hidden'); try { other.focus(); } catch (e) { } } else { other.classList.add('hidden'); other.value = ''; } }
  const dest = el('dsp-dest'); if (dest) { dest.style.borderColor = 'var(--bd2)'; dest.placeholder = v === '__company' ? '출고지 (업체 배차 — 불필요)' : '공통 하차지(선택) · 비우면 각 건 하차지 사용'; }
}
function chulgoTogglePack() {
  const b = el('dsp-pack'); if (!b) return; const on = b.dataset.on === '1'; b.dataset.on = on ? '0' : '1';
  if (!on) { b.style.background = '#e6f0ff'; b.style.borderColor = '#2f6fed'; b.style.color = '#1b4fb0'; b.innerHTML = '<i class="ti ti-package"></i> 포장 건 · 표시됨 ✓'; }
  else { b.style.background = ''; b.style.borderColor = ''; b.style.color = ''; b.innerHTML = '<i class="ti ti-package"></i> 포장 건 — 누르면 표시'; }
}
function chulgoOfficeSection() {
  const queue = (state.chulgoReqs || []).filter(r => r.reqType === '출고' && ['대기열', '대기'].includes(r.status || '')).sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const _todayCh = (function () { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  const _gdayCh = g => { const t = +g.dispatchedAt || 0; if (!t) return ''; const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const active = chulgoDispatchGroups().filter(g => g.status !== '완료' || _gdayCh(g) === _todayCh);
  const drivers = chulgoDispatchDrivers(), dests = chulgoDispatchDests();
  const times = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
  return `
    <div class="card" style="padding:13px 15px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:3px"><div style="font-weight:700;font-size:14px"><i class="ti ti-list-check" style="color:var(--blue)"></i> 출고 대기열 <span style="font-size:12px;color:var(--t3)">(${queue.length}건)</span></div>${isAdmin() && queue.length ? `<button class="btn btn-ghost btn-sm" style="flex:none;color:var(--gd)" onclick="chulgoQueueCompleteAll()" title="이미 기출고된 대기열 전체를 완료 처리(관리자)"><i class="ti ti-checks"></i> 전체 완료</button>` : ''}</div>
      <div style="font-size:11.5px;color:var(--t3);margin-bottom:9px">출고 탭에서 출고를 등록하면 여기에 쌓입니다. 묶을 항목을 체크하고 배차 정보를 넣어 <b>출고 지시</b>를 내리면 창고에 소리로 알림이 갑니다.${isAdmin() ? ' <span style="color:var(--gd)">관리자는 각 건의 ✓로 바로 완료 처리할 수 있습니다.</span>' : ''}</div>
      <div id="chulgo-queue" data-keepscroll style="max-height:38vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:10px;margin-bottom:10px">${queue.length ? queue.map(chulgoQueueRow).join('') : `<div style="padding:18px;text-align:center;color:var(--t3);font-size:12.5px">대기열이 비어 있습니다.<br>출고 탭 → 출고 등록을 하면 여기로 올라옵니다.</div>`}</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <select id="dsp-driver-sel" onchange="chulgoDriverChanged()" style="flex:1.3;min-width:0;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px">
          <option value="">기사 선택</option>
          <option value="__company">🚚 업체 배차 (출고지 생략 가능)</option>
          ${drivers.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
          <option value="__other">＋ 기타 (직접 입력)</option>
        </select>
        <select id="dsp-time" style="flex:1;min-width:0;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px">
          <option value="">상차 시간</option>
          ${times.map(h => `<option>${h}</option>`).join('')}
        </select>
      </div>
      <input id="dsp-driver-other" lang="ko" placeholder="기사명 직접 입력" class="hidden" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px;margin-bottom:8px">
      <input id="dsp-dest" lang="ko" list="dsp-dest-list" placeholder="공통 하차지(선택) · 비우면 각 건 하차지 사용" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px;margin-bottom:10px">
      <datalist id="dsp-dest-list">${dests.map(d => `<option value="${esc(d)}"></option>`).join('')}</datalist>
      <button type="button" id="dsp-pack" data-on="0" onclick="chulgoTogglePack()" class="btn btn-sm" style="width:100%;justify-content:center;margin-bottom:10px"><i class="ti ti-package"></i> 포장 건 — 누르면 표시</button>
      <textarea id="dsp-memo" lang="ko" placeholder="비고 · 특이사항 (창고 전달사항 · 요청서에 기재)" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px;margin-bottom:10px;min-height:52px;resize:vertical"></textarea>
      <button class="btn btn-pri btn-block" onclick="issueDispatch()"><i class="ti ti-truck-delivery"></i>선택 항목 묶어 출고 지시 내리기 (창고 알림)</button>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--t2);margin:2px 2px 6px"><i class="ti ti-calendar-event"></i> 오늘 출고 요청 목록 <span style="font-weight:500;color:var(--t3)">· ${esc(_todayCh.slice(5).replace('-', '/'))}</span></div>
    ${active.length ? `<div id="chulgo-active" data-keepscroll style="max-height:40vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${active.map(g => chulgoDispatchCard(g, false)).join('')}</div>` : `<div class="empty" style="padding:14px"><i class="ti ti-inbox"></i>오늘 출고 요청이 없습니다</div>`}
    ${chulgoCompletedSection()}
    <details style="margin-top:14px"><summary style="font-size:13px;color:var(--t2);cursor:pointer;padding:6px 2px"><i class="ti ti-plus"></i> 입고 · 입고알림 직접 등록</summary>
      <div class="card" style="padding:13px 15px;margin-top:8px">
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">구분</label><select id="cr-type" style="width:100%;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px"><option>입고</option><option>입고알림</option></select></div>
          <div class="fld" style="flex:2"><label style="font-size:12px;color:var(--t2)">거래처 <span style="color:var(--red-t)">*</span></label>${searchBox('cr-client', '거래처 검색·입력', '', 'companyNames', '')}</div>
        </div>
        <div class="fld full" style="margin-bottom:8px"><label style="font-size:12px;color:var(--t2)">품목 / 수량 / 단위 / 규격 <span style="color:var(--red-t)">*</span></label><div id="cr-rows">${crItemRow({})}</div><button type="button" class="btn btn-ghost btn-sm" onclick="addCrRow()"><i class="ti ti-plus"></i>자재 추가</button></div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">긴급도</label><select id="cr-urg" style="width:100%;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px"><option>보통</option><option>긴급</option><option>즉시</option></select></div>
          <div class="fld" style="flex:1.2"><label style="font-size:12px;color:var(--t2)">예정일</label><input type="date" id="cr-sched" style="width:100%;font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        </div>
        <div class="fld full" style="margin-bottom:8px"><label style="font-size:12px;color:var(--t2)">메모</label><input id="cr-memo" lang="ko" placeholder="선택" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        <input type="hidden" id="cr-vehicle"><input type="hidden" id="cr-driver">
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px;font-size:13px">
          <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cr-basin" style="width:17px;height:17px"> 세면대</label>
          <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cr-pack" style="width:17px;height:17px"> 포장</label>
          <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cr-pallet" style="width:17px;height:17px"> 파렛트</label>
        </div>
        <button class="btn btn-pri btn-block" onclick="submitChulgoReq()"><i class="ti ti-send"></i>등록</button>
      </div>
    </details>`;
}
function chulgoWarehouseSection() {
  const dispatched = chulgoDispatchGroups().filter(g => g.status !== '완료');
  const inbound = (state.chulgoReqs || []).filter(r => ['입고', '입고알림'].includes(r.reqType) && (r.status || '') === '대기열').sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const newN = dispatched.filter(g => g.status === '지시').length;
  const box = dispatched.length ? `<div id="chulgo-wh-list" data-keepscroll style="max-height:52vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${dispatched.map(g => chulgoDispatchCard(g, true)).join('')}</div>` : `<div class="empty"><i class="ti ti-clipboard-off"></i>들어온 출고 지시가 없습니다</div>`;
  const inBox = inbound.length ? `<div style="font-size:12px;font-weight:600;color:var(--t2);margin:14px 2px 6px"><i class="ti ti-login"></i> 입고 · 알림</div><div style="border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${inbound.map(r => chulgoReqCard(r, true)).join('')}</div>` : '';
  const alarmBtn = _chulgoArmed
    ? `<button class="btn btn-sm btn-block" style="margin-bottom:9px;background:var(--gl2);border-color:var(--gbd);color:var(--gd)" onclick="chulgoDisarmAudio()"><i class="ti ti-bell-ringing"></i> 🔔 알림 소리 <b>켜짐</b> · 눌러서 끄기 <span style="font-weight:500;color:var(--t3)">(새 지시가 오면 접수할 때까지 울려요)</span></button>`
    : `<button class="btn btn-sm btn-block" style="margin-bottom:9px;background:#fff6e6;border-color:#f0c060;color:#8a5a00" onclick="chulgoPrimeAudio()"><i class="ti ti-bell-off"></i> 알림 소리 <b>꺼짐</b> · 눌러서 켜기 <span style="font-weight:500;color:var(--t3)">(이 기기 · 새 지시가 오면 소리로 알려요)</span></button>`;
  return `${alarmBtn}
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px"><span class="live-dot" style="background:#1D9E75;--pc:rgba(29,158,117,.6);width:7px;height:7px;display:inline-block;vertical-align:middle;margin-right:5px"></span>실시간 · 새 출고 지시 <b style="color:#c0341d">${newN}건</b></div>${box}${inBox}${chulgoCompletedSection()}`;
}
function renderChulgo() {
  const side = chulgoSide();
  const newN = (state.chulgoReqs || []).filter(r => (r.status || '') === '지시').length;
  el('pg-chulgo').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-clipboard-list"></i>출고관리</h2><p>출고 대기열 → 배차·지시 → 창고 처리</p></div></div>
    <div class="seg" style="margin:2px 0 12px">
      <button type="button" class="${side === 'office' ? 'on' : ''}" onclick="chulgoGoSide('office')"><i class="ti ti-building" style="font-size:14px"></i> 사무실(배차·지시)</button>
      <button type="button" class="${side === 'warehouse' ? 'on' : ''}" onclick="chulgoGoSide('warehouse')"><i class="ti ti-building-warehouse" style="font-size:14px"></i> 창고${newN ? ` <b>${newN}</b>` : ''}</button>
    </div>
    <button class="btn btn-sm btn-block" style="margin-bottom:10px;${chulgoPushEnabled() ? 'background:var(--gl2);border-color:var(--gbd);color:var(--gd)' : ''}" onclick="toggleChulgoPush()"><i class="ti ti-device-mobile"></i> 📱 휴대폰 출고 지시 알림 <b>${chulgoPushEnabled() ? '켜짐' : '꺼짐'}</b> · 눌러서 ${chulgoPushEnabled() ? '끄기' : '켜기'} <span style="font-weight:500;color:var(--t3)">(원하는 사람만 · 앱 꺼져도 수신)</span></button>
    ${side === 'office' ? chulgoOfficeSection() : chulgoWarehouseSection()}`;
}
async function issueDispatch() {
  const ids = [...document.querySelectorAll('#chulgo-queue input.cq-chk:checked')].map(c => c.value);
  if (!ids.length) { toast('출고 지시할 항목을 체크하세요'); return; }
  const sel = (el('dsp-driver-sel') && el('dsp-driver-sel').value) || '';
  const company = sel === '__company';
  let driver = '';
  if (company) driver = '업체 배차';
  else if (sel === '__other') driver = (el('dsp-driver-other') && el('dsp-driver-other').value || '').trim();
  else driver = sel;
  const loadTime = (el('dsp-time') && el('dsp-time').value || '').trim();
  const overrideDest = (el('dsp-dest') && el('dsp-dest').value || '').trim();   // 공통 하차지(선택) — 비우면 각 건의 하차지 유지
  const packing = !!(el('dsp-pack') && el('dsp-pack').dataset.on === '1');
  const dispatchNote = (el('dsp-memo') && el('dsp-memo').value || '').trim();   // 비고·특이사항
  const selReqs = (state.chulgoReqs || []).filter(r => ids.includes(r.id));
  if (sel === '__other' && !driver) { toast('기사명을 입력하세요'); return; }
  if (!company && selReqs.some(r => !(overrideDest || (r.dispatchDest || '').trim()))) { toast('하차지가 없는 건이 있습니다. 공통 출고지를 입력하거나 출고 등록 시 하차지를 지정하세요'); return; }
  if (_busy) return; _busy = true;
  try {
    const dispatchId = 'D' + Date.now();
    const clients = [...new Set(selReqs.map(r => r.client).filter(Boolean))];
    const dests = new Set();
    for (const id of ids) {
      const r = selReqs.find(x => x.id === id) || {};
      const itemDest = company ? '' : (overrideDest || (r.dispatchDest || '').trim());   // 업체별 하차지 유지(공통 입력 시 덮어씀)
      if (itemDest) dests.add(itemDest);
      await Store.update('chulgoReqs', id, { status: '지시', dispatchId, vehicle: '', driver, companyDispatch: company, loadTime, packing, dispatchNote, dispatchDest: itemDest, dispatchedAt: Date.now(), dispatchedBy: (me && me.name) || '' });
    }
    const destTxt = company ? '' : [...dests].join(' / ');
    const summary = (clients.join(', ') || '출고') + (ids.length > 1 ? ` 외 ${ids.length}건` : '') + (packing ? ' · 📦포장' : '') + (destTxt ? ' → ' + destTxt : '');
    notifyChulgoDispatch(summary);   // 옵트인한 휴대폰으로 푸시
    toast('출고 지시 ' + ids.length + '건 발령 · 창고에 알림 🔔');
    renderChulgo();
  } finally { setTimeout(() => { _busy = false; }, 600); }
}
async function submitChulgoReq() {
  const client = (el('cr-client') && el('cr-client').value || '').trim();
  const reqType = el('cr-type') ? el('cr-type').value : '입고';
  const items = collectCrItems();
  const urgency = el('cr-urg') ? el('cr-urg').value : '보통';
  const urgent = urgency !== '보통';
  const schedDate = el('cr-sched') ? el('cr-sched').value : '';
  const memo = (el('cr-memo') && el('cr-memo').value || '').trim();
  const flags = { basin: !!(el('cr-basin') && el('cr-basin').checked), pack: !!(el('cr-pack') && el('cr-pack').checked), pallet: !!(el('cr-pallet') && el('cr-pallet').checked) };
  if (!client) { toast('거래처를 입력하세요'); return; }
  if (!items.length) { toast('품목·수량을 입력하세요'); return; }
  if (_busy) return; _busy = true;
  try {
    const docNo = chulgoNextDocNo(reqType);
    await ensureClient(client);
    await Store.add('chulgoReqs', { docNo, reqType, client, items, urgency, urgent, schedDate, memo, flags, status: '대기열', sender: (me && me.name) || '', createdAt: Date.now() });
    toast('등록됨 · ' + docNo);
    renderChulgo();
  } finally { setTimeout(() => { _busy = false; }, 600); }
}
async function chulgoAck(id) { const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return; await Store.update('chulgoReqs', id, { status: '확인', ackedBy: (me && me.name) || '', ackedAt: Date.now() }); toast('접수(확인) 처리됨'); }
async function chulgoDone(id) {
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return;
  const isAlert = r.reqType === '입고알림';
  const applied = r.stockApplied;
  if (!applied && !isAlert) {
    if (!confirm(`${r.reqType} 완료 처리하고 실재고에 반영할까요?\n(${r.reqType === '입고' ? '재고 증가' : '재고 차감'} · 재고 앱 ${r.reqType} 내역에도 기록)`)) return;
  }
  const patch = { status: '완료', doneBy: (me && me.name) || '', doneAt: Date.now() };
  if (!applied && !isAlert) {
    const shipId = 'C' + Date.now();
    for (const it of (r.items || [])) {
      const q = +it.qty || 0; if (q <= 0) continue;
      const inv = state.inventory.find(i => _normName(i.name) === _normName(it.name));
      if (r.reqType === '입고') {
        if (inv) await Store.update('inventory', inv.id, { jang: (+inv.jang || 0) + q, lastInDate: todayStr() });
        await Store.add('transactions', { type: 'in', itemId: inv ? inv.id : '', itemName: it.name, spec: it.spec || '', jang: q, hebe: inv ? +(q * (+inv.hebePerJang || 0)).toFixed(2) : 0, vendor: r.client || '', date: todayStr(), note: '출고관리 입고 ' + (r.docNo || ''), by: (me && me.name) || '' });
      } else {
        if (inv) await Store.update('inventory', inv.id, { jang: Math.max(0, (+inv.jang || 0) - q) });
        await Store.add('transactions', { type: 'out', shipId, itemId: inv ? inv.id : '', itemName: it.name, spec: it.spec || '', jang: q, hebe: inv ? +(q * (+inv.hebePerJang || 0)).toFixed(2) : 0, lot: '', targetName: r.client || '', dest: '출고관리', factory: '출고관리', date: todayStr(), note: '출고관리 ' + (r.docNo || ''), by: (me && me.name) || '' });
      }
    }
    patch.stockApplied = true; patch.stockShipId = shipId;
  }
  await Store.update('chulgoReqs', id, patch);
  toast('완료 처리' + (patch.stockApplied ? ' · 재고 반영됨' : ''));
}
/* 출고 취소: 연결된 출고 기록 삭제 + 재고 복구 + 홀딩 되돌림 */
async function cancelChulgoStock(r) {
  if (!r || r.reqType !== '출고') return;
  if (r.sourceBasinId) {   // 세면대 출고 취소 — 발주를 완료 이전 단계(출항)로 되돌림
    const b = (state.basins || []).find(x => x.id === r.sourceBasinId);
    if (b && (b.stage || '') === '완료') { const st = BASIN_STAGES[BASIN_STAGES.length - 2] || '국내입고'; await basinSetStage(b.id, st, { shipDate: '' }); }
    return;
  }
  if (!r.sourceShipId) return;
  const key = r.sourceShipId;
  const txns = (state.transactions || []).filter(t => t.type === 'out' && (t.shipId || t.id) === key);
  for (const t of txns) { if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); } await Store.remove('transactions', t.id); }
  try { await revertHoldsForShip(key); } catch (e) { }
}
async function delChulgoReq(id) {
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return;
  const isOut = r.reqType === '출고' && (r.sourceShipId || r.sourceBasinId);
  const msg = r.sourceBasinId ? '이 세면대 출고를 취소할까요?\n· 발주가 완료 이전 단계로 되돌아가고\n· 대기열/지시에서 제거됩니다.' : (isOut ? '이 출고를 취소할까요?\n· 재고가 복구되고\n· 출고 내역·대기열/지시에서 함께 제거됩니다.' : '이 항목을 삭제할까요?');
  if (!confirm(msg)) return;
  if (isOut) await cancelChulgoStock(r);
  await Store.remove('chulgoReqs', id);
  toast(isOut ? '출고 취소됨 · 재고 복구' : '삭제됨');
}
async function cancelDispatch(dispatchId) {
  const reqs = (state.chulgoReqs || []).filter(r => r.dispatchId === dispatchId && (r.status || '') !== '완료');
  if (!reqs.length) { toast('취소할 지시가 없습니다'); return; }
  if (!confirm(`이 출고 지시(${reqs.length}건)를 취소하고 대기열로 되돌릴까요?\n· 재고는 그대로 유지됩니다\n· 대기열에서 다시 배차해 지시할 수 있습니다`)) return;
  for (const r of reqs) { await Store.update('chulgoReqs', r.id, { status: '대기열', dispatchId: '', dispatchedAt: 0, dispatchedBy: '', driver: '', companyDispatch: false, loadTime: '', packing: false, dispatchDest: '' }); }
  toast('출고 지시 취소 · 대기열로 이동'); renderChulgo();
}
/* ── 요청별 채팅 (사무실 ↔ 창고) ── */
let _chulgoChatOpen = '';
function chulgoMineSide() { return chulgoSide() === 'warehouse' ? 'wh' : 'office'; }
function chulgoUnread(r) { const mine = chulgoMineSide(); const other = mine === 'wh' ? 'office' : 'wh'; const rt = mine === 'wh' ? (+r.readWh || 0) : (+r.readOffice || 0); return (r.chats || []).filter(m => m.side === other && (+m.at || 0) > rt).length; }
function chulgoChatThreadHtml(r) {
  const mine = chulgoMineSide(); const msgs = r.chats || [];
  if (!msgs.length) return `<div style="text-align:center;color:var(--t3);font-size:12.5px;padding:22px">아직 메시지가 없습니다. 첫 메시지를 보내보세요.</div>`;
  return msgs.map(m => { const isMe = m.side === mine; const t = m.at ? new Date(+m.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; return `<div style="display:flex;justify-content:${isMe ? 'flex-end' : 'flex-start'};margin:5px 6px"><div style="max-width:78%"><div style="font-size:10.5px;color:var(--t3);margin-bottom:2px;text-align:${isMe ? 'right' : 'left'}">${esc(m.name || (m.side === 'wh' ? '창고' : '사무실'))} · ${t}</div><div style="background:${isMe ? 'var(--g)' : '#fff'};color:${isMe ? '#fff' : 'var(--t1)'};padding:8px 11px;border-radius:12px;font-size:13.5px;word-break:break-word;border:${isMe ? 'none' : '1px solid var(--bd2)'}">${esc(m.text)}</div></div></div>`; }).join('');
}
async function openChulgoChat(id) {
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) { toast('요청을 찾을 수 없습니다'); return; }
  _chulgoChatOpen = id;
  openModal(`<div class="sheet-h"><h3><i class="ti ti-messages"></i>채팅 · ${esc(r.docNo || '')} ${esc(r.client || '')}</h3><button class="x" onclick="closeChulgoChat()">×</button></div>
    <div id="chulgo-chat-thread" style="max-height:52vh;min-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 2px;background:var(--soft);border-radius:10px">${chulgoChatThreadHtml(r)}</div>
    <div style="display:flex;gap:8px;margin-top:10px"><input id="chulgo-chat-in" lang="ko" placeholder="메시지 입력 후 Enter" autocomplete="off" style="flex:1;font-size:15px;padding:11px 12px;border:1.5px solid var(--bd2);border-radius:10px" onkeydown="if(event.key==='Enter'){event.preventDefault();sendChulgoChat('${id}');}"><button class="btn btn-pri" onclick="sendChulgoChat('${id}')"><i class="ti ti-send"></i></button></div>`);
  chulgoMarkRead(id);
  setTimeout(() => { const t = el('chulgo-chat-thread'); if (t) t.scrollTop = t.scrollHeight; const i = el('chulgo-chat-in'); if (i) i.focus(); }, 60);
}
function closeChulgoChat() { _chulgoChatOpen = ''; closeModal(); }
async function chulgoMarkRead(id) { const mine = chulgoMineSide(); const patch = {}; if (mine === 'wh') patch.readWh = Date.now(); else patch.readOffice = Date.now(); try { await Store.update('chulgoReqs', id, patch); } catch (e) { } }
async function sendChulgoChat(id) {
  const inp = el('chulgo-chat-in'); const text = inp ? (inp.value || '').trim() : ''; if (!text) return;
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return;
  const mine = chulgoMineSide();
  const chats = (r.chats || []).slice(); chats.push({ side: mine, name: (me && me.name) || '', text: text, at: Date.now() });
  const patch = { chats: chats }; if (mine === 'wh') patch.readWh = Date.now(); else patch.readOffice = Date.now();
  if (inp) inp.value = '';
  try { await Store.update('chulgoReqs', id, patch); } catch (e) { toast('전송 실패'); }
}
function refreshChulgoChatIfOpen() { if (!_chulgoChatOpen) return; const t = el('chulgo-chat-thread'); if (!t) return; const r = (state.chulgoReqs || []).find(x => x.id === _chulgoChatOpen); if (!r) return; const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40; t.innerHTML = chulgoChatThreadHtml(r); if (atBottom) t.scrollTop = t.scrollHeight; }
/* ── 새 출고 지시 알림 (창고가 소리로 인지) ── */
let _chAudio = null;
/* 알림음 — 전 기기 통일: 8비트 파워업 상승음(도미솔도미) */
function chulgoBeep(times) {
  try {
    const ctx = _chAudio || new (window.AudioContext || window.webkitAudioContext)(); _chAudio = ctx;
    if (ctx.state === 'suspended') ctx.resume();
    let comp; try { comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 12; comp.attack.value = 0.002; comp.release.value = 0.12; comp.connect(ctx.destination); } catch (e) { comp = ctx.destination; }
    const master = ctx.createGain(); master.gain.value = 0.95; master.connect(comp);
    const note = (f, t0, dur, amp) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; o.connect(g); g.connect(master); o.frequency.setValueAtTime(f, t0); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(amp, t0 + 0.008); g.gain.setValueAtTime(amp, t0 + dur - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.start(t0); o.stop(t0 + dur + 0.02); };
    const seq = [523, 659, 784, 1047, 1319];   // C E G C E — 상승 8비트
    const reps = Math.max(2, times || 2);
    let t = ctx.currentTime + 0.02;
    for (let r = 0; r < reps; r++) { seq.forEach((f, i) => note(f, t + i * 0.075, 0.07, 0.82)); t += 0.075 * seq.length + 0.2; }
  } catch (e) { }
}
let _chulgoArmed = false, _chulgoAlarmTimer = null;
function chulgoHasNewDispatch() { return (state.chulgoReqs || []).some(r => (r.status || '') === '지시'); }   // 알림 켠 기기는 접수 전 지시가 있으면 계속 울림(지시자 본인 포함 — 테스트/자체 확인 가능)
function chulgoStartAlarmLoop() {
  if (_chulgoAlarmTimer) return;
  _chulgoAlarmTimer = setInterval(() => {
    if (!_chulgoArmed) return;
    if (chulgoHasNewDispatch()) { chulgoBeep(2); try { if (navigator.vibrate) navigator.vibrate([250, 120, 250]); } catch (e) { } }   // 접수(확인) 전까지 계속 반복
  }, 3000);
}
function chulgoPrimeAudio() {
  try { _chAudio = _chAudio || new (window.AudioContext || window.webkitAudioContext)(); if (_chAudio.state === 'suspended') _chAudio.resume(); } catch (e) { }
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { }
  _chulgoArmed = true; chulgoStartAlarmLoop();
  chulgoBeep(2);
  toast('알림 소리 켜짐 · 새 지시가 오면 접수할 때까지 소리로 알립니다');
  try { renderChulgo(); } catch (e) { }
}
function chulgoDisarmAudio() {
  _chulgoArmed = false;
  toast('알림 소리 꺼짐');
  try { renderChulgo(); } catch (e) { }
}
/* 알림은 '출고 지시' 발령 시에만 (대기열 등록 시엔 조용). 지시 문서를 처음 본 순간 소리. */
let _chulgoDispSeen = null;
function chulgoAlertNew() {
  const dispatched = (state.chulgoReqs || []).filter(r => (r.status || '') === '지시');
  if (_chulgoDispSeen === null) { _chulgoDispSeen = new Set(dispatched.map(r => r.id)); return; }   // 최초 로드: 알림 안 함
  const now = Date.now();
  const fresh = dispatched.filter(r => !_chulgoDispSeen.has(r.id) && (now - (+r.dispatchedAt || +r.createdAt || 0) < 120000) && _normName(r.dispatchedBy || r.sender) !== _normName((me && me.name) || ''));
  dispatched.forEach(r => _chulgoDispSeen.add(r.id));
  if (!fresh.length) return;
  if (!_wantChulgoPush()) return;   // 기기별: '휴대폰 출고 지시 알림' 켠 기기에서만 알람 (전체 동기화 방지)
  if (_chAudio) { _chulgoArmed = true; chulgoStartAlarmLoop(); try { renderChulgo(); } catch (e) { } }   // 새 지시 오면 자동으로 알림 켜고 접수 전까지 반복
  const urgent = fresh.some(f => f.urgent);
  chulgoBeep(urgent ? 4 : 2);
  try { if (navigator.vibrate) navigator.vibrate(urgent ? [200, 100, 200, 100, 200] : [200, 100, 200]); } catch (e) { }
  const f = fresh[0]; const veh = f.companyDispatch ? ' · 🚚업체배차' : (f.driver ? ' · 기사 ' + f.driver : '');
  toast('🔔 새 출고 지시 · ' + (f.client || '') + veh + (fresh.length > 1 ? ` 외 ${fresh.length - 1}건` : ''));
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('새 출고 지시' + (urgent ? ' ⚠️긴급' : ''), { body: (f.client || '') + ' · ' + (f.items || []).map(x => x.name).join(', ') + veh, tag: 'chulgo-' + (f.dispatchId || f.id) }); } catch (e) { }
}
function renderSettings() {
  el('pg-settings').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-settings"></i>설정</h2><p>${esc(me.name)} 님${isAdmin() ? ' · 관리자' : ''}</p></div></div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-users"></i>직원 관리</h3>${isAdmin() ? `<button class="more" onclick="openMemberForm()"><i class="ti ti-plus"></i>추가</button>` : ''}</div>
      ${state.members.map(m => `<div class="mem"><div class="av">${esc(initial(m.name))}</div><div class="info"><div class="nm">${esc(m.name)}</div>${isAdmin() ? `<div class="rl">${esc(m.email || '이메일 미설정')}</div>` : ''}</div>${isAdmin() ? `<span class="pill ${m.role === 'admin' ? 'p-prog' : (m.role === 'customer' ? 'p-hold' : (m.role === 'crew' ? 'p-wait' : 'p-gray'))}">${m.role === 'admin' ? '관리자' : (m.role === 'customer' ? '고객' : (m.role === 'crew' ? '시공팀' : '직원'))}</span><button class="x" onclick="openMemberForm('${m.id}')"><i class="ti ti-edit" style="font-size:17px"></i></button>` : ''}</div>`).join('')}
      ${isAdmin() && CLOUD ? `<button class="btn btn-block btn-sm" style="margin-top:10px" onclick="syncAllRolesNow()"><i class="ti ti-shield-check"></i>직원 권한 문서 동기화 <span style="color:var(--t3);font-weight:500">(보안규칙 적용 전 1회)</span></button>` : ''}
      ${isAdmin() && CLOUD ? `<button class="btn btn-block btn-sm" style="margin-top:8px" onclick="unifyFactories()"><i class="ti ti-building-factory-2"></i>공장명 통일 · 중복 정리 <span style="color:var(--t3);font-weight:500">(공장/시공팀/발주처/규격 중복 삭제)</span></button>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-briefcase"></i>거래처 관리</h3>${isAdmin() && (state.clients || []).length ? `<button class="more" style="color:var(--red-t)" onclick="delAllClients()"><i class="ti ti-trash" style="font-size:14px"></i>전체 삭제</button>` : ''}</div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><input id="client-new" placeholder="거래처명 입력" autocomplete="off" style="flex:1;font-size:16px;padding:11px 12px;border:1.5px solid var(--bd2);border-radius:10px"><button class="btn btn-pri btn-sm" onclick="addClient()"><i class="ti ti-plus"></i>등록</button></div>
      ${(state.clients || []).length ? `<div id="client-scroll" data-keepscroll style="max-height:300px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:10px;padding:2px 8px">${state.clients.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(c => `<div class="mem"><div class="info"><div class="nm">${esc(c.value)}</div></div>${isAdmin() ? `<button class="x" onclick="delClient('${c.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}</div>`).join('')}</div><div style="font-size:11.5px;color:var(--t3);margin-top:6px">총 ${(state.clients || []).length}개</div>` : `<div style="font-size:12.5px;color:var(--t3);padding:4px 0">등록된 거래처가 없습니다. 등록하면 현장·출고·홀딩의 업체명 검색에 나옵니다.</div>`}
      ${!isAdmin() ? `<div class="banner info" style="margin-top:10px"><i class="ti ti-info-circle"></i>거래처 삭제는 관리자만 가능합니다.</div>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bell"></i>푸시 알림</h3></div>
      <div style="font-size:12.5px;color:var(--t2);margin-bottom:8px">재고 0·시공 전날(오후 2시) 알림을 이 기기로 받습니다.</div>
      ${(() => {
        const st = pushStatus();
        if (st === 'granted') return `<div class="banner b" style="background:var(--gl2);border-color:var(--gbd)"><i class="ti ti-bell" style="color:var(--gd)"></i><span>이 기기는 <b>알림 받는 중</b>입니다.</span></div><button class="btn btn-block" style="margin-top:8px" onclick="enablePush()"><i class="ti ti-refresh"></i>알림 다시 등록</button>`;
        if (st === 'denied') return `<div class="banner warn"><i class="ti ti-bell"></i><span>알림이 <b>차단</b>되어 있습니다. 브라우저 사이트 설정에서 알림을 '허용'으로 바꾼 뒤 다시 시도하세요.</span></div>`;
        if (st === 'unsupported') return `<div class="banner warn"><i class="ti ti-bell"></i><span>이 브라우저는 알림 미지원입니다. <b>아이폰은 홈 화면에 추가</b> 후 그 아이콘으로 열어 사용하세요.</span></div>`;
        return `<button class="btn btn-pri btn-block" onclick="enablePush()"><i class="ti ti-bell"></i>이 기기에서 알림 받기</button>`;
      })()}
      <div style="font-size:11.5px;color:var(--t3);margin-top:8px"><i class="ti ti-device-mobile"></i> 아이폰: 사파리로 열고 <b>공유 → 홈 화면에 추가</b> → 홈 화면 아이콘으로 열어 등록해야 알림이 옵니다.</div>
    </div>
    ${isAdmin() ? `<div class="card">
      <div class="card-h"><h3><i class="ti ti-clipboard-list"></i>출고관리</h3></div>
      <div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd)"><div class="ai" style="color:var(--gd)"><i class="ti ti-clipboard-check"></i></div><div class="at"><b>출고관리가 이 앱에 통합되었습니다</b><span>하단 메뉴 '출고관리' 탭에서 사무실 요청 → 창고 확인 → 지시서까지. 완료 시 실재고 자동 반영.</span></div></div>
    </div>` : ''}
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-cloud"></i>연결 상태</h3></div>
      <div class="alert-i ${CLOUD ? 'b' : 'a'}" style="${CLOUD ? 'background:var(--gl2);border-color:var(--gbd)' : ''}">
        <div class="ai" style="${CLOUD ? 'color:var(--gd)' : ''}"><i class="ti ti-${CLOUD ? 'cloud-check' : 'device-mobile'}"></i></div>
        <div class="at"><b>${CLOUD ? '실시간 클라우드 동기화 ON' : '미리보기 모드 (이 기기에만 저장)'}</b><span>${CLOUD ? '모든 기기(iOS·안드로이드·크롬·사파리)에서 같은 데이터 공유' : 'Firebase를 연결하면 모든 기기에서 실시간 공유됩니다'}</span></div>
      </div>
      ${!CLOUD ? `<button class="btn btn-block" style="margin-top:10px" onclick="openHelp()"><i class="ti ti-help-circle"></i>실시간 공유 연결 방법 보기</button>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-book"></i>업무 참고</h3></div>
      <button class="btn btn-block" style="margin-bottom:8px" onclick="openQuoteHelper()"><i class="ti ti-calculator"></i>견적 비용 도우미</button>
      <button class="btn btn-block" onclick="openHelp()"><i class="ti ti-help-circle"></i>설치·연결 도움말</button>
    </div>
    <button class="btn btn-block" style="color:var(--red-t);margin-top:4px" onclick="logout()"><i class="ti ti-logout"></i>로그아웃</button>
    <div style="text-align:center;font-size:11px;color:var(--t3);margin:16px 0 8px">다우세라믹앤석재 통합관리 · v1.0</div>`;
}
function openMemberForm(id) {
  if (!isAdmin()) return;
  const m = id ? state.members.find(x => x.id === id) : null; const v = m || { role: 'staff', email: '' };
  const curMenus = Array.isArray(v.menus) ? v.menus : ALL_TABS.filter(t => !RESTRICTED_TABS.includes(t));
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-user-plus"></i>${m ? '직원 수정' : '직원 추가'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>이름<span class="req">*</span></label><input id="m-name" value="${esc(v.name || '')}" placeholder="이름"></div>
      <div class="fld"><label>권한</label><select id="m-role"><option value="staff" ${v.role === 'staff' ? 'selected' : ''}>직원</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>관리자</option><option value="customer" ${v.role === 'customer' ? 'selected' : ''}>고객(거래처) · 재고조회만</option><option value="crew" ${v.role === 'crew' ? 'selected' : ''}>시공팀 · 시공 스케줄만</option></select></div>
      <div class="fld full"><label>로그인 이메일<span class="req">*</span></label><input id="m-email" type="email" value="${esc(v.email || '')}" autocapitalize="none" spellcheck="false" placeholder="예) hong@dawoo.com"></div>
      <div class="fld full"><label>연락처 <span style="color:var(--t3);font-weight:500">(견적서 담당자 연락처로 표시)</span></label><input id="m-phone" value="${esc(v.phone || '')}" placeholder="예) 010-1234-5678"></div>
      <div class="fld full"><div class="perm-head"><label style="margin:0"><i class="ti ti-lock-access"></i> 메뉴 접근 권한 <span style="color:var(--t3);font-weight:500">— 직원 권한일 때 적용</span></label>
        <div class="perm-quick"><button type="button" onclick="menuPermAll(true)">전체 허용</button><button type="button" onclick="menuPermAll(false)">전체 해제</button></div></div>
        <div class="perm-grid">${ALL_TABS.filter(t => !ALWAYS_TABS.includes(t)).map(t => { const sens = RESTRICTED_TABS.includes(t); return `<div class="perm-row${sens ? ' sens' : ''}"><span class="perm-lab"><i class="ti ${TAB_ICONS[t] || 'ti-square'}"></i>${TAB_LABELS[t]}${sens ? '<span class="pbadge">민감</span>' : ''}</span><label class="swt"><input type="checkbox" class="m-menu" value="${t}" ${curMenus.includes(t) ? 'checked' : ''}><span class="track"></span></label></div>`; }).join('')}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:7px;line-height:1.5">· 홈 · 설정은 항상 접근 가능 · 관리자는 전체 접근 · <b>정산</b>은 민감 정보라 기본 꺼짐</div></div>

    </div>
    ${m && v.email ? `<div class="fld full" style="margin-bottom:12px"><label><i class="ti ti-key" style="font-size:13px;color:var(--blue)"></i> 비밀번호 변경 <span style="color:var(--t3);font-weight:500">— 메일 없이 바로 적용(가메일 계정 가능)</span></label>
      <div style="display:flex;gap:8px">
        <input id="m-newpw" type="text" autocapitalize="none" spellcheck="false" placeholder="새 비밀번호 (6자 이상)" style="flex:1">
        <button class="btn btn-pri btn-sm" type="button" style="flex:none" onclick="adminSetPw('${esc(v.email)}')"><i class="ti ti-check"></i>변경</button>
      </div></div>` : `<div class="banner info" style="margin:0 0 12px"><i class="ti ti-info-circle"></i>이 이메일로 Firebase 콘솔에서 계정(비밀번호)을 먼저 만들어야 로그인됩니다. 만든 뒤엔 여기서 비밀번호를 바로 바꿀 수 있습니다.</div>`}
    <div class="frm-foot">
      ${m && state.members.length > 1 ? `<button class="btn btn-danger" onclick="delMember('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn btn-pri" style="flex:1" onclick="submitMember('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
}
/* 관리자 전용: 계정 비밀번호 직접 변경 (가메일 계정용 · 메일 불필요) */
async function adminSetPw(email) {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  if (!CLOUD || !auth || !auth.currentUser) { toast('클라우드 모드에서만 가능합니다'); return; }
  email = (email || '').trim().toLowerCase();
  const pw = (el('m-newpw') && el('m-newpw').value) || '';
  if (!email) { toast('이 계정의 로그인 이메일이 없습니다'); return; }
  if (pw.length < 6) { toast('비밀번호는 6자 이상 입력하세요'); return; }
  if (!confirm(email + '\n이 계정의 비밀번호를 변경할까요?')) return;
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(PUSH_FN + '?action=setpw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ email: email, password: pw })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { toast('비밀번호가 변경되었습니다 ✓'); if (el('m-newpw')) el('m-newpw').value = ''; }
    else if (r.status === 403) { toast('권한 없음 (관리자만)'); }
    else if (j.error === 'invalid input') { toast('이메일/비밀번호를 확인하세요 (6자 이상)'); }
    else if (r.status === 400 || (j.error && /EMAIL_NOT_FOUND|no user/i.test(j.error))) { toast('그 이메일로 만든 계정이 없습니다 (콘솔에서 먼저 생성)'); }
    else { toast('변경 실패: ' + (j.error || r.status)); }
  } catch (e) { toast('변경 실패: ' + (e && e.message || '')); }
}
async function submitMember(id) {
  const name = el('m-name').value.trim();
  const email = (el('m-email').value || '').trim().toLowerCase();
  if (!name || !email) { toast('이름과 로그인 이메일을 입력하세요'); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('이메일 형식을 확인하세요'); return; }
  if (state.members.some(m => m.id !== id && (m.email || '').toLowerCase() === email)) { toast('이미 등록된 이메일입니다'); return; }
  const _menus = Array.from(document.querySelectorAll('.m-menu')).filter(c => c.checked).map(c => c.value);
  const obj = { name, role: el('m-role').value, email, phone: (el('m-phone') && el('m-phone').value || '').trim() };
  if (obj.role === 'staff') obj.menus = _menus;
  const prevEmail = id ? ((state.members.find(m => m.id === id) || {}).email || '').toLowerCase() : '';
  if (id) await Store.update('members', id, obj); else await Store.add('members', obj);
  await setRoleDoc(email, obj.role, name, prevEmail);
  toast('저장됨'); closeModal();
}
async function setRoleDoc(email, role, name, prevEmail) {
  if (!CLOUD) return;
  try {
    if (prevEmail && prevEmail !== email) await cref('roles').doc(prevEmail).delete();
    await cref('roles').doc(email).set({ role: role || 'staff', name: name || '' });
  } catch (e) { console.warn('roles doc', e); }
}
async function delMember(id) {
  if (!guardDelete('이 직원 계정을 삭제할까요?')) return;
  const m = state.members.find(x => x.id === id);
  await Store.remove('members', id);
  if (m && m.email) { try { await cref('roles').doc((m.email || '').toLowerCase()).delete(); } catch (e) { } }
  toast('삭제됨'); closeModal();
}
async function addClient() {
  const v = (el('client-new') && el('client-new').value || '').trim();
  if (!v) { toast('거래처명을 입력하세요'); return; }
  if ((state.clients || []).some(c => c.value === v)) { toast('이미 등록된 거래처입니다'); el('client-new').value = ''; return; }
  await Store.add('clients', { value: v }); el('client-new').value = ''; toast('거래처 등록됨');
}
async function delClient(id) { if (!isAdmin()) return; if (!confirm('이 거래처를 삭제할까요?')) return; await Store.remove('clients', id); toast('삭제됨'); }
async function delAllClients() {
  if (!isAdmin()) return;
  if (!guardDelete('등록된 거래처를 전부 삭제할까요? 되돌릴 수 없습니다.')) return;
  for (const c of (state.clients || []).slice()) { await Store.remove('clients', c.id); }
  toast('거래처 전체 삭제됨');
}

function openHelp() {
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-help-circle"></i>실시간 공유 연결 방법</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>아래는 모든 기기에서 실시간으로 데이터를 공유하기 위한 <b>1회 설정</b>입니다. 동봉된 <b>설치가이드</b> 파일에 그림과 함께 더 자세히 있습니다.</span></div>
    <div class="help-step"><div class="n">1</div><div><b>Firebase 프로젝트 만들기</b><p><code>console.firebase.google.com</code> 접속 → 프로젝트 추가(무료)</p></div></div>
    <div class="help-step"><div class="n">2</div><div><b>Firestore 데이터베이스 생성</b><p>좌측 메뉴 Firestore Database → 데이터베이스 만들기 → '테스트 모드'로 시작</p></div></div>
    <div class="help-step"><div class="n">3</div><div><b>웹 앱 추가 후 설정값 복사</b><p>프로젝트 설정 → 웹 앱 추가(&lt;/&gt;) → 표시되는 <code>firebaseConfig</code> 값 복사</p></div></div>
    <div class="help-step"><div class="n">4</div><div><b>index.html에 붙여넣기</b><p><code>index.html</code> 파일의 <code>FIREBASE_CONFIG</code> 따옴표 안에 값 입력 후 저장</p></div></div>
    <div class="help-step"><div class="n">5</div><div><b>인터넷에 올리기</b><p>GitHub Pages 등에 업로드하면 주소 하나로 모든 직원이 접속·실시간 공유</p></div></div>
    <div class="frm-foot"><button class="btn btn-pri btn-block" onclick="closeModal()">확인</button></div>`);
}

/* 견적 비용 도우미 */
function openQuoteHelper() {
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-calculator"></i>견적 비용 도우미</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner warn"><i class="ti ti-alert-triangle"></i><span>고객응대 매뉴얼 기준 <b>참고 견적</b>입니다. 실제 견적은 현장 조건에 따라 조정하세요.</span></div>
    <div class="frm">
      <div class="fld"><label>헤베(㎡)</label><input id="q-hebe" inputmode="decimal" placeholder="헤베" oninput="calcQuote()"></div>
      <div class="fld"><label>가공 장수</label><input id="q-jang" inputmode="numeric" placeholder="장수" oninput="calcQuote()"></div>
      <div class="fld"><label>지역</label><input id="q-region" placeholder="지역" oninput="calcQuote()"></div>
      <label class="chk" id="q-am-w"><input type="checkbox" id="q-allmarble" onchange="this.closest('.chk').classList.toggle('on',this.checked);calcQuote()"> 모든대리석 시공</label>
    </div>
    <div id="q-out"></div>`);
  calcQuote();
}
function calcQuote() {
  const r = estimateQuote({ hebe: el('q-hebe').value, jang: el('q-jang').value, region: el('q-region').value, allMarble: el('q-allmarble').checked });
  el('q-out').innerHTML = `<div class="reco" style="margin-top:14px">
    <div class="reco-h"><i class="ti ti-receipt"></i>참고 견적</div>
    <div class="row"><span class="rl">가공비 (장당 50만)</span><span class="rv"><b>${won(r.gagong)}원</b></span></div>
    <div class="row"><span class="rl">실측비</span><span class="rv"><b>${won(r.measure)}원</b></span></div>
    <div class="row"><span class="rl">시공비${''}</span><span class="rv"><b>${won(r.construct)}원</b></span></div>
    ${r.local ? `<div class="row"><span class="rl">지방 출장비</span><span class="rv"><b>${won(r.local)}원</b></span></div>` : ''}
    <div class="row"><span class="rl" style="font-size:14px">합계 (운송비 별도)</span><span class="rv"><b style="font-size:16px">${won(r.total)}원</b></span></div>
  </div>`;
}
/* 다우세라믹앤석재 통합관리 v1.1 */
