// 가족 홈: 메뉴(오늘저녁 · 초등학습 · 중등학습 · 가족채팅) + 가족채팅(실시간, 이전 메시지, 앱 카드) + 앱 설치 안내
// 서버 규칙(RLS)은 family-hub/supabase/schema.sql 에 있습니다.
(() => {
  'use strict';

  const cfg = window.FAMILY_CHAT_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const PAGE = 50;
  const KIND_LABEL = { cheer: '응원', sticker: '칭찬 스티커', show: '보여 주기', meal_request: '먹고 싶어요' };
  const CARD_KINDS = ['dinner_vote', 'notice', 'study_done'];   // 앱이 저절로 올리는 카드 (서버 트리거가 만듦)
  const APP_LABEL = { dinner: '🍚 오늘저녁', harunote: '✏️ 하루노트', nuneul: '📘 중학노트' };
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
  let polls = new Map();      // 저녁 투표 id → { options, closed_at, votes: Map(구성원 → 고른 번호) }

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
      const hasPassword = !!(user.user_metadata && user.user_metadata.has_password);

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
      $('password-btn').hidden = isAnon;
      $('password-btn').textContent = hasPassword ? '비밀번호 바꾸기' : '비밀번호 정하기';
      $('pw-tip').hidden = isAnon || hasPassword;
      lastSeen = Number(store.get('fh-seen-' + me.id)) || 0;
      showAll = store.get('fh-all-' + me.id) === '1';
      setupTiles();
      $('install-tip').hidden = installTipHidden();

      msgs = []; ids = new Set(); noMoreOlder = false; chatDirty = true; polls = new Map();
      $('poll-open').hidden = me.role !== 'parent';
      route();
      loadWeekly();
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
    const { data, error } = await sb.from('members').select('id,nickname,role,grade');
    if (error) throw error;
    members = new Map(data.map((r) => [r.id, r]));
  }

  // ---------- 메시지 불러오기 ----------
  const COLS = 'id,from_member,to_member,kind,body,created_at,source_app,payload';

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
      // 투표 카드: 누가 투표하거나 마감하면 바로 숫자 바꾸기
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'meal_votes', filter: 'family_id=eq.' + me.family_id },
        (p) => { const id = (p.new && p.new.poll_id) || (p.old && p.old.poll_id); if (id) loadPolls([id], true); })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'meal_polls', filter: 'family_id=eq.' + me.family_id },
        (p) => { if (p.new && p.new.id) loadPolls([p.new.id], true); })
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
    const pollIds = fresh.filter((r) => r.kind === 'dinner_vote' && r.payload && r.payload.poll_id).map((r) => r.payload.poll_id);
    if (pollIds.length) await loadPolls(pollIds, false);

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

      if (CARD_KINDS.includes(m.kind)) { frag.appendChild(renderCard(m, d)); return; }

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

  // ---------- 앱 카드 (투표 · 공지 · 학습 완료) ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const optText = (o) => (typeof o === 'string' ? o : (o && (o.name || o.label || o.title)) || String(o));

  function renderCard(m, d) {
    const li = el('li', 'card-msg ' + m.kind);
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'card-app', APP_LABEL[m.source_app] || '알림'));
    head.appendChild(el('time', 'time', fmtTime.format(d)));
    li.appendChild(head);

    if (m.kind === 'dinner_vote') {
      li.appendChild(el('p', 'card-title', m.body));
      li.appendChild(el('p', 'card-sub', nameOf(m.from_member) + '님이 올렸어요'));
      const poll = polls.get(m.payload && m.payload.poll_id);
      if (!poll) { li.appendChild(el('p', 'card-sub', '투표를 불러오는 중…')); return li; }
      const counts = poll.options.map(() => []);
      poll.votes.forEach((choice, who) => { if (counts[choice]) counts[choice].push(nameOf(who)); });
      const total = poll.votes.size;
      const top = Math.max(0, ...counts.map((c) => c.length));
      const myChoice = poll.votes.get(me.id);
      const closed = !!poll.closed_at;
      const list = el('div', 'vote-list');
      poll.options.forEach((o, i) => {
        const b = el('button', 'vote-opt');
        b.type = 'button';
        b.disabled = closed || poll.busy;
        if (myChoice === i) b.classList.add('chosen');
        if (closed && top > 0 && counts[i].length === top) b.classList.add('win');
        b.setAttribute('aria-pressed', String(myChoice === i));
        const bar = el('span', 'vote-bar');
        bar.style.width = (total ? Math.round(counts[i].length / total * 100) : 0) + '%';
        b.appendChild(bar);
        b.appendChild(el('span', 'vote-name', (myChoice === i ? '✓ ' : '') + optText(o)));
        b.appendChild(el('span', 'vote-count', counts[i].length + '표'));
        if (counts[i].length) b.appendChild(el('span', 'vote-who', counts[i].join(', ')));
        b.addEventListener('click', () => castVote(m.payload.poll_id, i));
        list.appendChild(b);
      });
      li.appendChild(list);
      const foot = el('div', 'card-foot');
      foot.appendChild(el('span', 'card-sub', closed ? '마감됐어요 · ' + total + '명 투표' : total + '명 투표 · 다시 누르면 바꿀 수 있어요'));
      if (!closed && me.role === 'parent') {
        const c = el('button', 'btn small-btn', '투표 마감');
        c.type = 'button';
        c.disabled = !!poll.busy;
        c.addEventListener('click', () => closePoll(m.payload.poll_id));
        foot.appendChild(c);
      }
      li.appendChild(foot);
      if (poll.error) li.appendChild(el('p', 'error', poll.error));
    } else if (m.kind === 'notice') {
      li.appendChild(el('p', 'card-title', '📢 ' + m.body));
    } else if (m.kind === 'study_done') {
      li.appendChild(el('p', 'card-title', m.body));
      if (m.from_member !== me.id) {
        const sent = msgs.some((x) => x.kind === 'cheer' && x.from_member === me.id && x.to_member === m.from_member
          && new Date(x.created_at) >= d);
        const b = el('button', 'btn small-btn', sent ? '👏 응원했어요' : '👏 응원하기');
        b.type = 'button';
        b.disabled = sent;
        b.addEventListener('click', () => send({ id: 'tmp-' + (++tmpSeq), from_member: me.id, to_member: m.from_member,
          kind: 'cheer', body: '👏 잘했어! 오늘도 수고했어', created_at: new Date().toISOString(), pending: true }));
        const foot = el('div', 'card-foot');
        foot.appendChild(b);
        li.appendChild(foot);
      }
    }
    return li;
  }

  function loadPolls(idList, redraw) {
    return fetchPolls(idList, redraw).catch((e) => console.error(e));   // 실패하면 카드만 예전 숫자로 남음
  }
  async function fetchPolls(idList, redraw) {
    const want = [...new Set(idList)];
    if (!want.length) return;
    const [{ data: ps, error: e1 }, { data: vs, error: e2 }] = await Promise.all([
      sb.from('meal_polls').select('id,options,closed_at').in('id', want),
      sb.from('meal_votes').select('poll_id,member_id,choice').in('poll_id', want),
    ]);
    if (e1 || e2) { console.error(e1 || e2); return; }
    ps.forEach((p) => {
      const old = polls.get(p.id);
      polls.set(p.id, { options: Array.isArray(p.options) ? p.options : [], closed_at: p.closed_at,
        votes: new Map(vs.filter((v) => v.poll_id === p.id).map((v) => [v.member_id, v.choice])),
        busy: old ? old.busy : false });
    });
    if (redraw) render('stay');
  }

  async function castVote(pollId, choice) {
    const poll = polls.get(pollId);
    if (!poll || poll.closed_at || poll.busy || poll.votes.get(me.id) === choice) return;
    const before = poll.votes.get(me.id);
    poll.votes.set(me.id, choice);   // 바로 보이게 먼저 바꿈
    poll.error = '';
    render('stay');
    const { error } = await sb.from('meal_votes')
      .upsert({ poll_id: pollId, member_id: me.id, family_id: me.family_id, choice }, { onConflict: 'poll_id,member_id' });
    if (error) {
      console.error(error);
      if (before === undefined) poll.votes.delete(me.id); else poll.votes.set(me.id, before);
      poll.error = '투표하지 못했어요. 이미 마감됐거나 인터넷이 끊겼어요.';
    }
    await loadPolls([pollId], true);
  }

  async function closePoll(pollId) {
    const poll = polls.get(pollId);
    if (!poll || !confirm('투표를 마감하고 결과를 알릴까요?')) return;
    poll.busy = true; poll.error = '';
    render('stay');
    const { error } = await sb.from('meal_polls').update({ closed_at: new Date().toISOString() }).eq('id', pollId);
    poll.busy = false;
    if (error) { console.error(error); poll.error = '마감하지 못했어요: ' + error.message; }
    await loadPolls([pollId], true);
  }

  // ---------- 저녁 투표 만들기 (부모) ----------
  const localDay = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');

  function pollInputs() { return [...document.querySelectorAll('#poll-options input')]; }
  function addPollInput(v) {
    const n = pollInputs().length;
    if (n >= 5) return;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.maxLength = 30; inp.value = v || '';
    inp.placeholder = '메뉴 ' + (n + 1) + (n < 2 ? '' : ' (안 써도 돼요)');
    inp.setAttribute('aria-label', '메뉴 ' + (n + 1));
    $('poll-options').appendChild(inp);
    $('poll-add').hidden = n + 1 >= 5;
  }
  $('poll-open').addEventListener('click', () => {
    $('poll-options').textContent = '';
    $('poll-error').textContent = '';
    for (let i = 0; i < 3; i++) addPollInput();
    $('poll-form').hidden = false;
    $('composer').hidden = true;
    pollInputs()[0].focus();
  });
  $('poll-add').addEventListener('click', () => { addPollInput(); pollInputs().slice(-1)[0].focus(); });
  $('poll-cancel').addEventListener('click', () => { $('poll-form').hidden = true; $('composer').hidden = false; });
  $('poll-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const opts = [...new Set(pollInputs().map((i) => i.value.trim()).filter(Boolean))];
    if (opts.length < 2) { $('poll-error').textContent = '메뉴를 2개 이상 써 주세요.'; return; }
    busy(form, true);
    const { error } = await sb.from('meal_polls')
      .insert({ family_id: me.family_id, day: localDay(new Date()), created_by: me.id, options: opts });
    busy(form, false);
    if (error) { console.error(error); $('poll-error').textContent = '투표를 만들지 못했어요: ' + error.message; return; }
    $('poll-form').hidden = true;
    $('composer').hidden = false;
    catchUp();   // 서버가 만든 투표 카드를 바로 가져옴
  });

  // ---------- 이번 주 학습 (부모에게만) ----------
  function loadWeekly() {
    drawWeekly().catch((e) => { console.error(e); $('weekly').hidden = true; });   // 실패해도 홈은 그대로
  }
  async function drawWeekly() {
    const box = $('weekly');
    box.hidden = true;
    if (!me || me.role !== 'parent') return;
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const { data, error } = await sb.from('study_daily')
      .select('member_id,app,day,solved,correct,practice')
      .gte('day', localDay(monday));
    if (error || !data || !data.length) return;
    const by = new Map();
    data.forEach((r) => {
      const k = r.member_id + '|' + r.app;
      const g = by.get(k) || { member: r.member_id, app: r.app, days: new Set(), solved: 0, correct: 0, practice: new Set() };
      g.days.add(r.day); g.solved += r.solved || 0; g.correct += r.correct || 0;
      (Array.isArray(r.practice) ? r.practice : []).forEach((p) => typeof p === 'string' && g.practice.add(p));
      by.set(k, g);
    });
    const list = $('weekly-list');
    list.textContent = '';
    [...by.values()].sort((a, b) => nameOf(a.member).localeCompare(nameOf(b.member), 'ko')).forEach((g) => {
      const li = el('li', 'weekly-item');
      li.appendChild(el('span', 'weekly-name', nameOf(g.member) + ' · ' + (APP_LABEL[g.app] || g.app)));
      const pct = g.solved ? Math.round(g.correct / g.solved * 100) : 0;
      li.appendChild(el('span', 'weekly-stat', g.days.size + '일 공부 · ' + g.solved + '문제 · 정답 ' + pct + '%'));
      if (g.practice.size) li.appendChild(el('span', 'weekly-practice', '더 연습: ' + [...g.practice].slice(0, 3).join(', ')));
      list.appendChild(li);
    });
    box.hidden = false;
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

  // ---------- 앱 설치하기 ----------
  // 다른 주소의 앱은 웹페이지가 대신 설치해 줄 수 없어서, 고른 앱을 열고 "홈 화면에 추가" 방법을 안내합니다.
  const APPS = {
    home:     { icon: '🏠', name: '가족 홈', desc: '지금 이 앱' },
    dinner:   { icon: '🍚', name: '오늘저녁', desc: '메뉴 추천 · 저녁 투표' },
    harunote: { icon: '✏️', name: '하루노트', desc: '초등학습 · 오늘의 10문제' },
    nuneul:   { icon: '📘', name: '중학노트', desc: '중등학습 · 중학 공부' },
  };
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installPrompt = null;   // 안드로이드 크롬: 가족 홈 자체를 바로 설치하는 창
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { store.set('fh-installed-home', '1'); installPrompt = null; if (location.hash === '#install') renderInstall(); });

  function installTipHidden() {
    return store.get('fh-install-tip-off') === '1' || !Object.keys(APPS).some((k) => installable(k) && !isInstalled(k));
  }
  function installable(k) {
    if (k === 'home') return !isStandalone();
    return menuFor(me).includes(k);
  }
  function isInstalled(k) {
    if (k === 'home' && isStandalone()) return true;
    return store.get('fh-installed-' + k) === '1';
  }

  function guideSteps(k, url) {
    const name = APPS[k].name;
    if (k === 'home') {
      if (isIOS) return ['아래쪽(또는 위쪽) <b>공유 버튼(□↑)</b>을 눌러요.', '<b>홈 화면에 추가</b> → <b>추가</b>를 눌러요.'];
      if (isAndroid) return ['오른쪽 위 <b>⋮</b>를 눌러요.', '<b>홈 화면에 추가</b>(또는 <b>앱 설치</b>)를 눌러요.'];
      return ['주소창 오른쪽의 <b>설치 아이콘</b>이나 브라우저 메뉴에서 <b>앱 설치</b>를 눌러요.'];
    }
    const out = [];
    if (isIOS) {
      if (isStandalone()) out.push('<b>주소 복사</b>를 누르고 <b>Safari</b>를 열어 주소창에 붙여 넣어요.');
      else out.push('<b>' + name + ' 열기</b>를 눌러요. Safari 새 탭에서 열려요.');
      out.push('아래쪽(또는 위쪽) <b>공유 버튼(□↑)</b> → <b>홈 화면에 추가</b> → <b>추가</b>.');
    } else if (isAndroid) {
      out.push('<b>' + name + ' 열기</b>를 눌러요.');
      if (isStandalone()) out.push('열린 화면에서 <b>⋮ → Chrome에서 열기</b>를 눌러요.');
      out.push('오른쪽 위 <b>⋮ → 홈 화면에 추가</b>(또는 <b>앱 설치</b>).');
    } else {
      out.push('<b>' + name + ' 열기</b>를 눌러요.');
      out.push('핸드폰이라면 브라우저 메뉴에서 <b>홈 화면에 추가</b>를 눌러요.');
    }
    out.push('처음 열 때 한 번 로그인해요.');
    return out;
  }

  let openGuide = null;       // 안내를 펼친 앱
  function renderInstall() {
    const list = $('install-list');
    list.textContent = '';
    const urls = cfg.apps || {};
    Object.keys(APPS).filter(installable).forEach((k) => {
      const a = APPS[k];
      const url = k === 'home' ? location.origin + location.pathname : urls[k];
      const done = isInstalled(k);
      const li = document.createElement('li');
      li.className = 'install-item' + (url ? '' : ' soon');
      li.dataset.app = k;
      li.innerHTML = '<div class="install-head"><span class="tile-icon" aria-hidden="true"></span>'
        + '<span class="install-name"><span class="tile-name"></span><span class="tile-desc"></span></span>'
        + '<button class="btn" type="button"></button></div>';
      li.querySelector('.tile-icon').textContent = a.icon;
      li.querySelector('.tile-name').textContent = a.name;
      li.querySelector('.tile-desc').textContent = url ? a.desc : '준비 중 (주소가 아직 없어요)';
      const btn = li.querySelector('button');
      btn.textContent = !url ? '준비 중' : done ? '✓ 설치함' : openGuide === k ? '닫기' : '설치';
      btn.disabled = !url;
      if (done) btn.classList.add('done'); else if (url) btn.classList.add('primary');
      btn.setAttribute('aria-expanded', String(openGuide === k));
      btn.addEventListener('click', () => {
        if (k === 'home' && installPrompt && !done) {   // 안드로이드: 바로 설치 창
          const p = installPrompt; installPrompt = null;
          p.prompt();
          p.userChoice.then((c) => { if (c.outcome === 'accepted') store.set('fh-installed-home', '1'); renderInstall(); });
          return;
        }
        openGuide = openGuide === k ? null : k;
        renderInstall();
      });
      if (url && openGuide === k) li.appendChild(guideBox(k, url, done));
      list.appendChild(li);
    });
  }

  function guideBox(k, url, done) {
    const box = document.createElement('div');
    box.className = 'guide';
    const ol = document.createElement('ol');
    ol.className = 'steps';
    guideSteps(k, url).forEach((h) => { const li = document.createElement('li'); li.innerHTML = h; ol.appendChild(li); });
    box.appendChild(ol);
    const row = document.createElement('div');
    row.className = 'btn-row';
    if (k !== 'home') {
      const open = document.createElement('a');
      open.className = 'btn primary';
      open.href = url; open.target = '_blank'; open.rel = 'noopener';
      open.textContent = APPS[k].name + ' 열기';
      row.appendChild(open);
      const copy = document.createElement('button');
      copy.className = 'btn'; copy.type = 'button'; copy.textContent = '주소 복사';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); copy.textContent = '복사했어요 ✓'; }
        catch (e) { prompt('이 주소를 길게 눌러 복사하세요', url); }
      });
      row.appendChild(copy);
    }
    const mark = document.createElement('button');
    mark.className = 'btn'; mark.type = 'button';
    mark.textContent = done ? '설치 표시 지우기' : '설치했어요 ✓';
    mark.addEventListener('click', () => {
      store.set('fh-installed-' + k, done ? '0' : '1');
      openGuide = null;
      renderInstall();
    });
    row.appendChild(mark);
    box.appendChild(row);
    return box;
  }

  let installFromHome = false;
  function openInstall() {
    $('menu').hidden = true;
    installFromHome = true;
    location.hash = '#install';
  }
  $('install-btn').addEventListener('click', openInstall);
  $('install-tip-btn').addEventListener('click', openInstall);
  $('install-tip-close').addEventListener('click', () => { store.set('fh-install-tip-off', '1'); $('install-tip').hidden = true; });
  $('install-back').addEventListener('click', () => {
    if (installFromHome) { installFromHome = false; history.back(); }
    else { history.replaceState(null, '', location.pathname); route(); }
  });

  // ---------- 화면 이동 (#chat · #install ↔ 홈, 휴대폰 뒤로가기 지원) ----------
  function route() {
    if (!me) return;
    if (location.hash === '#install') {
      openGuide = null;
      renderInstall();
      show('install');
    } else if (location.hash === '#chat') {
      show('chat');
      if (chatDirty) render('bottom');
      else markSeen();
      if (!isTouch) input.focus();
    } else {
      $('install-tip').hidden = installTipHidden();
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
      .insert({ family_id: me.family_id, from_member: me.id, to_member: local.to_member || null, kind: local.kind || 'text', body: local.body })
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

  // 이메일 + 비밀번호 로그인 (홈 화면 아이콘 안에서도 바로 됨)
  $('form-email').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    $('email-error').textContent = '';
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!password) {
      $('email-error').textContent = '비밀번호를 넣어 주세요. 아직 없다면 아래 "메일로 로그인 링크 받기"를 눌러 주세요.';
      return;
    }
    busy(form, true);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    busy(form, false);
    if (error) {
      $('email-error').textContent = /invalid|credentials/i.test(error.message)
        ? '이메일이나 비밀번호가 맞지 않아요. 비밀번호를 정한 적이 없다면 아래 "메일로 로그인 링크 받기"를 눌러 주세요.'
        : '로그인하지 못했어요: ' + error.message;
      return;
    }
    $('password').value = '';
    await enter();
  });

  // 메일로 로그인 링크 받기 (비밀번호가 없을 때)
  $('magic-btn').addEventListener('click', async () => {
    const form = $('form-email');
    $('email-error').textContent = '';
    if (!$('email').reportValidity()) return;
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
    $('otp-help').textContent = email + ' 로 로그인 메일을 보냈어요.';
    $('form-email').hidden = true;
    $('form-otp').hidden = false;
  });

  // ---------- 비밀번호 정하기 ----------
  function openPassword() {
    $('menu').hidden = true;
    $('password-error').textContent = '';
    show('password');
    $('new-password').focus();
  }
  $('password-btn').addEventListener('click', openPassword);
  $('pw-tip-btn').addEventListener('click', openPassword);
  $('password-cancel').addEventListener('click', () => route());

  $('form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const pw = $('new-password').value;
    $('password-error').textContent = '';
    if (pw.length < 8) { $('password-error').textContent = '8자 이상으로 정해 주세요.'; return; }
    if (pw !== $('new-password2').value) { $('password-error').textContent = '두 비밀번호가 달라요.'; return; }
    busy(form, true);
    const { error } = await sb.auth.updateUser({ password: pw, data: { has_password: true } });
    busy(form, false);
    if (error) {
      $('password-error').textContent = /different/i.test(error.message) ? '지금 비밀번호와 같아요. 다른 걸로 정해 주세요.'
        : /reauth/i.test(error.message) ? '보안을 위해 메일 링크로 다시 로그인한 뒤 바로 정해 주세요.'
        : /weak|short|characters/i.test(error.message) ? '더 길거나 어려운 비밀번호로 정해 주세요.'
        : '저장하지 못했어요: ' + error.message;
      return;
    }
    $('new-password').value = ''; $('new-password2').value = '';
    $('pw-tip').hidden = true;
    $('password-btn').textContent = '비밀번호 바꾸기';
    alert('비밀번호를 정했어요. 이제 홈 화면 아이콘에서 이메일 + 비밀번호로 로그인하세요.');
    route();
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
