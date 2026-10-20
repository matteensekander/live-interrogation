/* Live Interrogation client. The server is the source of truth: this file only renders
 * what the server sends and forwards player actions. */
(function () {
  'use strict';

  const W = 1600;
  const H = 900;
  const SESSION_KEY = 'li.session';
  const PHASE_LABEL = {
    briefing: 'CASE BRIEFING',
    roles: 'ROLES DEALT',
    interrogation: 'INTERROGATION',
    deliberation: 'DELIBERATION',
    vote: 'SECRET VOTE',
    reveal: 'VERDICT',
    scoreboard: 'SCOREBOARD',
    final: 'CASE CLOSED',
    lobby: 'LOBBY',
  };
  const ICONS = ['🤨', '✅'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const S = {
    meta: null,
    pub: null,
    priv: null,
    session: null,
    offset: 0,
    phaseStart: 0,
    lastPhase: null,
    lastFeedLen: 0,
    lastTick: null,
    overlayKey: null,
    overlayDismissed: null,
    overlayTimers: [],
    inputKey: null,
    followUpOf: null,
    myVote: null,
    typingSent: false,
    typingTimer: null,
    typeTimer: null,
    lobbyFocusSaved: false,
    rainReady: false,
  };

  let socket = null;

  // ---------- session ----------
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_e) { return null; }
  }
  function saveSession(s) {
    S.session = s;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }
  function clearSession() {
    S.session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_e) { /* ignore */ }
  }

  // ---------- helpers ----------
  const now = () => Date.now() + S.offset;
  const me = () => (S.pub && S.priv ? S.priv.you : {});
  const playerById = (id) => (S.pub ? S.pub.players.find((p) => p.id === id) : null);
  const nameOf = (id) => {
    const p = playerById(id);
    return p ? p.nickname : '???';
  };
  const avatarSrc = (id) => `/avatars/${id}.svg`;
  const amSuspect = () => Boolean(me().isSuspect);
  const amDetective = () => Boolean(S.pub && S.priv && !me().isSuspect && S.pub.phase !== 'lobby');

  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text;
    t.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.add('hidden'), 2800);
  }

  function act(event, data, onOk) {
    socket.emit(event, data || {}, (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || 'Something went wrong.', true);
        return;
      }
      if (onOk) onOk(res);
    });
  }

  function showScreen(name) {
    $('screen-landing').classList.toggle('hidden', name !== 'landing');
    $('screen-lobby').classList.toggle('hidden', name !== 'lobby');
    $('screen-game').classList.toggle('hidden', name !== 'game');
  }

  // ---------- stage scaling: 1600x900 design, scales to any window ----------
  function fit() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    const st = $('stage');
    st.style.transform = `scale(${s})`;
    st.style.left = `${(window.innerWidth - W * s) / 2}px`;
    st.style.top = `${(window.innerHeight - H * s) / 2}px`;
  }

  // ---------- socket wiring ----------
  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      const sess = S.session;
      if (sess && sess.code && sess.token) {
        socket.emit('room:join', { code: sess.code, nickname: sess.nickname, token: sess.token }, (res) => {
          if (res && res.ok) {
            saveSession({ ...sess, token: res.token, playerId: res.playerId });
            toast('Reconnected.');
          } else {
            clearSession();
            S.pub = null;
            S.priv = null;
            showLanding(res && res.error ? res.error : 'Could not rejoin the room.');
          }
        });
      } else {
        showLanding();
      }
    });

    socket.on('disconnect', () => {
      if (S.pub) toast('Connection lost. Reconnecting...', true);
    });

    socket.on('state', (pub) => {
      S.offset = pub.serverNow - Date.now();
      const changed = !S.pub || S.pub.phase !== pub.phase || S.pub.round?.number !== pub.round?.number;
      if (changed) S.phaseStart = pub.serverNow;
      S.pub = pub;
      render(changed);
    });

    socket.on('private', (priv) => {
      S.priv = priv;
      if (priv && !priv.you.hasVoted && S.pub && S.pub.phase !== 'vote') S.myVote = null;
      render(false);
    });
  }

  function showLanding(error) {
    S.pub = null;
    S.priv = null;
    showScreen('landing');
    $('landing-error').textContent = error || '';
    Sound.startAmbient();
  }

  // ---------- render dispatcher ----------
  function render(phaseChanged) {
    const p = S.pub;
    if (!p) return showLanding();
    if (p.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
      Sound.startAmbient();
    } else {
      showScreen('game');
      Sound.stopAmbient();
      renderGame(phaseChanged);
    }
    renderOverlay();
  }

  // ---------- lobby ----------
  function buildLookPickers() {
    const av = $('avatar-grid');
    av.innerHTML = S.meta.avatars.map((a) => `
      <button class="avatar-opt" data-avatar="${a.id}" title="${esc(a.name)}">
        <img src="${avatarSrc(a.id)}" alt="">${esc(a.name)}
      </button>`).join('');
    av.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => act('room:pick', { avatar: b.dataset.avatar }));
    });
    const cg = $('color-grid');
    cg.innerHTML = S.meta.colors.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('');
    cg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => act('room:pick', { color: b.dataset.color }));
    });
  }

  function renderLobby() {
    const p = S.pub;
    const mine = p.players.find((x) => x.id === S.session?.playerId);
    const isHost = p.hostId === S.session?.playerId;
    $('lobby-code').textContent = p.code;
    $('join-url').textContent = `${location.host}/?code=${p.code}`;

    const grid = $('lobby-players');
    const cards = p.players.map((pl) => `
      <div class="player-card${pl.connected ? '' : ' offline'}" style="--c:${pl.color}">
        <img src="${avatarSrc(pl.avatar)}" alt="">
        <div>
          <div class="pname">${esc(pl.nickname)} ${pl.isHost ? '<span class="crown" title="Host">♛</span>' : ''}</div>
          <div class="ptag">${pl.id === S.session?.playerId ? 'YOU · ' : ''}${pl.connected ? 'READY' : 'OFFLINE'}</div>
        </div>
      </div>`);
    for (let i = p.players.length; i < p.maxPlayers; i++) {
      cards.push('<div class="player-card empty"><div>Open seat</div></div>');
    }
    grid.innerHTML = cards.join('');
    $('lobby-count').textContent = `${p.players.length} of ${p.maxPlayers} detectives. Need ${p.minPlayers}+ to start.`;

    // Character and color pickers: mark mine, disable taken ones.
    const takenAv = new Map(p.players.map((x) => [x.avatar, x.id]));
    const takenCol = new Map(p.players.map((x) => [x.color, x.id]));
    $('avatar-grid').querySelectorAll('button').forEach((b) => {
      const holder = takenAv.get(b.dataset.avatar);
      const isMineAv = mine && mine.avatar === b.dataset.avatar;
      b.classList.toggle('mine', Boolean(isMineAv));
      b.disabled = Boolean(holder && holder !== mine?.id);
    });
    $('color-grid').querySelectorAll('button').forEach((b) => {
      const holder = takenCol.get(b.dataset.color);
      const isMineCol = mine && mine.color === b.dataset.color;
      b.classList.toggle('mine', Boolean(isMineCol));
      b.disabled = Boolean(holder && holder !== mine?.id);
    });

    // Settings: host edits, others read-only.
    const s = p.settings;
    const fields = {
      'set-rounds': s.rounds,
      'set-time': String(s.interrogationSecs),
      'set-answer': s.answerSecs,
    };
    Object.entries(fields).forEach(([id, v]) => {
      const input = $(id);
      input.disabled = !isHost;
      if (document.activeElement !== input) input.value = v;
    });
    $('set-accomplice').checked = Boolean(s.accomplice);
    $('set-accomplice').disabled = !isHost;
    $('settings-hint').textContent = isHost
      ? 'You are the host. Changes apply instantly for everyone.'
      : `Waiting for the host to set the case. ${p.players.find((x) => x.isHost)?.nickname || 'The host'} is in charge.`;

    const connected = p.players.filter((x) => x.connected).length;
    const startBtn = $('btn-start');
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = !(isHost && connected >= p.minPlayers);
    $('lobby-hint').textContent = !isHost
      ? 'The host starts the case.'
      : connected >= p.minPlayers
        ? `${connected} detectives ready. The suspect will be picked fairly each round.`
        : `Need ${p.minPlayers - connected} more detective(s) to start.`;
  }

  // ---------- game ----------
  function renderGame(phaseChanged) {
    const p = S.pub;
    const priv = S.priv || { you: {}, suspect: null, evidence: null, chat: null };

    // Top bar
    $('round-badge').textContent = p.round ? `CASE ${p.round.number} / ${p.round.total}` : 'CASE FILE';
    $('phase-label').textContent = PHASE_LABEL[p.phase] || p.phase.toUpperCase();
    const me0 = playerById(S.session?.playerId);
    $('my-badge').innerHTML = me0
      ? `<img src="${avatarSrc(me0.avatar)}" alt=""><div><b>${esc(me0.nickname)}</b> · ${me0.score} pts<br><span class="muted small">${priv.you.isSuspect ? 'SUSPECT' : priv.evidence ? 'DETECTIVE' : ''}${priv.you.isAccomplice ? ' · ACCOMPLICE' : ''}</span></div>`
      : '';

    // Case file
    const cc = p.caseCard;
    $('cf-title').textContent = cc ? cc.title : 'Awaiting case';
    $('cf-crime').textContent = cc ? cc.crime : 'The case file will appear when the next case opens.';
    $('cf-time').textContent = cc ? cc.timeWindow : '-';
    $('cf-where').textContent = cc ? cc.location : '-';

    // Evidence board
    $('board-list').innerHTML = p.board.map((n) => {
      const who = playerById(n.byId);
      return `<div class="note"><div class="by">${who ? `<img src="${avatarSrc(who.avatar)}" alt="">` : ''}pinned by ${esc(who ? who.nickname : '?')}</div>${esc(n.text)}</div>`;
    }).join('') || '<p class="muted small">Detectives can pin a card here to share it with everyone.</p>';

    renderRoom(p, priv);
    renderFeedOrDelib(p, priv, phaseChanged);
    wireFeedButtons(); // the feed is rebuilt on every update, so re-wire its buttons
    renderInputBar(p, priv);
    renderPrivate(p, priv);
  }

  function renderRoom(p, priv) {
    const suspect = p.suspectId ? playerById(p.suspectId) : null;
    const seat = $('suspect-seat');
    seat.classList.toggle('hidden', !suspect);
    if (suspect) {
      $('suspect-img').src = avatarSrc(suspect.avatar);
      $('suspect-img').style.setProperty('--c', suspect.color);
      $('suspect-name').textContent = suspect.nickname + (suspect.id === S.session?.playerId ? ' (you)' : '');
      $('suspect-label').textContent = priv.you.isSuspect ? 'YOU ARE THE SUSPECT' : 'THE SUSPECT';
    }
    $('typing').classList.toggle('hidden', !(p.typing && p.phase === 'interrogation'));

    const rolesBanner = $('roles-banner');
    if (p.phase === 'roles' && suspect) {
      rolesBanner.textContent = priv.you.isSuspect
        ? 'You are the suspect. Hold SPACE to see your card.'
        : `${suspect.nickname} is the suspect. Hold SPACE to see your cards.`;
      rolesBanner.classList.remove('hidden');
    } else {
      rolesBanner.classList.add('hidden');
    }

    const asking = p.current ? p.current.byId : null;
    const voted = new Set(p.votedIds || []);
    $('detective-row').innerHTML = p.players
      .filter((pl) => pl.id !== p.suspectId)
      .map((pl) => `
        <div class="det${pl.id === asking ? ' asking' : ''}${pl.connected ? '' : ' offline'}${voted.has(pl.id) && p.phase === 'vote' ? ' voted' : ''}" style="--c:${pl.color}" title="${esc(pl.nickname)}">
          <img src="${avatarSrc(pl.avatar)}" alt="">
          ${voted.has(pl.id) && p.phase === 'vote' ? '<span class="vote-dot"></span>' : ''}
          <div class="dname">${esc(pl.nickname)}</div>
        </div>`).join('');
  }

  function feedItemHtml(entry, p, priv) {
    if (entry.type === 'system') {
      const major = /^Case \d|interrogation begins|Time to vote|detectives retreat|POLYGRAPH|OVERTIME|RAPID/i.test(entry.text);
      return `<div class="sys${major ? ' major' : ''}">${esc(entry.text)}</div>`;
    }
    if (entry.type === 'question') {
      const asker = playerById(entry.byId);
      const tags = [entry.polygraph ? '<span class="poly-tag">POLYGRAPH<svg class="heart" viewBox="0 0 84 22"><path d="M0 11 H20 L26 3 L32 19 L38 1 L44 17 L50 11 H84"/></svg></span>' : '', entry.rapid ? '<span class="chip amber">RAPID FIRE</span>' : ''].join('');
      return `
        <div class="msg q${entry.followUp ? ' followup' : ''}" style="--c:${asker ? asker.color : '#555'}">
          ${asker ? `<img src="${avatarSrc(asker.avatar)}" alt="">` : ''}
          <div>
            <div class="who">${esc(asker ? asker.nickname : '?')} asks</div>
            <div class="bubble">${esc(entry.text)}</div>
            ${tags ? `<div style="margin-top:4px">${tags}</div>` : ''}
          </div>
        </div>`;
    }
    if (entry.type === 'answer') {
      if (entry.silent) {
        return `<div class="silent-line">🚩 ...the suspect stays silent.</div>`;
      }
      const sus = playerById(entry.byId);
      const reacts = entry.reactions || {};
      const detective = amDetective();
      const canFollow = detective && p.phase === 'interrogation' && (priv.you.followUpsLeft || 0) > 0;
      const reactHtml = ICONS.map((icon) => {
        const ids = reacts[icon] || [];
        const mine = ids.includes(S.session?.playerId);
        return `<button class="react${mine ? ' on' : ''}" data-react="${entry.id}|${icon}" ${detective ? '' : 'disabled'} title="${detective ? 'React' : 'Only detectives can react'}">${icon} ${ids.length}</button>`;
      }).join('');
      const flagTag = entry.flag ? `<span class="flag-tag">⚠ CONTRADICTION: ${esc(entry.flag.toUpperCase())}</span>` : '';
      return `
        <div class="msg a${entry.polygraph ? ' poly' : ''}${entry.lawyerUp ? ' lawyer' : ''}${entry.flag ? ' flag' : ''}" style="--c:${sus ? sus.color : '#f2a93b'}">
          <div>
            <div class="bubble">${esc(entry.text)}</div>
            <div class="meta">
              ${flagTag}
              ${entry.lawyerUp ? '<span class="chip">LAWYER UP</span>' : ''}
              ${entry.polygraph ? '<span class="poly-tag">POLYGRAPH</span>' : ''}
              ${reactHtml}
              ${canFollow ? `<button class="mini-btn" data-followup="${entry.id}">FOLLOW-UP</button>` : ''}
            </div>
          </div>
          ${sus ? `<img src="${avatarSrc(sus.avatar)}" alt="">` : ''}
        </div>`;
    }
    return '';
  }

  function renderFeedOrDelib(p, priv, phaseChanged) {
    const feed = $('feed');
    const delib = $('delib');
    const inDelib = p.phase === 'deliberation' || p.phase === 'vote';

    if (inDelib) {
      delib.classList.remove('hidden');
      const body = amDetective()
        ? `<div class="delib-msgs" id="delib-msgs">${(priv.chat || []).map((m) => `
              <div class="delib-msg" style="--c:${m.color}"><b>${esc(m.nickname)}:</b>${esc(m.text)}</div>`).join('') || '<div class="muted">No one has spoken yet. The suspect is not listening.</div>'}</div>`
        : `<div class="locked"><div class="type">LOCKED</div><p>The detectives are deliberating in private. You are not invited.</p></div>`;
      delib.innerHTML = `<div class="delib-head type">DETECTIVES ONLY · ${p.phase === 'vote' ? 'VOTE IS SECRET' : 'DELIBERATION'}</div>${body}`;
      const msgs = $('delib-msgs');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      feed.classList.add('hidden');
    } else {
      delib.classList.add('hidden');
      feed.classList.remove('hidden');
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      const savedTop = feed.scrollTop;
      const sysHead = p.feed.length === 0 ? '<div class="sys">The case is open. Ask your first question.</div>' : '';
      feed.innerHTML = sysHead + p.feed.map((e) => feedItemHtml(e, p, priv)).join('');
      feed.scrollTop = atBottom || phaseChanged ? feed.scrollHeight : savedTop;
    }

    // Sounds for new messages
    if (p.feed.length > S.lastFeedLen && S.lastFeedLen !== 0) {
      const last = p.feed[p.feed.length - 1];
      if (last && (last.type === 'question' || last.type === 'answer')) Sound.type();
    }
    S.lastFeedLen = p.feed.length;
    if (p.phase !== S.lastPhase && S.lastPhase !== null) {
      if (p.phase === 'interrogation' || p.phase === 'vote' || p.phase === 'final') Sound.chime();
    }
    S.lastPhase = p.phase;
  }

  function inputMode(p, priv) {
    const you = priv.you || {};
    if (p.phase === 'interrogation') {
      if (you.isSuspect) return p.current ? (p.current.polygraph ? 'poly' : 'answer') : 'wait';
      return 'ask';
    }
    if (p.phase === 'deliberation') return amDetective() ? 'chat' : 'locked';
    if (p.phase === 'vote') return amDetective() ? (S.myVote || you.hasVoted ? 'voted' : 'vote') : 'vote-wait';
    if (p.phase === 'roles') return 'roles';
    return 'idle';
  }

  function renderInputBar(p, priv) {
    const mode = inputMode(p, priv);
    const key = [mode, p.current ? p.current.id : '', S.followUpOf || '', S.myVote || '', p.phase, p.round ? p.round.number : ''].join('|');
    const bar = $('input-bar');
    if (key !== S.inputKey) {
      S.inputKey = key;
      bar.innerHTML = buildInputBar(mode, p);
      wireInputBar(mode);
    }
    updateInputMeta(mode, p, priv);
  }

  function buildInputBar(mode, p) {
    switch (mode) {
      case 'ask':
        return `
          <div class="input-row">
            <input id="ask-in" class="field" maxlength="200" placeholder="Ask the suspect a question (ENTER to send)" autocomplete="off">
            <button id="ask-btn" class="btn primary">ASK</button>
          </div>
          <div class="hint" id="input-meta"></div>`;
      case 'answer':
        return `
          <div class="input-row">
            <input id="ans-in" class="field" maxlength="280" placeholder="Your answer (ENTER to send). Careful, the detectives are watching." autocomplete="off">
            <button id="ans-btn" class="btn primary">SEND</button>
          </div>
          <div class="timer-bar"><div id="ans-bar"></div></div>
          <div class="hint" id="input-meta"></div>`;
      case 'poly':
        return `
          <div class="poly-row">
            <button id="yes-btn" class="btn" style="border-color:#3ec7e0;color:#9be8ff">YES</button>
            <button id="no-btn" class="btn" style="border-color:#3ec7e0;color:#9be8ff">NO</button>
          </div>
          <div class="timer-bar"><div id="ans-bar"></div></div>
          <div class="hint"><span class="poly-tag">POLYGRAPH</span> Answer YES or NO. Tell the truth.</div>`;
      case 'wait':
        return `<div class="hint" style="font-size:16px">Waiting for the next question. Keep your face still. <span id="input-meta"></span></div>`;
      case 'chat':
        return `
          <div class="input-row">
            <input id="chat-in" class="field" maxlength="200" placeholder="Talk to your fellow detectives (ENTER to send)" autocomplete="off">
            <button id="chat-btn" class="btn">SAY</button>
          </div>
          <div class="hint">Only detectives can see this room. The suspect is not listening.</div>`;
      case 'vote':
        return `
          <div class="vote-row">
            <button id="vote-guilty" class="guilty"><span>GUILTY</span> <kbd>G</kbd></button>
            <button id="vote-innocent" class="innocent"><span>INNOCENT</span> <kbd>I</kbd></button>
          </div>
          <div class="hint">Majority decides. A tie counts as innocent. Your vote is secret until the reveal.</div>`;
      case 'voted':
        return `<div class="hint" style="font-size:16px">You have voted. Waiting for the other detectives...</div>`;
      case 'vote-wait':
        return `<div class="hint" style="font-size:16px">The detectives are voting in secret. Sweat it out.</div>`;
      case 'roles':
        return `<div class="hint" style="font-size:16px">Roles are being dealt. Hold SPACE on the right to peek at your cards.</div>`;
      case 'locked':
        return `<div class="hint" style="font-size:16px">The detectives are in the deliberation room. Stay calm.</div>`;
      default:
        return `<div class="hint" style="font-size:16px" id="input-meta"></div>`;
    }
  }

  function wireInputBar(mode) {
    const enter = (id, fn) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
    };
    if (mode === 'ask') {
      const send = () => {
        const input = $('ask-in');
        const text = input.value.trim();
        if (!text) return;
        act('game:question', { text, followUpOf: S.followUpOf || null }, () => {
          input.value = '';
          S.followUpOf = null;
          S.inputKey = null;
        });
      };
      enter('ask-in', send);
      $('ask-btn').addEventListener('click', send);
    }
    if (mode === 'answer') {
      const input = $('ans-in');
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        act('game:answer', { text }, () => { input.value = ''; });
      };
      input.addEventListener('input', () => {
        if (!S.typingSent) {
          socket.emit('game:typing', { on: true });
          S.typingSent = true;
        }
        clearTimeout(S.typingTimer);
        S.typingTimer = setTimeout(() => {
          socket.emit('game:typing', { on: false });
          S.typingSent = false;
        }, 2000);
      });
      enter('ans-in', send);
      $('ans-btn').addEventListener('click', send);
      input.focus();
    }
    if (mode === 'poly') {
      const answer = (t) => act('game:answer', { text: t });
      $('yes-btn').addEventListener('click', () => answer('YES'));
      $('no-btn').addEventListener('click', () => answer('NO'));
    }
    if (mode === 'chat') {
      const send = () => {
        const input = $('chat-in');
        const text = input.value.trim();
        if (!text) return;
        act('game:chat', { text }, () => { input.value = ''; });
      };
      enter('chat-in', send);
      $('chat-btn').addEventListener('click', send);
    }
    if (mode === 'vote') {
      $('vote-guilty').addEventListener('click', () => castVote('guilty'));
      $('vote-innocent').addEventListener('click', () => castVote('innocent'));
    }
  }

  function castVote(verdict) {
    act('game:vote', { verdict }, () => {
      S.myVote = verdict;
      S.inputKey = null;
      toast(`Vote locked: ${verdict.toUpperCase()}`);
    });
  }

  function updateInputMeta(mode, p, priv) {
    const meta = $('input-meta');
    if (!meta) return;
    const you = priv.you || {};
    if (mode === 'ask') {
      const queue = p.queue.map((q) => {
        const who = nameOf(q.byId);
        return `<span class="chip${q.followUp ? ' amber' : ''}" title="${esc(q.text)}">${q.followUp ? 'FOLLOW-UP · ' : ''}${esc(who)}: ${esc(q.text.slice(0, 28))}${q.text.length > 28 ? '…' : ''}</span>`;
      }).join('');
      const fu = S.followUpOf
        ? `<span class="chip amber">Following up on an answer <button class="icon-btn" id="fu-cancel" title="Cancel">✕</button></span>`
        : '';
      meta.innerHTML = `
        <span class="chip">Your queue ${you.queued || 0}/${you.maxQueued || 2}</span>
        <span class="chip">Follow-ups left ${you.followUpsLeft ?? 2}</span>
        ${fu}${queue}`;
      const cancel = $('fu-cancel');
      if (cancel) cancel.addEventListener('click', () => { S.followUpOf = null; S.inputKey = null; render(false); });
      // Hook up the follow-up button on answers (delegated from the feed)
    } else if (mode === 'wait' || mode === 'idle' || mode === 'roles') {
      meta.textContent = '';
    }
    // Answer timer bar
    const bar = $('ans-bar');
    if (bar && p.current) tickAnswerBar();
  }

  function tickAnswerBar() {
    const bar = $('ans-bar');
    const p = S.pub;
    if (!bar || !p || !p.current) return;
    const total = (p.current.rapid ? 8 : p.settings.answerSecs) * 1000;
    const left = Math.max(0, p.current.answerEndsAt - now());
    bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
  }

  function renderPrivate(p, priv) {
    const panel = $('private');
    const content = $('private-content');
    panel.classList.toggle('peek', S.peek === true);
    if (!priv || p.phase === 'lobby') {
      content.innerHTML = '<div class="pc-head">PRIVATE FILE</div><p class="muted small">Your private cards appear once the case opens.</p>';
      return;
    }
    const parts = [];
    parts.push('<div class="pc-head">PRIVATE FILE · ONLY YOU</div>');

    if (priv.suspect) {
      const s = priv.suspect;
      parts.push(`<div class="status-stamp ${s.status}">${s.status.toUpperCase()}</div>`);
      parts.push(`<div class="card-title">${esc(s.cardTitle)}</div>`);
      parts.push(`<ol class="details">${s.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`);
      if (s.weakSpot) parts.push(`<div class="weak"><b>WEAK SPOT</b><br>${esc(s.weakSpot)}</div>`);
      else parts.push('<div class="muted small">Your alibi is airtight. Nothing to worry about.</div>');
    }

    if (priv.evidence) {
      if (priv.you.isAccomplice) {
        parts.push('<div class="acc-box"><b>YOU ARE THE ACCOMPLICE.</b><br>You win if the group gets the verdict wrong. Keep your act believable.</div>');
      }
      parts.push('<div class="card-title">Your evidence</div>');
      parts.push(priv.evidence.map((c) => `
        <div class="evidence">
          <div>${esc(c.text)}</div>
          <div class="pin-row">
            <span class="pinned">${c.pinned ? 'PINNED TO THE BOARD' : 'Private until pinned'}</span>
            <button class="mini-btn" data-pin="${c.id}" ${c.pinned ? 'disabled' : ''}>${c.pinned ? 'PINNED' : 'PIN TO BOARD'}</button>
          </div>
        </div>`).join(''));
    }

    const pw = priv.you.power;
    if (pw) {
      const isSus = priv.you.isSuspect;
      const roleOk = pw.role === 'any' || (pw.role === 'suspect' ? isSus : !isSus && p.phase !== 'lobby');
      const phaseOk = p.phase === 'interrogation';
      const usable = !pw.used && roleOk && phaseOk;
      const hint = pw.used ? 'Already used this game.'
        : !roleOk ? (pw.role === 'suspect' ? 'Only usable when you are the suspect.' : 'Only usable by a detective.')
        : !phaseOk ? 'Usable during the interrogation.'
        : pw.type === 'lawyer_up' && !p.current ? 'Needs a question on the table.'
        : 'Ready.';
      parts.push(`
        <div class="power">
          <div class="pname">POWER CARD · ${esc(pw.name.toUpperCase())}</div>
          <p>${esc(pw.desc)}</p>
          <button id="btn-power" class="btn" ${usable ? '' : 'disabled'}>${pw.used ? 'USED' : 'USE CARD'}</button>
          <div class="note-line">${esc(hint)}</div>
        </div>`);
    }
    content.innerHTML = parts.join('');

    content.querySelectorAll('[data-pin]').forEach((b) => {
      b.addEventListener('click', () => act('game:pin', { cardId: b.dataset.pin }));
    });
    const powerBtn = $('btn-power');
    if (powerBtn) powerBtn.addEventListener('click', () => act('game:power', {}, () => toast('Card played.')));
  }

  function wireFeedButtons() {
    document.querySelectorAll('[data-react]').forEach((b) => {
      b.onclick = () => {
        const [answerId, icon] = b.dataset.react.split('|');
        act('game:react', { answerId, icon });
      };
    });
    document.querySelectorAll('[data-followup]').forEach((b) => {
      b.onclick = () => {
        S.followUpOf = b.dataset.followup;
        S.inputKey = null;
        render(false);
        const input = $('ask-in');
        if (input) input.focus();
      };
    });
  }

  // ---------- overlays: briefing, reveal, scoreboard, final ----------
  function clearOverlayTimers() {
    S.overlayTimers.forEach((t) => clearTimeout(t));
    S.overlayTimers = [];
  }
  function hideOverlay() {
    $('overlay').classList.add('hidden');
    $('overlay-body').innerHTML = '';
    clearOverlayTimers();
    S.overlayKey = null;
  }
  function showOverlay(key, html) {
    if (S.overlayKey === key) return;
    S.overlayKey = key;
    clearOverlayTimers();
    const o = $('overlay');
    o.classList.remove('hidden');
    $('overlay-body').innerHTML = html;
  }

  function renderOverlay() {
    const p = S.pub;
    if (!p) return hideOverlay();
    if (p.phase !== 'reveal') document.title = 'Live Interrogation';
    const round = p.round ? p.round.number : 0;

    if (p.phase === 'briefing' && p.caseCard) {
      if (S.overlayDismissed === `brief-${round}`) return;
      const cc = p.caseCard;
      showOverlay(`brief-${round}`, `
        <div class="folder" onclick="">
          <div class="stamp">CLASSIFIED</div>
          <div class="type" style="font-size:14px;letter-spacing:.3em;color:#6d5630">CASE ${round} OF ${p.round.total}</div>
          <h2 class="type">${esc(cc.title)}</h2>
          <div class="crime" id="brief-crime"><span class="caret"></span></div>
          <dl class="meta">
            <dt>WHEN</dt><dd>${esc(cc.timeWindow)}</dd>
            <dt>WHERE</dt><dd>${esc(cc.location)}</dd>
          </dl>
          <div class="suspect-line">Who did it? The detectives will find out. Click anywhere to dismiss.</div>
        </div>`);
      typeInto($('brief-crime'), cc.crime);
      $('overlay').onclick = () => { S.overlayDismissed = `brief-${round}`; hideOverlay(); };
      return;
    }
    $('overlay').onclick = null;

    if (p.phase === 'reveal' && p.reveal) {
      const key = `reveal-${round}`;
      if (S.overlayKey === key) return;
      const rv = p.reveal;
      const flagged = (p.feed || []).filter((f) => f.type === 'answer' && f.flag);
      showOverlay(key, `
        <div class="reveal-wrap" id="reveal-stage">
          <div class="drumroll" id="drum">♪ ♪ ♪ &nbsp;THE VERDICT ♪ ♪ ♪</div>
        </div>`);
      const shakeAt = Math.max(0, S.phaseStart + 3000 - now());
      S.overlayTimers.push(setTimeout(() => {
        Sound.gavel();
        const stage = $('reveal-stage');
        if (!stage) return;
        stage.classList.add('shake');
        stage.innerHTML = revealHtml(rv, flagged);
        const sus = playerById(rv.suspectId);
        $('overlay-body').scrollTop = 0;
        if (sus) document.title = `Verdict: ${rv.verdict}`;
      }, shakeAt));
      Sound.drumroll(Math.max(0.5, shakeAt / 1000));
      return;
    }

    if (p.phase === 'scoreboard' && p.reveal) {
      const key = `score-${round}`;
      if (S.overlayKey === key) return;
      showOverlay(key, `<div class="panel-card" style="max-width:820px;margin:auto">${standingsHtml(p, p.reveal)}
        <p class="center muted" style="margin-top:14px">Next case in <span id="next-in">--</span>…</p></div>`);
      return;
    }

    if (p.phase === 'final') {
      const key = 'final';
      if (S.overlayKey === key) return;
      const winners = p.players.filter((x) => p.winners.includes(x.id));
      const isHost = p.hostId === S.session?.playerId;
      showOverlay(key, `
        <div class="panel-card" style="max-width:860px;margin:auto">
          <h2 class="type">${winners.length > 1 ? 'DEAD HEAT' : 'CASE CLOSED'}</h2>
          <div class="winner-row">${winners.map((w) => `
            <div class="w"><img src="${avatarSrc(w.avatar)}" alt=""><b>${esc(w.nickname)}</b><span class="muted">${w.score} pts</span></div>`).join('')}</div>
          ${standingsHtml(p, null)}
          <div class="center-actions">
            ${isHost ? '<button id="btn-again" class="btn primary big">PLAY AGAIN</button>' : '<span class="muted">Waiting for the host to start a new game.</span>'}
          </div>
        </div>`);
      const again = $('btn-again');
      if (again) again.addEventListener('click', () => act('game:playAgain'));
      Sound.chime();
      return;
    }

    // Nothing to show in these phases: close any overlay left over from before.
    if (['lobby', 'roles', 'interrogation', 'deliberation', 'vote'].includes(p.phase)) hideOverlay();
  }

  function revealHtml(rv, flagged) {
    const sus = playerById(rv.suspectId);
    const verdictCls = rv.verdict;
    const votes = rv.votes.map((v) => {
      const pl = playerById(v.id);
      if (!pl) return '';
      const label = v.verdict ? v.verdict.toUpperCase() : 'DID NOT VOTE';
      return `<div class="row"><img src="${avatarSrc(pl.avatar)}" alt=""><span>${esc(pl.nickname)}${rv.accompliceId === v.id ? ' <span class="chip">ACCOMPLICE</span>' : ''}</span><span class="v ${v.verdict || 'none'}">${label}</span></div>`;
    }).join('');
    const gains = rv.breakdown.filter((b) => b.points > 0).map((b) => {
      const pl = playerById(b.id);
      return pl ? `<div>${esc(pl.nickname)} <span class="gain">+${b.points}</span> <span class="muted small">${esc(b.notes.join(', '))}</span></div>` : '';
    }).join('') || '<div class="muted">No points this case.</div>';
    const flags = flagged.length
      ? flagged.map((f) => `<li class="hit">"${esc(f.text)}" <span class="small">(${esc(f.flag)})</span></li>`).join('')
      : '<li class="muted">No contradictions. Clean answers.</li>';
    return `
      <div>
        <div class="verdict-stamp ${verdictCls}">${verdictCls.toUpperCase()}</div>
        <div class="muted" style="margin-top:12px;font-size:18px">The truth: ${rv.truth === 'guilty' ? `<b style="color:#ff8a80">${esc(sus ? sus.nickname : 'The suspect')} did it.</b>` : `<b style="color:#b8f5d2">${esc(sus ? sus.nickname : 'The suspect')} was innocent.</b>`}</div>
      </div>
      <div class="reveal-panel">
        <div>
          <h3>${esc(rv.alibiTitle)} · ${esc(sus ? sus.nickname : '')}</h3>
          <ol class="alibi-list">${rv.alibi.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
          ${rv.weakSpot ? `<div class="weak" style="margin-top:10px"><b>WEAK SPOT</b><br>${esc(rv.weakSpot)}</div>` : '<div class="muted small" style="margin-top:10px">No weak spot. The alibi held.</div>'}
          <h3 style="margin-top:14px">Contradictions</h3>
          <ul class="alibi-list">${flags}</ul>
        </div>
        <div>
          <h3>Who voted what</h3>
          <div class="vote-list">${votes}</div>
          <h3 style="margin-top:14px">Points earned</h3>
          ${gains}
          <h3 style="margin-top:14px">Real clues</h3>
          <ul class="alibi-list">${rv.realClues.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        </div>
      </div>`;
  }

  function standingsHtml(p, rv) {
    const sorted = [...p.players].sort((a, b) => b.score - a.score);
    const gain = new Map((rv ? rv.breakdown : []).map((b) => [b.id, b.points]));
    const rows = sorted.map((pl, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td><img src="${avatarSrc(pl.avatar)}" alt="">${esc(pl.nickname)}</td>
        <td class="num">${pl.score}</td>
        <td class="num">${gain.get(pl.id) ? `<span class="gain">+${gain.get(pl.id)}</span>` : ''}</td>
      </tr>`).join('');
    return `<table class="score-table"><thead><tr><th class="num">#</th><th>Detective</th><th class="num">Total</th><th class="num">This case</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function typeInto(elm, text) {
    if (!elm) return;
    let i = 0;
    clearInterval(S.typeTimer);
    S.typeTimer = setInterval(() => {
      if (!elm.isConnected) return clearInterval(S.typeTimer);
      i += 2;
      elm.innerHTML = `${esc(text.slice(0, i))}<span class="caret"></span>`;
      if (i % 6 === 0) Sound.type();
      if (i >= text.length) {
        clearInterval(S.typeTimer);
        elm.innerHTML = esc(text);
      }
    }, 26);
  }

  // ---------- timers and frame loop ----------
  function tickUI() {
    const p = S.pub;
    if (!p) return;
    if (p.phase !== 'lobby' && p.phaseEndsAt) {
      const left = p.phaseEndsAt - now();
      const total = Math.max(1, p.phaseEndsAt - S.phaseStart);
      $('timer').textContent = fmt(left);
      $('timer').classList.toggle('urgent', left <= 10000 && left > 0);
      const ring = $('ring-fg');
      ring.style.strokeDashoffset = String(100 - Math.min(100, Math.max(0, (left / total) * 100)));
      ring.classList.toggle('urgent', left <= 10000);
      const sec = Math.ceil(left / 1000);
      if (sec <= 10 && sec > 0 && sec !== S.lastTick) {
        S.lastTick = sec;
        Sound.tick();
      }
      const next = $('next-in');
      if (next) next.textContent = String(Math.max(0, Math.ceil(left / 1000)));
    } else {
      $('timer').textContent = '--:--';
      $('ring-fg').style.strokeDashoffset = '0';
    }
    tickAnswerBar();
    // Reveal timing: the overlay schedules its own gavel; nothing to do here.
  }

  // ---------- rain on the interrogation window ----------
  function startRain() {
    const canvas = $('rain');
    const ctx2d = canvas.getContext('2d');
    const drops = [];
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width);
      canvas.height = Math.max(1, r.height);
      drops.length = 0;
      for (let i = 0; i < 140; i++) drops.push(spawn(true));
    };
    const spawn = (anywhere) => ({
      x: Math.random() * canvas.width,
      y: anywhere ? Math.random() * canvas.height : -20,
      v: 8 + Math.random() * 10,
      len: 8 + Math.random() * 14,
    });
    const frame = () => {
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.strokeStyle = 'rgba(170,190,230,.35)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (const d of drops) {
        ctx2d.moveTo(d.x, d.y);
        ctx2d.lineTo(d.x - 2, d.y + d.len);
        d.y += d.v;
        if (d.y > canvas.height) Object.assign(d, spawn(false));
      }
      ctx2d.stroke();
      requestAnimationFrame(frame);
    };
    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(frame);
  }

  // ---------- keyboard ----------
  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  }

  function wireKeys() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      if (e.code === 'Space') {
        if (S.pub && S.pub.phase !== 'lobby') {
          e.preventDefault();
          if (!e.repeat) {
            S.peek = true;
            $('private').classList.add('peek');
          }
        }
        return;
      }
      if (e.key === 'g' || e.key === 'G' || e.key === 'i' || e.key === 'I') {
        if (S.pub && S.pub.phase === 'vote' && amDetective() && !S.myVote && !me().hasVoted) {
          const verdict = e.key.toLowerCase() === 'g' ? 'guilty' : 'innocent';
          castVote(verdict);
        }
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        toggleMute();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        S.peek = false;
        $('private').classList.remove('peek');
      }
    });
    window.addEventListener('blur', () => {
      S.peek = false;
      $('private').classList.remove('peek');
    });
  }

  function toggleMute() {
    const muted = Sound.toggleMute();
    $('btn-mute').textContent = muted ? '🔇' : '🔊';
    $('vol').value = String(Math.round((muted ? 0 : Sound.volume) * 100));
  }

  // ---------- landing / lobby actions ----------
  function wireButtons() {
    const nickInput = $('nick');
    const saved = (() => { try { return localStorage.getItem('li.nick') || ''; } catch (_e) { return ''; } })();
    nickInput.value = saved || (loadSession()?.nickname || '');

    const rememberNick = () => {
      const n = nickInput.value.trim();
      try { localStorage.setItem('li.nick', n); } catch (_e) { /* ignore */ }
      return n;
    };

    $('btn-host').addEventListener('click', () => {
      Sound.unlock();
      const nickname = rememberNick();
      if (!nickname) return ($('landing-error').textContent = 'Give yourself a nickname first.');
      socket.emit('room:create', { nickname }, (res) => {
        if (!res.ok) return ($('landing-error').textContent = res.error);
        saveSession({ code: res.code, nickname, token: res.token, playerId: res.playerId });
        $('landing-error').textContent = '';
        history.replaceState(null, '', `/?code=${res.code}`);
      });
    });

    const join = () => {
      Sound.unlock();
      const nickname = rememberNick();
      const code = $('code-in').value.trim().toUpperCase();
      if (!nickname) return ($('landing-error').textContent = 'Give yourself a nickname first.');
      if (!/^[A-Z]{4}$/.test(code)) return ($('landing-error').textContent = 'Room codes are 4 letters.');
      socket.emit('room:join', { code, nickname }, (res) => {
        if (!res.ok) return ($('landing-error').textContent = res.error);
        saveSession({ code, nickname, token: res.token, playerId: res.playerId });
        $('landing-error').textContent = '';
        history.replaceState(null, '', `/?code=${code}`);
      });
    };
    $('btn-join').addEventListener('click', join);
    $('code-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-host').click(); });

    $('btn-copy').addEventListener('click', async () => {
      const url = `${location.origin}/?code=${S.pub ? S.pub.code : ''}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied.');
      } catch (_e) {
        toast(url);
      }
    });

    $('btn-start').addEventListener('click', () => act('game:start'));
    $('btn-leave').addEventListener('click', () => {
      clearSession();
      history.replaceState(null, '', '/');
      socket.disconnect();
      S.pub = null;
      S.priv = null;
      showLanding();
      socket.connect();
    });

    let settingsTimer = null;
    const pushSettings = () => {
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(() => {
        act('room:settings', {
          rounds: Number($('set-rounds').value),
          interrogationSecs: Number($('set-time').value),
          answerSecs: Number($('set-answer').value),
          accomplice: $('set-accomplice').checked,
        });
      }, 250);
    };
    ['set-rounds', 'set-time', 'set-answer', 'set-accomplice'].forEach((id) => {
      $(id).addEventListener('change', pushSettings);
    });

    $('btn-mute').addEventListener('click', toggleMute);
    $('vol').value = String(Math.round(Sound.volume * 100));
    $('btn-mute').textContent = Sound.muted ? '🔇' : '🔊';
    $('vol').addEventListener('input', (e) => {
      Sound.setVolume(Number(e.target.value) / 100);
      if (Sound.muted) toggleMute();
    });

    // Unlock audio on the first gesture anywhere.
    const unlock = () => { Sound.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  // ---------- boot ----------
  async function boot() {
    fit();
    window.addEventListener('resize', fit);
    wireButtons();
    wireKeys();
    startRain();
    buildPickersOnce();
    S.session = loadSession();

    const qCode = new URLSearchParams(location.search).get('code');
    if (qCode) $('code-in').value = qCode.toUpperCase().slice(0, 4);

    connect();
    setInterval(tickUI, 100);
    setInterval(() => {
      // Keep the server's clock estimate fresh for timers.
      if (socket && socket.connected) {
        const t0 = Date.now();
        socket.emit('time:sync', null, (serverNow) => {
          const rtt = Date.now() - t0;
          S.offset = serverNow + rtt / 2 - Date.now();
        });
      }
    }, 5000);
  }

  let pickersBuilt = false;
  function buildPickersOnce() {
    if (pickersBuilt) return;
    pickersBuilt = true;
    fetch('/api/meta').then((r) => r.json()).then((meta) => {
      S.meta = meta;
      buildLookPickers();
      if (S.pub) renderLobby();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
