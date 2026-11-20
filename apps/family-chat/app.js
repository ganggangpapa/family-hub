// 가족 홈: 메뉴(오늘저녁 · 초등학습 · 중등학습 · 가족채팅) + 가족채팅(실시간, 이전 메시지)
// 서버 규칙(RLS)은 family-hub/supabase/schema.sql 에 있습니다.
(() => {
  'use strict';

  const cfg = window.FAMILY_CHAT_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const PAGE = 50;
  const KIND_LABEL = { cheer: '응원', sticker: '칭찬 스티커', show: '보여 주기', meal_request: '먹고 싶어요' };
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== 'screen-' + name; });
  }

  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
    $('loading-msg').textContent = !window.supabase
      ? '필요한 파일을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.'
      : '설정이 아직 비어 있어요. config.js에 Supabase 주소와 공개 키를 넣어 주세요.';
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------- 상태 ----------
  let me = null;              // 내 구성원 정보 (members 행)
  let isAnon = false;         // 아이 폰(익명 로그인)인지
  let members = new Map();    // id → { nickname, role }
  let msgs = [];              // 화면에 있는 메시지 (오래된 것 → 새것)
  let ids = new Set();
  let noMoreOlder = false;
  let loadingOlder = false;
  let channel = null;
  let entering = false;
  let tmpSeq = 0;
  let chatDirty = true;       // 채팅 화면이 숨어 있는 동안 바뀐 것이 있음
  let lastSeen = 0;           // 이 기기에서 마지막으로 본 메시지 번호 (안 읽은 개수 계산용)
  let showAll = false;        // 메뉴에서 "모든 메뉴 보기"를 눌렀는지

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 동작 */ } },
  };

  // ---------- 시작 ----------
  let failed = false;         // 인터넷 문제로 열지 못한 상태 (로그인은 그대로)

  async function start() {
    // 브라우저가 저장 공간을 정리할 때 로그인 정보를 지우지 않도록 요청 (홈 화면에 추가하면 대부분 허락됨)
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 무시 */ }
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { show('login'); return; }
    await enter();
  }

  sb.auth.onAuthStateChange((event) => {
    // (이 콜백 안에서 바로 서버를 부르면 멈출 수 있어 한 박자 뒤에 실행)
    // 메일의 로그인 링크를 눌러 들어온 경우
    if (event === 'SIGNED_IN' && !me && !entering && !$('screen-loading').hidden) setTimeout(enter, 0);
    // 서버가 로그인을 정말로 끝낸 경우(다른 곳에서 로그아웃, 연결 끊김 등)에만 로그인 화면으로
    if (event === 'SIGNED_OUT' && me) setTimeout(() => resetToLogin('로그인이 끝났어요. 다시 로그인해 주세요.'), 0);
  });

  function showRetry(msg) {
    failed = true;
    show('loading');
    $('loading-msg').textContent = msg;
    $('retry-btn').hidden = false;
  }
  $('retry-btn').addEventListener('click', () => { $('retry-btn').hidden = true; $('loading-msg').textContent = '다시 여는 중…'; enter(); });
  // 인터넷이 돌아오거나 화면으로 돌아오면 저절로 다시 시도
  window.addEventListener('online', () => { if (failed && !entering) enter(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && failed && !entering) enter();
  });

  async function enter() {
    if (entering) return;
    entering = true;
    try {
      show('loading');
      $('retry-btn').hidden = true;
      // 기기에 저장된 로그인 정보로 판단 (인터넷이 잠깐 끊겨도 로그아웃으로 보지 않음)
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { show('login'); return; }
      const user = session.user;
      isAnon = !!user.is_anonymous;

      const { data: m, error } = await sb.rpc('my_member');
      if (error) throw error;
      if (!m || !m.id) { show(isAnon ? 'child' : 'nofamily'); return; }
      me = m;

      const [{ data: fam }] = await Promise.all([
        sb.from('families').select('id,name').maybeSingle(),
        loadMembers(),
      ]);
      $('family-name').textContent = fam ? fam.name : '가족 홈';
      document.title = (fam ? fam.name + ' ' : '') + '가족 홈';
      $('menu-me').textContent = '나: ' + (me.nickname || '') + (me.role === 'parent' ? ' (부모)' : '');
      $('logout-btn').textContent = isAnon ? '이 폰 연결 끊기' : '로그아웃';
      $('hello').textContent = (me.nickname || '') + '님, 무엇을 할까요?';
      lastSeen = Number(store.get('fh-seen-' + me.id)) || 0;
      showAll = store.get('fh-all-' + me.id) === '1';
      setupTiles();

      msgs = []; ids = new Set(); noMoreOlder = false; chatDirty = true;
      route();
      const first = await fetchPage(null);
      // 처음 쓰는 기기는 예전 메시지를 모두 "안 읽음"으로 세지 않음
      if (store.get('fh-seen-' + me.id) === null) {
        lastSeen = first.length ? first[first.length - 1].id : 0;
        store.set('fh-seen-' + me.id, String(lastSeen));
      }
      addMessages(first, 'initial');
      subscribe();
      failed = false;
    } catch (e) {
      console.error(e);
      // 로그인 정보는 지우지 않고, 다시 시도할 수 있게만 함
      showRetry('지금 가족 홈에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      entering = false;
    }
  }

  async function loadMembers() {
    const { data, error } = await sb.from('members').select('id,nickname,role');
    if (error) throw error;
    members = new Map(data.map((r) => [r.id, r]));
  }

  // ---------- 메시지 불러오기 ----------
  const COLS = 'id,from_member,to_member,kind,body,created_at';

  async function fetchPage(beforeId) {
    let q = sb.from('messages').select(COLS)
      .eq('family_id', me.family_id)
      .order('id', { ascending: false })
      .limit(PAGE);
    if (beforeId) q = q.lt('id', beforeId);
    const { data, error } = await q;
    if (error) throw error;
    if (data.length < PAGE) noMoreOlder = true;
    return data.reverse();
  }

  async function loadOlder() {
    if (loadingOlder || noMoreOlder || !msgs.length) return;
    loadingOlder = true;
    $('older').textContent = '이전 메시지 불러오는 중…';
    try {
      const oldest = msgs.find((m) => typeof m.id === 'number');
      const rows = await fetchPage(oldest ? oldest.id : null);
      addMessages(rows, 'older');
    } catch (e) {
      console.error(e);
    } finally {
      loadingOlder = false;
      renderOlderHint();
    }
  }

  // 연결이 끊겼다 돌아왔을 때 그사이 메시지 채우기
  async function catchUp() {
    if (!me) return;
    const newest = [...msgs].reverse().find((m) => typeof m.id === 'number');
    if (!newest) return;
    const { data, error } = await sb.from('messages').select(COLS)
      .eq('family_id', me.family_id)
      .gt('id', newest.id)
      .order('id', { ascending: true })
      .limit(200);
    if (!error && data.length) addMessages(data, 'new');
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('family-' + me.family_id)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: 'family_id=eq.' + me.family_id },
        (payload) => addMessages([payload.new], 'new'))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { $('conn').hidden = true; catchUp(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { $('conn').hidden = false; }
      });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && me) catchUp();
  });
  window.addEventListener('online', () => { if (me) catchUp(); });

  async function addMessages(rows, mode) {
    const fresh = rows.filter((r) => !ids.has(r.id));
    if (!fresh.length) { if (mode === 'initial') render('bottom'); return; }
    fresh.forEach((r) => ids.add(r.id));

    if (fresh.some((r) => !members.has(r.from_member) || (r.to_member && !members.has(r.to_member)))) {
      try { await loadMembers(); } catch (e) { /* 이름 대신 '가족'으로 표시 */ }
    }

    if (mode === 'older') {
      msgs = fresh.concat(msgs);
      render('keep');
    } else {
      // 내가 보낸 임시 메시지가 서버에서 돌아온 경우 임시 것을 지움
      fresh.forEach((r) => {
        if (r.from_member === me.id) {
          const i = msgs.findIndex((m) => m.pending && m.body === r.body);
          if (i >= 0) msgs.splice(i, 1);
        }
      });
      const confirmed = msgs.filter((m) => typeof m.id === 'number');
      const local = msgs.filter((m) => typeof m.id !== 'number');
      msgs = confirmed.concat(fresh).sort((a, b) => a.id - b.id).concat(local);
      const mine = fresh.some((r) => r.from_member === me.id);
      render(mode === 'initial' || mine || nearBottom() ? 'bottom' : 'stay');
    }
  }

  // ---------- 그리기 ----------
  const fmtTime = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const dayKey = (d) => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  const minuteKey = (d) => dayKey(d) + '-' + d.getHours() + ':' + d.getMinutes();
  const nameOf = (id) => (members.get(id) || {}).nickname || '가족';

  function nearBottom() {
    const el = $('messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function render(scroll) {
    updateBadge();
    if ($('screen-chat').hidden) { chatDirty = true; return; }   // 숨어 있을 땐 열 때 그림
    chatDirty = false;
    const box = $('messages');
    const list = $('msg-list');
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const frag = document.createDocumentFragment();

    if (!msgs.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '아직 메시지가 없어요. 첫 인사를 남겨 보세요 👋';
      frag.appendChild(li);
    }

    let lastDay = '';
    msgs.forEach((m, i) => {
      const d = new Date(m.created_at);
      const dk = dayKey(d);
      if (dk !== lastDay) {
        const sep = document.createElement('li');
        sep.className = 'day';
        sep.textContent = fmtDay.format(d);
        frag.appendChild(sep);
        lastDay = dk;
      }
      const prev = msgs[i - 1];
      const next = msgs[i + 1];
      const sameAsPrev = prev && prev.from_member === m.from_member && dayKey(new Date(prev.created_at)) === dk
        && !m.to_member && !prev.to_member && m.kind === 'text' && prev.kind === 'text';
      const showTime = !next || next.from_member !== m.from_member
        || minuteKey(new Date(next.created_at)) !== minuteKey(d) || m.pending || m.failed;
      const mine = m.from_member === me.id;

      const li = document.createElement('li');
      li.className = 'msg' + (mine ? ' mine' : '') + (sameAsPrev ? ' cont' : '')
        + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '');

      if (!sameAsPrev && (!mine || m.to_member)) {
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = (mine ? '나' : nameOf(m.from_member)) + (m.to_member ? ' → ' + nameOf(m.to_member) : '');
        li.appendChild(who);
      }

      const row = document.createElement('div');
      row.className = 'row';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (m.kind !== 'text' && KIND_LABEL[m.kind]) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = KIND_LABEL[m.kind];
        bubble.appendChild(tag);
      }
      bubble.appendChild(document.createTextNode(m.body));
      row.appendChild(bubble);

      if (showTime) {
        const t = document.createElement('time');
        t.className = 'time';
        t.dateTime = m.created_at;
        t.textContent = m.failed ? '전송 실패 · 눌러서 다시' : m.pending ? '보내는 중' : fmtTime.format(d);
        row.appendChild(t);
      }
      if (m.failed) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => retry(m));
      }
      li.appendChild(row);
      frag.appendChild(li);
    });

    list.replaceChildren(frag);
    renderOlderHint();

    if (scroll === 'bottom') box.scrollTop = box.scrollHeight;
    else if (scroll === 'keep') box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
    else box.scrollTop = prevTop;
    if (nearBottom()) markSeen();

    // 화면이 덜 찼으면 이전 것을 더 불러옴
    if (!noMoreOlder && box.scrollHeight <= box.clientHeight + 40) loadOlder();
  }

  function renderOlderHint() {
    $('older').textContent = !msgs.length ? '' : noMoreOlder ? '여기가 처음이에요' : '';
  }

  $('messages').addEventListener('scroll', () => {
    if ($('messages').scrollTop < 80) loadOlder();
    if (nearBottom()) markSeen();
  }, { passive: true });

  // ---------- 안 읽은 메시지 (이 기기 기준) ----------
  function markSeen() {
    const newest = [...msgs].reverse().find((m) => typeof m.id === 'number');
    if (newest && newest.id > lastSeen) {
      lastSeen = newest.id;
      store.set('fh-seen-' + me.id, String(lastSeen));
      updateBadge();
    }
  }

  function updateBadge() {
    if (!me) return;
    const unread = msgs.filter((m) => typeof m.id === 'number' && m.id > lastSeen && m.from_member !== me.id);
    const badge = $('chat-badge');
    badge.hidden = !unread.length;
    badge.textContent = unread.length >= PAGE ? PAGE + '+' : String(unread.length);
    const last = [...msgs].reverse().find((m) => typeof m.id === 'number');
    $('chat-preview').textContent = last
      ? (last.from_member === me.id ? '나' : nameOf(last.from_member)) + ': ' + last.body.replace(/\s+/g, ' ')
      : '우리 가족 대화방';
  }

  // ---------- 가족 홈 메뉴 ----------
  // 부모는 모두, 아이는 학년에 맞는 학습 메뉴만 (초1~6 → 초등학습, 중1~3(7~9) → 중등학습)
  function menuFor(m) {
    if (showAll || m.role === 'parent' || !m.grade) return ['dinner', 'harunote', 'nuneul', 'chat'];
    return ['dinner', m.grade <= 6 ? 'harunote' : 'nuneul', 'chat'];
  }

  function setupTiles() {
    const urls = cfg.apps || {};
    const visible = menuFor(me);
    document.querySelectorAll('.tile').forEach((t) => {
      const app = t.dataset.app;
      t.hidden = !visible.includes(app);
      if (app === 'chat') return;
      const url = urls[app];
      t.classList.toggle('soon', !url);
      const desc = t.querySelector('.tile-desc');
      desc.dataset.text = desc.dataset.text || desc.textContent;
      desc.textContent = url ? desc.dataset.text : '준비 중';
      if (url) { t.href = url; t.removeAttribute('aria-disabled'); }
      else { t.href = '#'; t.setAttribute('aria-disabled', 'true'); }
    });
    $('show-all-btn').hidden = me.role === 'parent' || !me.grade;
    $('show-all-btn').textContent = showAll ? '내 메뉴만 보기' : '모든 메뉴 보기';
  }

  document.querySelectorAll('.tile').forEach((t) => {
    t.addEventListener('click', (e) => { if (t.classList.contains('soon')) e.preventDefault(); });
  });

  $('show-all-btn').addEventListener('click', () => {
    showAll = !showAll;
    store.set('fh-all-' + me.id, showAll ? '1' : '0');
    $('menu').hidden = true;
    setupTiles();
  });

  // ---------- 화면 이동 (#chat ↔ 홈, 휴대폰 뒤로가기 지원) ----------
  function route() {
    if (!me) return;
    if (location.hash === '#chat') {
      show('chat');
      if (chatDirty) render('bottom');
      else markSeen();
      if (!isTouch) input.focus();
    } else {
      show('home');
    }
  }
  let openedFromHome = false;
  window.addEventListener('hashchange', route);
  document.querySelector('.tile[data-app="chat"]').addEventListener('click', () => { openedFromHome = true; });
  $('back-btn').addEventListener('click', () => {
    if (openedFromHome) { openedFromHome = false; history.back(); }   // 홈에서 들어왔으면 뒤로
    else { history.replaceState(null, '', location.pathname); route(); }   // 주소로 바로 들어왔으면 홈으로
  });

  // ---------- 보내기 ----------
  const input = $('msg-input');

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    $('send-btn').disabled = !input.value.trim();
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // 컴퓨터: Enter로 보내기, Shift+Enter 줄바꿈 (한글 조합 중에는 보내지 않음)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !isTouch) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    autosize();
    if (isTouch) input.focus();
    send({ id: 'tmp-' + (++tmpSeq), from_member: me.id, to_member: null, kind: 'text', body,
      created_at: new Date().toISOString(), pending: true });
  });

  async function send(local) {
    local.pending = true; local.failed = false;
    if (!msgs.includes(local)) msgs.push(local);
    render('bottom');
    const { data, error } = await sb.from('messages')
      .insert({ family_id: me.family_id, from_member: me.id, kind: 'text', body: local.body })
      .select(COLS).single();
    if (error) {
      console.error(error);
      local.pending = false; local.failed = true;
      render('stay');
      return;
    }
    const i = msgs.indexOf(local);
    if (i >= 0) msgs.splice(i, 1);
    addMessages([data], 'new');
  }

  function retry(m) {
    if (!m.failed) return;
    const i = msgs.indexOf(m);
    if (i >= 0) msgs.splice(i, 1);
    msgs.push(m);
    send(m);
  }

  // ---------- 메뉴 ----------
  $('menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('menu').hidden;
    $('menu').hidden = !open;
    $('menu-btn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!$('menu').contains(e.target)) { $('menu').hidden = true; $('menu-btn').setAttribute('aria-expanded', 'false'); }
  });

  $('logout-btn').addEventListener('click', async () => {
    $('menu').hidden = true;
    if (isAnon) {
      if (!confirm('이 폰의 가족방 연결을 끊을까요?\n다시 들어오려면 부모님이 새 연결 코드를 만들어 줘야 해요.')) return;
      await sb.rpc('leave_family');   // 이 앱의 연결만 끊음 (오늘저녁 연결은 그대로)
    }
    await signOut();
  });
  $('nofamily-logout').addEventListener('click', signOut);

  async function signOut() {
    await sb.auth.signOut();
    resetToLogin();
  }

  function resetToLogin(msg) {
    if (channel) { sb.removeChannel(channel); channel = null; }
    me = null; msgs = []; ids = new Set(); members = new Map(); failed = false;
    $('msg-list').replaceChildren();
    $('chat-badge').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname);
    show('login');
    if (msg) alert(msg);
  }

  // ---------- 로그인 화면 ----------
  document.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', () => show(b.dataset.go));
  });

  function busy(form, on) {
    form.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
  }

  let pendingEmail = '';

  $('form-email').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $('email-error').textContent = '';
    const email = $('email').value.trim();
    busy(form, true);
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    busy(form, false);
    if (error) {
      $('email-error').textContent = /signup|not allowed|not found/i.test(error.message)
        ? '이 이메일로 만든 가족 계정이 없어요. 오늘저녁 앱에서 쓰던 이메일인지 확인해 주세요.'
        : /rate|seconds/i.test(error.message)
          ? '잠시 뒤에 다시 시도해 주세요. (메일은 1분에 한 번만 보낼 수 있어요)'
          : '메일을 보내지 못했어요: ' + error.message;
      return;
    }
    pendingEmail = email;
    $('otp-help').textContent = email + ' 로 보낸 메일의 숫자 코드를 넣어 주세요. 메일 속 링크를 눌러도 들어올 수 있어요.';
    $('form-email').hidden = true;
    $('form-otp').hidden = false;
    $('otp').focus();
  });

  $('otp-back').addEventListener('click', () => {
    $('form-otp').hidden = true;
    $('form-email').hidden = false;
  });

  $('form-otp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $('otp-error').textContent = '';
    busy(form, true);
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: $('otp').value.trim(), type: 'email' });
    busy(form, false);
    if (error) { $('otp-error').textContent = '코드가 맞지 않거나 시간이 지났어요.'; return; }
    $('otp').value = '';
    $('form-otp').hidden = true;
    $('form-email').hidden = false;
    await enter();
  });

  $('form-link').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $('link-error').textContent = '';
    const code = $('link-code').value.trim();
    busy(form, true);
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) throw new Error('아이 폰 로그인을 시작하지 못했어요. (' + error.message + ')');
      }
      const { error } = await sb.rpc('link_extra_app', { c: code });
      if (error) throw new Error(error.message);
      $('link-code').value = '';
      await enter();
    } catch (err) {
      $('link-error').textContent = err.message;
    } finally {
      busy(form, false);
    }
  });

  // 카카오톡·네이버 같은 앱 안에서 열면 로그인이 따로 저장되어 자주 풀려 보임 → 안내
  if (/KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent)) $('inapp-tip').hidden = false;

  start();
})();
