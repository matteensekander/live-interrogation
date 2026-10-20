'use strict';

// Server-authoritative game room. All rules, timers and secrets live here.
// Public data goes out through publicState(); private data only through
// privateState(playerId). app.js never sends anything else.

const crypto = require('crypto');
const CASES = require('./cases.json');
const {
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_QUEUED_QUESTIONS,
  MAX_FOLLOWUPS_PER_ROUND,
  AVATARS,
  COLORS,
  ICONS,
  POWER_CARDS,
  TIMING,
  DEFAULT_SETTINGS,
  LIMITS,
} = require('./constants');

class GameError extends Error {}

const fail = (msg) => {
  throw new GameError(msg);
};

const clean = (s, max) =>
  String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const pick = (arr) => arr[crypto.randomInt(arr.length)];

const clamp = (n, [lo, hi], fallback) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
};

const timesIn = (text) => {
  const found = new Set();
  const re = /\b(\d{1,2}):(\d{2})\b/g;
  let m;
  while ((m = re.exec(text))) found.add(`${Number(m[1])}:${m[2]}`);
  return found;
};

class Room {
  constructor(code, { timeScale = 1, onChange = () => {} } = {}) {
    this.code = code;
    this.timeScale = timeScale;
    this.onChange = onChange;

    this.players = new Map(); // playerId -> player (token is server-only)
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };

    this.phase = 'lobby'; // lobby | briefing | roles | interrogation | deliberation | vote | reveal | scoreboard | final
    this.phaseEndsAt = null;
    this.roundIndex = 0;
    this.order = [];
    this.deck = [];
    this.scenario = null;
    this.truth = null;
    this.suspectId = null;
    this.accompliceId = null;
    this.evidence = new Map(); // playerId -> [{id, text, real, pinned}]
    this.board = [];
    this.queue = [];
    this.current = null;
    this.feed = [];
    this.polygraphNext = false;
    this.rapidLeft = 0;
    this.followUpsUsed = new Map();
    this.typing = false;
    this.chat = [];
    this.votes = new Map();
    this.reveal = null;
    this.winners = [];
    this.seq = 0;
    this.timers = {};
  }

  // ---------- plumbing ----------

  changed() {
    this.onChange(this);
  }

  ms(seconds) {
    return seconds * 1000 * this.timeScale;
  }

  schedule(name, seconds, fn) {
    this.scheduleAt(name, Date.now() + this.ms(seconds), fn);
  }

  scheduleAt(name, atMs, fn) {
    clearTimeout(this.timers[name]);
    const delay = Math.max(0, atMs - Date.now());
    this.timers[name] = setTimeout(() => {
      delete this.timers[name];
      fn();
    }, delay);
  }

  clearTimer(name) {
    clearTimeout(this.timers[name]);
    delete this.timers[name];
  }

  clearAllTimers() {
    for (const name of Object.keys(this.timers)) this.clearTimer(name);
  }

  setPhase(phase, seconds, next) {
    this.phase = phase;
    this.phaseEndsAt = Date.now() + this.ms(seconds);
    this.schedule('phase', seconds, next);
    this.changed();
  }

  addFeed(entry) {
    this.feed.push({ id: `f${this.seq++}`, ...entry });
    if (this.feed.length > 200) this.feed.splice(0, this.feed.length - 200);
  }

  // ---------- players ----------

  get connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  detectiveIds() {
    return [...this.players.keys()].filter((id) => id !== this.suspectId);
  }

  join({ nickname, avatar, color, token, socketId }) {
    const name = clean(nickname, 16);
    if (!name) fail('Please enter a nickname.');

    let player = token ? [...this.players.values()].find((p) => p.token === token) : null;
    if (!player) {
      const sameName = [...this.players.values()].find(
        (p) => p.nickname.toLowerCase() === name.toLowerCase(),
      );
      if (sameName) {
        if (sameName.connected) fail('That nickname is already in this room.');
        player = sameName; // reconnect by nickname
      }
    }

    if (player) {
      player.socketId = socketId;
      player.connected = true;
      player.token = crypto.randomBytes(16).toString('hex');
      if (!this.hostId || !this.players.get(this.hostId)?.connected) this.hostId = player.id;
      this.changed();
      return player;
    }

    if (this.phase !== 'lobby') fail('This game has already started. Wait in the lobby for the next one.');
    if (this.players.size >= MAX_PLAYERS) fail('This room is full (8 players max).');

    const taken = new Set([...this.players.values()].map((p) => p.avatar));
    const takenColors = new Set([...this.players.values()].map((p) => p.color));
    const av = AVATARS.find((a) => a.id === avatar && !taken.has(a.id))
      || AVATARS.find((a) => !taken.has(a.id));
    const col = COLORS.find((c) => c === color && !takenColors.has(c))
      || COLORS.find((c) => !takenColors.has(c));

    player = {
      id: `p${crypto.randomBytes(4).toString('hex')}`,
      token: crypto.randomBytes(16).toString('hex'),
      socketId,
      nickname: name,
      avatar: av.id,
      color: col,
      connected: true,
      score: 0,
      power: null,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.changed();
    return player;
  }

  // Socket dropped. In the lobby the seat is freed; mid-game it is kept for reconnects.
  leave(socketId) {
    const player = [...this.players.values()].find((p) => p.socketId === socketId);
    if (!player) return;
    if (this.phase === 'lobby') {
      this.players.delete(player.id);
    } else {
      player.connected = false;
      player.socketId = null;
    }
    if (this.hostId === player.id || !this.players.has(this.hostId)) {
      const next = [...this.players.values()].find((p) => p.connected);
      this.hostId = next ? next.id : null;
    }
    this.changed();
  }

  pickAppearance(playerId, { avatar, color }) {
    if (this.phase !== 'lobby') fail('You can only change your look in the lobby.');
    const p = this.players.get(playerId);
    if (!p) fail('Player not found.');
    if (avatar !== undefined) {
      if (!AVATARS.some((a) => a.id === avatar)) fail('Unknown avatar.');
      if ([...this.players.values()].some((o) => o !== p && o.avatar === avatar)) fail('That avatar is taken.');
      p.avatar = avatar;
    }
    if (color !== undefined) {
      if (!COLORS.includes(color)) fail('Unknown color.');
      if ([...this.players.values()].some((o) => o !== p && o.color === color)) fail('That color is taken.');
      p.color = color;
    }
    this.changed();
  }

  updateSettings(playerId, s) {
    this.assertHost(playerId);
    if (this.phase !== 'lobby') fail('Settings are locked during a game.');
    this.settings = {
      rounds: clamp(s.rounds, LIMITS.rounds, this.settings.rounds),
      interrogationSecs: clamp(s.interrogationSecs, LIMITS.interrogationSecs, this.settings.interrogationSecs),
      answerSecs: clamp(s.answerSecs, LIMITS.answerSecs, this.settings.answerSecs),
      accomplice: Boolean(s.accomplice),
    };
    this.changed();
  }

  assertHost(playerId) {
    if (playerId !== this.hostId) fail('Only the host can do that.');
  }

  // ---------- game flow ----------

  start(playerId) {
    this.assertHost(playerId);
    if (this.phase !== 'lobby') fail('The game is already running.');
    const ready = [...this.players.values()].filter((p) => p.connected);
    if (ready.length < MIN_PLAYERS) fail(`You need at least ${MIN_PLAYERS} players to start.`);

    for (const p of ready) {
      p.score = 0;
      const type = pick(Object.keys(POWER_CARDS));
      p.power = { type, used: false };
    }
    this.order = shuffle(ready.map((p) => p.id));
    this.deck = shuffle(CASES.map((_, i) => i)).slice(0, this.settings.rounds);
    this.roundIndex = 0;
    this.winners = [];
    this.startRound();
  }

  startRound() {
    this.scenario = CASES[this.deck[this.roundIndex]];
    this.suspectId = this.order[this.roundIndex % this.order.length];
    this.truth = Math.random() < 0.5 ? 'guilty' : 'innocent';
    const detectives = this.detectiveIds();
    this.accompliceId = this.settings.accomplice ? pick(detectives) : null;

    this.dealEvidence(detectives);
    this.queue = [];
    this.current = null;
    this.feed = [];
    this.board = [];
    this.votes = new Map();
    this.reveal = null;
    this.chat = [];
    this.followUpsUsed = new Map();
    this.polygraphNext = false;
    this.rapidLeft = 0;
    this.typing = false;
    this.clearTimer('answer');
    this.clearTimer('pause');
    this.clearTimer('typing');

    this.addFeed({ type: 'system', text: `Case ${this.roundIndex + 1} of ${this.settings.rounds}: ${this.scenario.title}` });
    this.setPhase('briefing', TIMING.briefing, () =>
      this.setPhase('roles', TIMING.roles, () => this.startInterrogation()),
    );
  }

  dealEvidence(detectives) {
    const reals = shuffle(this.scenario.realClues);
    const herrings = shuffle(this.scenario.redHerrings);
    this.evidence = new Map();
    shuffle(detectives).forEach((id, i) => {
      const cards = [
        { id: `r${this.roundIndex}-${i}a`, text: reals[i % reals.length], real: true, pinned: false },
        { id: `r${this.roundIndex}-${i}b`, text: herrings[i % herrings.length], real: false, pinned: false },
      ];
      this.evidence.set(id, shuffle(cards));
    });
  }

  startInterrogation() {
    this.addFeed({ type: 'system', text: 'The interrogation begins.' });
    this.setPhase('interrogation', this.settings.interrogationSecs, () => this.endInterrogation());
  }

  endInterrogation() {
    this.clearTimer('answer');
    this.clearTimer('pause');
    this.clearTimer('typing');
    this.typing = false;
    if (this.current) {
      this.addFeed({ type: 'system', text: 'Time is up. Unanswered questions are dropped.' });
    }
    this.current = null;
    this.queue = [];
    this.addFeed({ type: 'system', text: 'The detectives retreat to deliberate.' });
    this.setPhase('deliberation', TIMING.deliberation, () => this.startVote());
  }

  startVote() {
    this.addFeed({ type: 'system', text: 'Time to vote. Your vote is secret.' });
    this.setPhase('vote', TIMING.vote, () => this.finishVote());
  }

  finishVote() {
    this.clearTimer('phase');
    this.reveal = this.computeReveal();
    this.setPhase('reveal', TIMING.reveal, () =>
      this.setPhase('scoreboard', TIMING.scoreboard, () => this.afterScoreboard()),
    );
  }

  afterScoreboard() {
    if (this.roundIndex + 1 >= this.settings.rounds) {
      const top = Math.max(...[...this.players.values()].map((p) => p.score));
      this.winners = [...this.players.values()].filter((p) => p.score === top).map((p) => p.id);
      this.phase = 'final';
      this.phaseEndsAt = null;
      this.changed();
      return;
    }
    this.roundIndex++;
    this.startRound();
  }

  // ---------- interrogation ----------

  askQuestion(playerId, text, followUpOfId) {
    if (this.phase !== 'interrogation') fail('Questions can only be asked during the interrogation.');
    if (playerId === this.suspectId) fail('The suspect answers questions, they do not ask them.');
    const body = clean(text, 200);
    if (!body) fail('Type a question first.');

    const queued = this.queue.filter((q) => q.byId === playerId).length;
    if (queued >= MAX_QUEUED_QUESTIONS) fail(`You already have ${MAX_QUEUED_QUESTIONS} questions queued.`);

    const question = { id: `q${this.seq++}`, byId: playerId, text: body, followUp: false };
    if (followUpOfId) {
      const answer = this.feed.find((f) => f.id === followUpOfId && f.type === 'answer');
      if (!answer) fail('That answer is no longer available to follow up on.');
      const used = this.followUpsUsed.get(playerId) || 0;
      if (used >= MAX_FOLLOWUPS_PER_ROUND) fail(`No follow-ups left this round (${MAX_FOLLOWUPS_PER_ROUND} max).`);
      this.followUpsUsed.set(playerId, used + 1);
      question.followUp = true;
      this.queue.unshift(question);
    } else {
      this.queue.push(question);
    }
    this.processNext();
    this.changed();
  }

  processNext() {
    if (this.phase !== 'interrogation' || this.current || this.timers.pause || this.queue.length === 0) return;
    const q = this.queue.shift();
    q.polygraph = this.polygraphNext;
    this.polygraphNext = false;
    let answerSecs = this.settings.answerSecs;
    if (this.rapidLeft > 0) {
      answerSecs = TIMING.rapidAnswer;
      this.rapidLeft--;
      q.rapid = true;
    }
    q.answerEndsAt = Date.now() + this.ms(answerSecs);
    this.current = q;
    this.addFeed({
      type: 'question',
      id: q.id,
      byId: q.byId,
      text: q.text,
      followUp: q.followUp,
      polygraph: q.polygraph,
      rapid: Boolean(q.rapid),
    });
    this.schedule('answer', answerSecs, () => this.finishAnswer({ text: null, silent: true }));
    this.changed();
  }

  submitAnswer(playerId, text) {
    if (!this.current || playerId !== this.suspectId) fail('Nobody is waiting on your answer.');
    let body = clean(text, 280);
    if (this.current.polygraph) {
      body = body.toUpperCase();
      if (body !== 'YES' && body !== 'NO') fail('POLYGRAPH: answer YES or NO only.');
    } else if (!body) {
      fail('Type an answer first.');
    }
    this.finishAnswer({ text: body, silent: false });
  }

  finishAnswer({ text, silent, lawyerUp = false }) {
    this.clearTimer('answer');
    this.clearTimer('typing');
    this.typing = false;
    const q = this.current;
    this.current = null;
    this.addFeed({
      type: 'answer',
      byId: this.suspectId,
      qId: q.id,
      questionText: q.text,
      text,
      silent,
      lawyerUp,
      polygraph: Boolean(q.polygraph),
      reactions: {},
    });
    this.schedule('pause', TIMING.pause, () => this.processNext());
    this.changed();
  }

  setTyping(playerId, on) {
    if (playerId !== this.suspectId || !this.current) return;
    if (on && !this.typing) {
      this.typing = true;
      this.changed();
    }
    if (on) {
      this.schedule('typing', TIMING.typing, () => {
        this.typing = false;
        this.changed();
      });
    } else if (this.typing) {
      this.clearTimer('typing');
      this.typing = false;
      this.changed();
    }
  }

  react(playerId, answerId, icon) {
    if (!ICONS.includes(icon)) fail('Unknown reaction.');
    if (!this.detectiveIds().includes(playerId)) fail('Only detectives can react.');
    const answer = this.feed.find((f) => f.id === answerId && f.type === 'answer');
    if (!answer) fail('That answer is gone.');
    const list = answer.reactions[icon] || [];
    answer.reactions[icon] = list.includes(playerId)
      ? list.filter((id) => id !== playerId)
      : [...list, playerId];
    this.changed();
  }

  pinEvidence(playerId, cardId) {
    const cards = this.evidence.get(playerId) || [];
    const card = cards.find((c) => c.id === cardId);
    if (!card) fail('That card is not in your hand.');
    if (card.pinned) return;
    card.pinned = true;
    this.board.push({ id: card.id, byId: playerId, text: card.text });
    this.changed();
  }

  usePower(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.power || p.power.used) fail('You have no power card left.');
    const type = p.power.type;
    const card = POWER_CARDS[type];
    const isSuspect = playerId === this.suspectId;
    if (card.role === 'suspect' && !isSuspect) fail('Lawyer Up can only be played by the suspect.');
    if (card.role === 'detective' && isSuspect) fail(`${card.name} can only be played by a detective.`);
    if (this.phase !== 'interrogation') fail(`${card.name} can only be played during the interrogation.`);

    switch (type) {
      case 'lawyer_up': {
        if (!this.current) fail('There is no question to skip right now.');
        if (this.current.polygraph) fail('You cannot Lawyer Up on a polygraph question.');
        p.power.used = true;
        this.finishAnswer({ text: 'My client has no comment.', silent: false, lawyerUp: true });
        return;
      }
      case 'polygraph': {
        if (this.polygraphNext) fail('A polygraph is already armed.');
        this.polygraphNext = true;
        this.addFeed({ type: 'system', text: 'The detectives have called a POLYGRAPH on the next question.' });
        break;
      }
      case 'overtime': {
        this.phaseEndsAt += this.ms(TIMING.overtimeBonus);
        this.scheduleAt('phase', this.phaseEndsAt, () => this.endInterrogation());
        this.addFeed({ type: 'system', text: 'OVERTIME: the clock gained 60 seconds.' });
        break;
      }
      case 'rapid_fire': {
        if (this.rapidLeft > 0) fail('Rapid Fire is already active.');
        this.rapidLeft = 3;
        this.addFeed({ type: 'system', text: 'RAPID FIRE: the next 3 answers have 8 seconds.' });
        break;
      }
      default:
        fail('Unknown power card.');
    }
    p.power.used = true;
    this.changed();
  }

  // ---------- deliberation & vote ----------

  sendChat(playerId, text) {
    if (this.phase !== 'deliberation' && this.phase !== 'vote') fail('The deliberation room is closed right now.');
    if (!this.detectiveIds().includes(playerId)) fail('Only detectives are in the deliberation room.');
    const body = clean(text, 200);
    if (!body) return;
    const p = this.players.get(playerId);
    this.chat.push({ id: `c${this.seq++}`, byId: playerId, nickname: p.nickname, avatar: p.avatar, color: p.color, text: body });
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    this.changed();
  }

  castVote(playerId, verdict) {
    if (this.phase !== 'vote') fail('Voting is not open.');
    if (!this.detectiveIds().includes(playerId)) fail('Only detectives vote.');
    if (verdict !== 'guilty' && verdict !== 'innocent') fail('Vote guilty or innocent.');
    this.votes.set(playerId, verdict);
    if (this.votes.size >= this.detectiveIds().length) {
      this.finishVote();
    } else {
      this.changed();
    }
  }

  computeReveal() {
    const detectives = this.detectiveIds();
    const votes = detectives.map((id) => ({ id, verdict: this.votes.get(id) || null }));
    const guiltyVotes = votes.filter((v) => v.verdict === 'guilty').length;
    const innocentVotes = votes.filter((v) => v.verdict === 'innocent').length;
    const verdict = guiltyVotes > innocentVotes ? 'guilty' : 'innocent'; // tie counts as innocent

    const points = new Map(detectives.map((id) => [id, { points: 0, notes: [] }]));
    points.set(this.suspectId, { points: 0, notes: [] });
    const award = (id, n, note) => {
      const entry = points.get(id);
      entry.points += n;
      entry.notes.push(note);
    };
    if (this.truth === 'guilty' && verdict === 'innocent') award(this.suspectId, 3, 'Got away with it');
    if (this.truth === 'innocent' && verdict === 'innocent') award(this.suspectId, 2, 'Cleared');
    for (const v of votes) {
      if (v.verdict === this.truth) award(v.id, 1, 'Correct vote');
    }
    if (this.accompliceId && verdict !== this.truth) {
      award(this.accompliceId, 3, 'Accomplice: the wrong verdict');
    }
    for (const [id, entry] of points) {
      this.players.get(id).score += entry.points;
    }

    const card = this.truth === 'guilty' ? this.scenario.cover : this.scenario.alibi;
    const contradictionIds = this.findContradictions(card);

    return {
      scenarioTitle: this.scenario.title,
      caseCard: this.publicCase(),
      verdict,
      truth: this.truth,
      suspectId: this.suspectId,
      alibiTitle: this.truth === 'guilty' ? 'COVER STORY' : 'ALIBI',
      alibi: card,
      weakSpot: this.truth === 'guilty' ? this.scenario.weakSpot.text : null,
      realClues: this.scenario.realClues,
      votes,
      accompliceId: this.accompliceId,
      breakdown: [...points.entries()].map(([id, e]) => ({ id, points: e.points, notes: e.notes })),
      contradictionIds,
    };
  }

  // Heuristic: an answer is flagged if it touches the weak spot keywords (guilty only)
  // or states a clock time that the suspect's card does not contain.
  findContradictions(card) {
    const cardTimes = timesIn(card.join(' ').toLowerCase());
    const keywords = this.truth === 'guilty' ? this.scenario.weakSpot.keywords : [];
    const flagged = [];
    for (const f of this.feed) {
      if (f.type !== 'answer' || !f.text) continue;
      const t = f.text.toLowerCase();
      const weak = keywords.some((k) => t.includes(k));
      const badTime = [...timesIn(t)].some((x) => cardTimes.size > 0 && !cardTimes.has(x));
      if (weak || badTime) {
        f.flag = weak ? 'weak spot' : 'time mismatch';
        flagged.push(f.id);
      }
    }
    return flagged;
  }

  playAgain(playerId) {
    this.assertHost(playerId);
    if (this.phase !== 'final') fail('The game is not over yet.');
    for (const [id, p] of this.players) {
      if (!p.connected) this.players.delete(id);
      else {
        p.score = 0;
        p.power = null;
      }
    }
    this.clearAllTimers();
    this.phase = 'lobby';
    this.phaseEndsAt = null;
    this.roundIndex = 0;
    this.suspectId = null;
    this.reveal = null;
    this.feed = [];
    this.winners = [];
    this.changed();
  }

  // ---------- views ----------

  publicCase() {
    if (!this.scenario) return null;
    const s = this.scenario;
    return { title: s.title, crime: s.crime, timeWindow: s.timeWindow, location: s.location };
  }

  publicState() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      color: p.color,
      connected: p.connected,
      score: p.score,
      isHost: p.id === this.hostId,
      isSuspect: p.id === this.suspectId,
    }));
    const inRound = this.phase !== 'lobby' && this.phase !== 'final';
    return {
      code: this.code,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      serverNow: Date.now(),
      hostId: this.hostId,
      settings: this.settings,
      round: inRound ? { number: this.roundIndex + 1, total: this.settings.rounds } : null,
      suspectId: inRound ? this.suspectId : null,
      caseCard: inRound ? this.publicCase() : null,
      players,
      queue: this.queue.map((q) => ({ id: q.id, byId: q.byId, text: q.text, followUp: q.followUp })),
      current: this.current
        ? {
            id: this.current.id,
            byId: this.current.byId,
            text: this.current.text,
            polygraph: Boolean(this.current.polygraph),
            rapid: Boolean(this.current.rapid),
            answerEndsAt: this.current.answerEndsAt,
          }
        : null,
      feed: this.feed,
      typing: this.typing,
      board: this.board,
      votedIds: [...this.votes.keys()],
      reveal: this.reveal,
      winners: this.winners,
      polygraphArmed: this.polygraphNext,
      rapidFireLeft: this.rapidLeft,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }

  privateState(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const isSuspect = playerId === this.suspectId && this.scenario && this.phase !== 'lobby';
    const isDetective = this.scenario && !isSuspect && this.phase !== 'lobby' && this.phase !== 'final';
    const inDeliberation = this.phase === 'deliberation' || this.phase === 'vote';

    const out = {
      you: {
        id: p.id,
        isHost: p.id === this.hostId,
        isSuspect: Boolean(isSuspect),
        isAccomplice: Boolean(isDetective && this.accompliceId === playerId),
        queued: this.queue.filter((q) => q.byId === playerId).length,
        followUpsLeft: Math.max(0, MAX_FOLLOWUPS_PER_ROUND - (this.followUpsUsed.get(playerId) || 0)),
        maxQueued: MAX_QUEUED_QUESTIONS,
        hasVoted: this.votes.has(playerId),
        power: p.power
          ? {
              type: p.power.type,
              name: POWER_CARDS[p.power.type].name,
              desc: POWER_CARDS[p.power.type].desc,
              role: POWER_CARDS[p.power.type].role,
              used: p.power.used,
            }
          : null,
      },
      suspect: null,
      evidence: null,
      chat: null,
    };

    if (isSuspect) {
      out.suspect = {
        status: this.truth,
        cardTitle: this.truth === 'guilty' ? 'COVER STORY' : 'ALIBI',
        details: this.truth === 'guilty' ? this.scenario.cover : this.scenario.alibi,
        weakSpot: this.truth === 'guilty' ? this.scenario.weakSpot.text : null,
      };
    }
    if (isDetective) {
      // Real/red-herring flags are deliberately not sent until the reveal.
      out.evidence = (this.evidence.get(playerId) || []).map((c) => ({ id: c.id, text: c.text, pinned: c.pinned }));
      if (inDeliberation) out.chat = this.chat;
    }
    return out;
  }
}

module.exports = { Room, GameError };
