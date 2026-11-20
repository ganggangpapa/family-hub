// 가족방 1단계: 로그인 + 텍스트 채팅 + 실시간 + 이전 메시지
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
    $('screen-loading').querySelector('p').textContent =
      '설정이 아직 비어 있어요. config.js에 Supabase 주소와 공개 키를 넣어 주세요.';
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

  // ---------- 시작 ----------
  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { show('login'); return; }
    await enter();
  }

  sb.auth.onAuthStateChange((event) => {
    // 메일의 로그인 링크를 눌러 들어온 경우
    // (이 콜백 안에서 바로 서버를 부르면 멈출 수 있어 한 박자 뒤에 실행)
    if (event === 'SIGNED_IN' && !me && !entering && !$('screen-loading').hidden) setTimeout(enter, 0);
  });

  async function enter() {
    if (entering) return;
    entering = true;
    try {
      show('loading');
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { show('login'); return; }
      isAnon = !!user.is_anonymous;

      const { data: m, error } = await sb.rpc('my_member');
      if (error) throw error;
      if (!m || !m.id) { show(isAnon ? 'child' : 'nofamily'); return; }
      me = m;

      const [{ data: fam }] = await Promise.all([
        sb.from('families').select('id,name').maybeSingle(),
        loadMembers(),
      ]);
      $('family-name').textContent = fam ? fam.name : '가족방';
      document.title = (fam ? fam.name + ' ' : '') + '가족방';
      $('menu-me').textContent = '나: ' + (me.nickname || '') + (me.role === 'parent' ? ' (부모)' : '');
      $('logout-btn').textContent = isAnon ? '이 폰 연결 끊기' : '로그아웃';

      show('chat');
      msgs = []; ids = new Set(); noMoreOlder = false;
      const first = await fetchPage(null);
      addMessages(first, 'initial');
      subscribe();
    } catch (e) {
      console.error(e);
      show('login');
      alert('가족방을 열지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.\n(' + (e.message || e) + ')');
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

    // 화면이 덜 찼으면 이전 것을 더 불러옴
    if (!noMoreOlder && box.scrollHeight <= box.clientHeight + 40) loadOlder();
  }

  function renderOlderHint() {
    $('older').textContent = !msgs.length ? '' : noMoreOlder ? '여기가 처음이에요' : '';
  }

  $('messages').addEventListener('scroll', () => {
    if ($('messages').scrollTop < 80) loadOlder();
  }, { passive: true });

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
    if (channel) { sb.removeChannel(channel); channel = null; }
    await sb.auth.signOut();
    me = null; msgs = []; ids = new Set(); members = new Map();
    $('msg-list').replaceChildren();
    show('login');
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

  start();
})();
