'use strict';

// Full-game simulation with 4 socket clients (stand-ins for browser windows).
// Runs on a fast clock (TIME_SCALE=0.05) and checks rules, timers, reconnects,
// and that private information never reaches the wrong socket.
//
//   npm test

const { io } = require('socket.io-client');
const { start } = require('../server/app');
const { AVATARS, COLORS } = require('../server/constants');

const SECRET_CHAT = 'SECRET-DETECTIVE-PLAN-XYZ';
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  ${extra}`}`);
};

function until(fn, ms = 15000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v = false;
      try { v = fn(); } catch (_e) { v = false; }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makeClient(url, nick) {
  const sock = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c = { nick, sock, log: [], state: null, priv: null, playerId: null, token: null, stateHistory: [] };
  sock.onAny((ev, data) => {
    c.log.push({ ev, text: JSON.stringify(data) || '' });
    if (ev === 'state') {
      c.state = data;
      c.stateHistory.push({ ...data, _at: Date.now() });
    }
    if (ev === 'private') c.priv = data;
  });
  c.connected = new Promise((res) => sock.on('connect', res));
  c.emit = (ev, data = {}) => new Promise((res) => sock.emit(ev, data, (r) => res(r)));
  c.fire = (ev, data = {}) => sock.emit(ev, data);
  return c;
}

const lastState = (c) => c.state;
const feedAnswers = (c) => c.state.feed.filter((f) => f.type === 'answer');
const feedQuestions = (c) => c.state.feed.filter((f) => f.type === 'question');
const idle = (c) => c.state && !c.state.current && c.state.queue.length === 0;

async function main() {
  const srv = await start({ port: 0, host: '127.0.0.1', timeScale: 0.05 });
  const url = srv.url;
  const nicks = ['Ada', 'Bo', 'Cy', 'Dee'];
  const cs = nicks.map((n) => makeClient(url, n));
  await Promise.all(cs.map((c) => c.connected));
  const [host, ...others] = cs;

  console.log('\nLobby');
  const created = await host.emit('room:create', { nickname: 'Ada' });
  check('host creates a room with a 4-letter code', created.ok && /^[A-Z]{4}$/.test(created.code), JSON.stringify(created));
  const code = created.code;
  host.playerId = created.playerId;
  host.token = created.token;
  await until(() => host.state, 2000, 'host state');

  for (const c of others.slice(0, 2)) {
    const r = await c.emit('room:join', { code, nickname: c.nick });
    check(`${c.nick} joins with code`, r.ok, r.error);
    c.playerId = r.playerId;
    c.token = r.token;
  }
  {
    const r = await others[2].emit('room:join', { code, nickname: 'Cy' });
    check('duplicate nickname is refused', !r.ok, JSON.stringify(r));
  }
  const dee = others[2];
  {
    const r = await dee.emit('room:join', { code, nickname: 'Dee' });
    check('Dee joins', r.ok, r.error);
    dee.playerId = r.playerId;
    dee.token = r.token;
  }
  await until(() => host.state.players.length === 4, 2000, '4 players');
  check('lobby lists 4 players', host.state.players.length === 4);

  for (let i = 0; i < 4; i++) {
    const r = await cs[i].emit('room:pick', { avatar: AVATARS[i].id, color: COLORS[i] });
    check(`${cs[i].nick} picks avatar ${AVATARS[i].name}`, r.ok, r.error);
  }
  {
    const r = await others[0].emit('room:pick', { avatar: AVATARS[0].id });
    check('a taken avatar cannot be picked twice', r.ok === false || cs[1].state.players[1].avatar !== AVATARS[0].id);
  }

  {
    const r = await others[0].emit('room:settings', { rounds: 1 });
    check('non-host cannot change settings', !r.ok);
  }
  await host.emit('room:settings', { rounds: 2, interrogationSecs: 120, answerSecs: 20, accomplice: true });
  await until(() => host.state.settings.rounds === 2, 2000, 'settings');
  check('host sets rounds, timers and accomplice', host.state.settings.accomplice === true && host.state.settings.interrogationSecs === 120);

  {
    const r = await others[0].emit('game:start');
    check('non-host cannot start', !r.ok);
  }
  const st = await host.emit('game:start');
  check('host starts the game', st.ok, st.error);

  const room = srv.rooms.get(code);
  await until(() => host.state.phase === 'roles', 3000, 'roles');
  const suspect = cs.find((c) => c.playerId === host.state.suspectId);
  const detectives = cs.filter((c) => c !== suspect);
  const [d0, d1, d2] = detectives;

  // --- private info: roles & evidence ---
  console.log('\nRoles and private info');
  check('suspect sees status, card and weak-spot rules', suspect.priv.suspect && ['guilty', 'innocent'].includes(suspect.priv.suspect.status) && suspect.priv.suspect.details.length >= 4);
  check('suspect has no evidence cards', suspect.priv.evidence === null);
  check('each detective gets 2 evidence cards', detectives.every((c) => c.priv.evidence && c.priv.evidence.length === 2));
  check('detectives never see suspect status', detectives.every((c) => c.priv.suspect === null));
  check('exactly one accomplice when enabled', detectives.filter((c) => c.priv.you.isAccomplice).length === 1);

  // Give specific power cards so each one can be exercised deterministically.
  room.players.get(suspect.playerId).power = { type: 'lawyer_up', used: false };
  room.players.get(d0.playerId).power = { type: 'overtime', used: false };
  room.players.get(d1.playerId).power = { type: 'polygraph', used: false };
  room.players.get(d2.playerId).power = { type: 'rapid_fire', used: false };

  await until(() => host.state.phase === 'interrogation', 3000, 'interrogation');
  const interStart = host.state.phaseEndsAt - host.state.serverNow;
  check('interrogation timer is server-timed (~6s at this clock scale)', Math.abs(interStart - 6000) < 300, `diff=${interStart}`);

  // --- interrogation: queues, silence, follow-ups, reactions, typing ---
  console.log('\nInterrogation');
  let r = await d0.emit('game:question', { text: 'Where were you at 6:10 PM?' });
  check('detective asks a question', r.ok, r.error);
  await until(() => host.state.current && host.state.current.byId === d0.playerId, 2000, 'question live');

  r = await suspect.emit('game:answer', { text: 'I was at home at 6:10 PM.' });
  check('suspect answers', r.ok, r.error);
  await until(() => feedAnswers(host).length === 1, 2000, 'first answer');
  const firstAnswer = feedAnswers(host)[0];
  check('answer appears for everyone', firstAnswer.text.includes('home'));

  // Queue two more, the fourth must be refused.
  await until(() => idle(host) || host.state.current == null, 2000, 'pause');
  await d0.emit('game:question', { text: 'Q two?' });
  await d0.emit('game:question', { text: 'Q three?' });
  r = await d0.emit('game:question', { text: 'Q four?' });
  check('a detective cannot queue more than 2 questions', !r.ok && /2 questions/.test(r.error || ''), JSON.stringify(r));

  // Q two is live; let the suspect go silent.
  await until(() => host.state.current && host.state.current.text === 'Q two?', 2000, 'Q two live').catch((e) => {
        throw e;
  });
  await until(() => feedAnswers(host).some((a) => a.silent), 2000, 'silent answer');
  check('silence after the answer timer runs out', true);

  await until(() => host.state.current && host.state.current.text === 'Q three?', 3000, 'Q three live');
  await suspect.emit('game:answer', { text: 'Not much.' });
  await until(() => feedAnswers(host).length === 3, 2000, 'answer 3');
  await until(() => idle(host), 2000, 'queue drained');

  // Typing indicator (only meaningful while a question is pending)
  await d0.emit('game:question', { text: 'Typing test?' });
  await until(() => host.state.current && host.state.current.text === 'Typing test?', 2000, 'typing q live');
  suspect.fire('game:typing', { on: true });
  await until(() => host.state.typing === true, 1000, 'typing on');
  check('"Suspect is typing" indicator shows', host.state.typing === true);
  await until(() => host.state.typing === false, 1500, 'typing off');
  check('typing indicator clears after inactivity', host.state.typing === false);
  await suspect.emit('game:answer', { text: 'Nothing to report.' });
  await until(() => idle(host), 2000, 'idle after typing test');

  // Follow-ups: two allowed, third refused.
  for (const label of ['Follow-up: which bar?', 'Follow-up two']) {
    r = await d1.emit('game:question', { text: label, followUpOf: firstAnswer.id });
    check(`follow-up accepted: "${label}"`, r.ok, r.error);
    await until(() => host.state.current && host.state.current.text === label, 2000, label);
    await suspect.emit('game:answer', { text: 'Fine.' });
    await until(() => idle(host), 2000, 'idle after follow-up');
  }
  r = await d1.emit('game:question', { text: 'Follow-up three', followUpOf: firstAnswer.id });
  check('third follow-up refused', !r.ok && /follow-up/i.test(r.error || ''), JSON.stringify(r));

  // Reactions (detectives only, toggle)
  r = await d2.emit('game:react', { answerId: firstAnswer.id, icon: '🤨' });
  check('detective reacts with 🤨', r.ok, r.error);
  check('suspect sees the reaction in real time', suspect.state.feed.find((f) => f.id === firstAnswer.id).reactions['🤨'].includes(d2.playerId));
  r = await suspect.emit('game:react', { answerId: firstAnswer.id, icon: '✅' });
  check('suspect cannot react', !r.ok);
  await d2.emit('game:react', { answerId: firstAnswer.id, icon: '🤨' });
  check('reaction toggles off', !suspect.state.feed.find((f) => f.id === firstAnswer.id).reactions['🤨'].includes(d2.playerId));

  // Lawyer Up (suspect power)
  r = await d0.emit('game:question', { text: 'Did you touch the cake?' });
  await until(() => host.state.current && host.state.current.text === 'Did you touch the cake?', 2000, 'cake q');
  r = await suspect.emit('game:power');
  check('suspect uses Lawyer Up', r.ok, r.error);
  const lawyer = feedAnswers(host).find((a) => a.lawyerUp);
  check('Lawyer Up shows "My client has no comment."', lawyer && lawyer.text === 'My client has no comment.');
  await until(() => idle(host), 2000, 'idle after lawyer');

  // Polygraph (detective power) + yes/no enforcement
  r = await d1.emit('game:power');
  check('detective uses Polygraph', r.ok, r.error);
  await d0.emit('game:question', { text: 'Did you take the cake? Yes or no.' });
  await until(() => host.state.current && host.state.current.polygraph, 2000, 'polygraph q');
  check('question is marked POLYGRAPH', host.state.current.polygraph === true);
  r = await suspect.emit('game:answer', { text: 'maybe' });
  check('polygraph answer must be YES or NO', !r.ok);
  r = await suspect.emit('game:answer', { text: 'no' });
  check('polygraph accepts NO', r.ok, r.error);
  await until(() => idle(host), 2000, 'idle after poly');

  // Rapid Fire: next answers get 8s
  r = await d2.emit('game:power');
  check('detective uses Rapid Fire', r.ok, r.error);
  await d0.emit('game:question', { text: 'Rapid one?' });
  await until(() => host.state.current && host.state.current.text === 'Rapid one?', 2000, 'rapid q');
  const rapidLeft = host.state.current.answerEndsAt - host.state.serverNow;
  check('Rapid Fire shrinks the answer timer to ~8s', Math.abs(rapidLeft - 400) < 200, `diff=${rapidLeft}`);
  await suspect.emit('game:answer', { text: 'Quick answer.' });
  await until(() => idle(host), 2000, 'idle after rapid');

  // Overtime: adds 60s (x timeScale)
  const beforeOT = host.state.phaseEndsAt;
  r = await d0.emit('game:power');
  check('detective uses Overtime', r.ok, r.error);
  await until(() => host.state.phaseEndsAt - beforeOT > 2500, 2000, 'overtime shift');
  check('Overtime adds 60 seconds', Math.abs(host.state.phaseEndsAt - beforeOT - 3000) < 50);
  r = await d0.emit('game:power');
  check('a used card cannot be reused', !r.ok);

  // Interrogation timer: last question still pending gets cut.
  await until(() => host.state.phase === 'deliberation', 15000, 'deliberation');
  const lastInterEnd = host.stateHistory.filter((s) => s.phase === 'interrogation').pop().phaseEndsAt;
  const delibFirst = host.stateHistory.find((s) => s.phase === 'deliberation' && s.phaseEndsAt > lastInterEnd);
  const skew = delibFirst._at - lastInterEnd;
  check('interrogation ends on the server deadline (phase flip within 300ms of it)', skew > -50 && skew < 300, `skew=${skew}ms`);

  // --- deliberation: detectives-only chat ---
  console.log('\nDeliberation and secret vote');
  r = await suspect.emit('game:chat', { text: 'let me in' });
  check('suspect cannot post to deliberation', !r.ok);
  r = await d0.emit('game:chat', { text: SECRET_CHAT });
  check('detective posts to the deliberation room', r.ok, r.error);
  await until(() => d1.priv && d1.priv.chat && d1.priv.chat.some((m) => m.text === SECRET_CHAT), 2000, 'chat delivered');
  check('detectives receive the deliberation chat', d1.priv.chat.some((m) => m.text === SECRET_CHAT) && d2.priv.chat.some((m) => m.text === SECRET_CHAT));
  check('suspect never receives the deliberation chat', suspect.priv.chat === null && !suspect.log.some((e) => e.text.includes(SECRET_CHAT)));

  await until(() => host.state.phase === 'vote', 6000, 'vote');
  r = await suspect.emit('game:vote', { verdict: 'innocent' });
  check('suspect cannot vote', !r.ok);
  r = await d0.emit('game:vote', { verdict: 'guilty' });
  check('detective votes guilty (secret)', r.ok, r.error);
  await until(() => host.state.votedIds.includes(d0.playerId), 2000, 'vote recorded');
  check('votes stay secret until reveal', !host.state.reveal && !host.log.some((e) => e.text.includes('"verdict"')));
  await d1.emit('game:vote', { verdict: 'innocent' });
  await d2.emit('game:vote', { verdict: 'innocent' });

  // --- reveal & scoring ---
  console.log('\nReveal and scoring');
  await until(() => host.state.phase === 'reveal' && host.state.reveal, 3000, 'reveal');
  const rev = host.state.reveal;
  const guiltyCount = rev.votes.filter((v) => v.verdict === 'guilty').length;
  const innocentCount = rev.votes.filter((v) => v.verdict === 'innocent').length;
  const expectVerdict = guiltyCount > innocentCount ? 'guilty' : 'innocent';
  check('verdict follows majority (tie = innocent)', rev.verdict === expectVerdict, `${rev.verdict} vs ${expectVerdict}`);
  const sus = rev.breakdown.find((b) => b.id === rev.suspectId);
  let expSus = 0;
  if (rev.truth === 'guilty' && rev.verdict === 'innocent') expSus = 3;
  if (rev.truth === 'innocent' && rev.verdict === 'innocent') expSus = 2;
  check('suspect scores per the rules', sus.points === expSus, `${sus.points} vs ${expSus}`);
  const accBonus = rev.accompliceId && rev.verdict !== rev.truth ? 3 : 0;
  for (const v of rev.votes) {
    const b = rev.breakdown.find((x) => x.id === v.id);
    const expected = (v.verdict === rev.truth ? 1 : 0) + (v.id === rev.accompliceId ? accBonus : 0);
    check(`detective ${cs.find((c) => c.playerId === v.id).nick} scores ${expected}`, b.points === expected, `${b.points}`);
  }
  check('weak spot shown on guilty reveal only', rev.truth === 'guilty' ? Boolean(rev.weakSpot) : rev.weakSpot === null);
  check('reveal lists the real clues', Array.isArray(rev.realClues) && rev.realClues.length === 3);
  const totals = new Map(host.state.players.map((p) => [p.id, p.score]));
  check('scores equal sum of breakdown points', rev.breakdown.every((b) => totals.get(b.id) === b.points));

  // Contradiction highlight: suspect answers that mention the time not on their card.
  const flagged = (host.state.feed.filter((f) => f.type === 'answer' && f.flag)).length;
  console.log(`  info   contradiction flags raised this round: ${flagged}`);

  // --- round 2 with reconnect ---
  await until(() => host.state.phase === 'briefing' && host.state.round.number === 2, 8000, 'round 2 briefing');
  check('round 2 begins with a new case', host.state.round.number === 2);
  await until(() => host.state.phase === 'interrogation', 8000, 'round 2 interrogation');

  console.log('\nDisconnect and reconnect');
  const dropped = cs[3];
  const droppedId = dropped.playerId;
  const droppedToken = dropped.token;
  dropped.sock.disconnect();
  await until(() => host.state.players.find((p) => p.id === droppedId).connected === false, 2000, 'dropped flag');
  check('dropped player is marked offline, host unchanged', host.state.hostId === host.playerId);
  const back = makeClient(url, dropped.nick);
  await back.connected;
  const rj = await back.emit('room:join', { code, nickname: dropped.nick, token: droppedToken });
  check('reconnect by token returns the same seat', rj.ok && rj.playerId === droppedId, JSON.stringify(rj));
  await until(() => back.priv && back.priv.you, 2000, 'reconnect priv');
  check('reconnected player receives private state again', back.priv.you.id === droppedId);
  // Reconnect by nickname alone (new token lost) also works while offline.
  back.sock.disconnect();
  await until(() => host.state.players.find((p) => p.id === droppedId).connected === false, 2000, 'offline again');
  const back2 = makeClient(url, dropped.nick);
  await back2.connected;
  const rj2 = await back2.emit('room:join', { code, nickname: 'dee' });
  check('reconnect by nickname (case-insensitive) reclaims the seat', rj2.ok && rj2.playerId === droppedId, JSON.stringify(rj2));

  // Let round 2 run out without votes: ties and empty votes count as innocent.
  await until(() => host.state.phase === 'reveal' || host.state.phase === 'scoreboard' || host.state.phase === 'final', 15000, 'round 2 end');
  await until(() => host.state.phase === 'final', 20000, 'final');
  check('final screen names winners', host.state.winners.length >= 1);
  const rev2 = host.state.reveal;
  check('no votes means verdict innocent', rev2 && rev2.verdict === 'innocent');

  // --- privacy audit across all sockets ---
  console.log('\nPrivacy audit (every payload every client received)');
  const allCs = [host, d0, d1, d2, back2];
  check('secret chat never appears on the suspect socket', !suspect.log.some((e) => e.text.includes(SECRET_CHAT)));
  check('secret chat never appears in any public state', !host.log.some((e) => e.ev === 'state' && e.text.includes(SECRET_CHAT)));
  check('"real" clue flag never leaves the server before reveal', !allCs.some((c) => c.log.some((e) => /"real":/.test(e.text))));
  // Per-event: a private payload carrying suspect info must go to the suspect of that round,
  // and evidence must only go to detectives. The suspect rotates, so check each event.
  const privEvents = (c) => c.log.filter((e) => e.ev === 'private').map((e) => JSON.parse(e.text));
  check('suspect status/card only ever sent to the suspect of that round',
    cs.every((c) => privEvents(c).every((p) => p.suspect === null || p.you.isSuspect === true)));
  check('evidence cards only ever sent to detectives',
    cs.every((c) => privEvents(c).every((p) => p.evidence === null || p.you.isSuspect === false)));
  check('the suspect is sent a card in every round they were suspect',
    cs.filter((c) => privEvents(c).some((p) => p.you.isSuspect)).every((c) => privEvents(c).some((p) => p.suspect)));
  check('no truth or card leak in public state before reveal', host.stateHistory.filter((s) => !['reveal', 'scoreboard', 'final'].includes(s.phase)).every((s) => !JSON.stringify(s).includes('"truth"') && !JSON.stringify(s).includes('"verdict"') && s.reveal === null));
  check('the vote list is not in pre-reveal state', host.stateHistory.filter((s) => s.phase !== 'reveal' && s.phase !== 'scoreboard' && s.phase !== 'final').every((s) => !JSON.stringify(s).includes('"votes":')));

  // Play again
  const pa = await host.emit('game:playAgain');
  check('host can play again', pa.ok, pa.error);
  await until(() => host.state.phase === 'lobby', 2000, 'lobby');
  check('scores reset for a new game', host.state.players.every((p) => p.score === 0));

  // Teardown
  for (const c of [...cs, back2]) c.sock.disconnect();
  await srv.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

const watchdog = setTimeout(() => {
  console.error('Simulation hung');
  process.exit(2);
}, 120000);
watchdog.unref();

main().catch((err) => {
  console.error('Simulation crashed:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});
