'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Room, GameError } = require('./room');
const { AVATARS, COLORS, ICONS, POWER_CARDS, MIN_PLAYERS, MAX_PLAYERS } = require('./constants');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, to avoid confusion
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

function newCode(rooms) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function start({ port = 3000, host = '0.0.0.0', timeScale = Number(process.env.TIME_SCALE) || 1 } = {}) {
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  app.disable('x-powered-by');
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/meta', (_req, res) => {
    res.json({
      avatars: AVATARS,
      colors: COLORS,
      icons: ICONS,
      powerCards: POWER_CARDS,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    });
  });

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });
  const rooms = new Map();

  function broadcast(room) {
    io.to(room.code).emit('state', room.publicState());
    for (const p of room.players.values()) {
      if (p.connected && p.socketId) {
        io.to(p.socketId).emit('private', room.privateState(p.id));
      }
    }
  }

  function makeRoom(code) {
    const room = new Room(code, { timeScale, onChange: broadcast });
    rooms.set(code, room);
    return room;
  }

  // Run an action for the socket's player and reply with { ok, error }.
  function act(socket, ack, fn) {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const room = rooms.get(socket.data.code);
      if (!room) throw new GameError('You are not in a room. Refresh and rejoin.');
      const player = room.players.get(socket.data.playerId);
      if (!player || player.socketId !== socket.id) throw new GameError('Your session was replaced. Refresh and rejoin.');
      fn(room, player.id);
      reply({ ok: true });
    } catch (err) {
      if (err instanceof GameError) return reply({ ok: false, error: err.message });
      console.error('[action error]', err);
      reply({ ok: false, error: 'Something went wrong. Please try again.' });
    }
  }

  function clean(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  io.on('connection', (socket) => {
    socket.on('time:sync', (_data, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('room:create', (data = {}, ack) => {
      try {
        const code = newCode(rooms);
        const room = makeRoom(code);
        const player = room.join({ nickname: clean(data.nickname, 40), avatar: data.avatar, color: data.color, socketId: socket.id });
        socket.join(code);
        socket.data.code = code;
        socket.data.playerId = player.id;
        ack({ ok: true, code, playerId: player.id, token: player.token });
        broadcast(room);
      } catch (err) {
        ack({ ok: false, error: err instanceof GameError ? err.message : 'Could not create the room.' });
      }
    });

    socket.on('room:join', (data = {}, ack) => {
      const code = clean(data.code, 8).toUpperCase().replace(/[^A-Z]/g, '');
      const room = rooms.get(code);
      if (!room) return ack && ack({ ok: false, error: `No room with code ${code || '????'}.` });
      try {
        const player = room.join({
          nickname: clean(data.nickname, 40),
          token: clean(data.token, 64),
          avatar: data.avatar,
          color: data.color,
          socketId: socket.id,
        });
        socket.join(code);
        socket.data.code = code;
        socket.data.playerId = player.id;
        clearTimeout(room.emptyTimer);
        ack({ ok: true, code, playerId: player.id, token: player.token });
        broadcast(room);
      } catch (err) {
        ack({ ok: false, error: err instanceof GameError ? err.message : 'Could not join.' });
      }
    });

    socket.on('room:pick', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.pickAppearance(id, { avatar: data.avatar, color: data.color })));

    socket.on('room:settings', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.updateSettings(id, data)));

    socket.on('game:start', (_data, ack) => act(socket, ack, (room, id) => room.start(id)));

    socket.on('game:playAgain', (_data, ack) => act(socket, ack, (room, id) => room.playAgain(id)));

    socket.on('game:question', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.askQuestion(id, clean(data.text, 400), clean(data.followUpOf, 16) || null)));

    socket.on('game:answer', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.submitAnswer(id, clean(data.text, 400))));

    socket.on('game:typing', (data = {}) =>
      act(socket, null, (room, id) => room.setTyping(id, Boolean(data.on))));

    socket.on('game:react', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.react(id, clean(data.answerId, 16), clean(data.icon, 4))));

    socket.on('game:pin', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.pinEvidence(id, clean(data.cardId, 32))));

    socket.on('game:power', (_data, ack) => act(socket, ack, (room, id) => room.usePower(id)));

    socket.on('game:chat', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.sendChat(id, clean(data.text, 400))));

    socket.on('game:vote', (data = {}, ack) =>
      act(socket, ack, (room, id) => room.castVote(id, clean(data.verdict, 16))));

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code);
      if (!room) return;
      room.leave(socket.id);
      if (room.connectedCount === 0) {
        room.emptyTimer = setTimeout(() => {
          if (room.connectedCount === 0) {
            room.clearAllTimers();
            rooms.delete(room.code);
          }
        }, EMPTY_ROOM_TTL_MS);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            for (const room of rooms.values()) room.clearAllTimers();
            io.close(() => done());
          }),
        rooms,
      });
    });
  });
}

module.exports = { start };
