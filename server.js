'use strict';
/*
 * 리코셰 로봇 온라인 - 멀티플레이 서버
 * Node.js + Express + Socket.IO  (Render Web Service 배포용)
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Worker } = require('worker_threads');
const E = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 30;          // 방 하나당 최대 인원
const DEFAULT_COUNTDOWN = Number(process.env.COUNTDOWN_SECONDS) || 60; // 첫 해답 이후 카운트다운(초)
const REVEAL_SECONDS = Number(process.env.REVEAL_SECONDS) || 10;     // 결과 화면 유지(초)
const SOLVER_TIME_MS = Number(process.env.SOLVER_TIME_MS) || 6000;   // 최적해 계산 시간 제한
const GRACE_MS = 2 * 60 * 1000;      // 연결 끊긴 플레이어 점수 보존 시간
const ROOM_IDLE_MS = 10 * 60 * 1000; // 빈 방 삭제까지 시간
const COUNTDOWN_OPTIONS = [30, 60, 90, 120, 180];

const app = express();
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  pingInterval: 20000,
  pingTimeout: 20000,
});

/** @type {Map<string, any>} */
const rooms = new Map();
const rid = () => crypto.randomBytes(6).toString('hex');

/* ---------------- 유틸 ---------------- */
function cleanName(n) {
  return String(n || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
}
function cleanRoom(r) {
  const s = String(r || '').toUpperCase().replace(/[^A-Z0-9가-힣_-]/g, '').slice(0, 12);
  return s || 'LOBBY';
}
const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);
const playerByPid = (room, pid) => [...room.players.values()].find((p) => p.id === pid);
const targetById = (room, id) => room.board.targets.find((t) => t.id === id);

function uniqueName(room, name, clientId) {
  const taken = (nm) => [...room.players.values()].some((p) => p.clientId !== clientId && p.name === nm);
  let n = name, i = 2;
  while (taken(n)) n = `${name.slice(0, 10)}${i++}`;
  return n;
}

function pushChat(room, player, text) {
  const msg = { name: player ? player.name : null, text: String(text).slice(0, 200), ts: Date.now(), system: !player };
  room.chat.push(msg);
  if (room.chat.length > 60) room.chat.shift();
  io.to(room.code).emit('chat', msg);
}

function clearTimers(room) {
  for (const k of Object.keys(room.timers)) clearTimeout(room.timers[k]);
  room.timers = {};
}

function ensureHost(room) {
  const host = playerByPid(room, room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  room.hostId = next ? next.id : null;
  if (next) pushChat(room, null, `👑 ${next.name}님이 호스트가 되었습니다.`);
}

/* ---------------- 상태 전송 ---------------- */
function snapshot(room) {
  const r = room.round;
  const now = Date.now();
  const bests = r
    ? [...r.solutions.entries()]
        .map(([pid, s]) => ({ id: pid, name: (playerByPid(room, pid) || {}).name || '(나감)', count: s.count, time: s.time }))
        .sort((a, b) => a.count - b.count || a.time - b.time)
    : [];
  return {
    code: room.code,
    phase: room.phase, // lobby | playing | countdown | reveal | gameover
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    boardId: room.boardId,
    walls: room.board.walls,
    targets: room.board.targets,
    robots: room.robots,
    target: room.target,
    roundNum: room.roundNum,
    remaining: room.deck.length,
    totalTargets: room.board.targets.length,
    countdown: room.countdown,
    remainingMs: r && r.deadline && room.phase === 'countdown' ? Math.max(0, r.deadline - now) : null,
    nextInMs: room.phase === 'reveal' && room.revealEndsAt ? Math.max(0, room.revealEndsAt - now) : null,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, chips: p.chips, connected: p.connected })),
    bests,
    skipVotes: r && room.phase === 'playing' ? r.skipVotes.size : 0,
    lastResult: room.phase === 'reveal' || room.phase === 'gameover' ? room.lastResult : null,
  };
}
const broadcast = (room) => io.to(room.code).emit('state', snapshot(room));

/* ---------------- 게임 흐름 ---------------- */
function createRoom(code) {
  const room = {
    code, players: new Map(), hostId: null, phase: 'lobby',
    board: null, boardId: 0, robots: null, deck: [], target: null,
    round: null, roundNum: 0, countdown: DEFAULT_COUNTDOWN,
    timers: {}, lastResult: null, revealEndsAt: null, chat: [], emptySince: null,
  };
  newBoard(room);
  rooms.set(code, room);
  return room;
}

function newBoard(room) {
  clearTimers(room);
  room.board = E.generateBoard();
  room.boardId += 1;
  room.robots = E.randomRobots(room.board.targets);
  room.deck = E.shuffle(room.board.targets.map((t) => t.id));
  room.roundNum = 0;
  room.target = null;
  room.round = null;
  room.lastResult = null;
  room.revealEndsAt = null;
  for (const p of room.players.values()) { p.score = 0; p.chips = []; }
}

function startRound(room) {
  if (!rooms.has(room.code)) return;
  clearTimers(room);
  if (room.deck.length === 0) { room.phase = 'gameover'; broadcast(room); return; }

  // 로봇이 이미 올라가 있지 않은 목표를 선택
  let di = room.deck.findIndex((id) => !room.robots.includes(targetById(room, id).pos));
  if (di < 0) {
    di = 0;
    const t = targetById(room, room.deck[0]);
    const ri = room.robots.indexOf(t.pos);
    room.robots[ri] = E.randomFreeCell(room.board.targets, room.robots);
  }
  const tid = room.deck.splice(di, 1)[0];
  room.target = targetById(room, tid);
  room.roundNum += 1;
  room.round = {
    token: rid(), num: room.roundNum, startRobots: room.robots.slice(),
    solutions: new Map(), deadline: null, skipVotes: new Set(), optimal: null,
  };
  room.phase = 'playing';
  room.lastResult = null;
  room.revealEndsAt = null;
  broadcast(room);

  // 최적해는 별도 스레드에서 계산 (이벤트 루프 차단 방지)
  const token = room.round.token;
  runSolver(room.board.walls, room.round.startRobots, room.target).then((res) => {
    if (!room.round || room.round.token !== token) return;
    room.round.optimal = res;
    if (room.lastResult && room.lastResult.token === token) {
      room.lastResult.optimal = res.count != null ? res : null;
      room.lastResult.optimalPending = false;
      io.to(room.code).emit('optimal', { roundNum: room.lastResult.roundNum, optimal: room.lastResult.optimal });
    }
  });
}

function runSolver(walls, robots, target) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const w = new Worker(path.join(__dirname, 'solverWorker.js'), {
        workerData: { walls, robots, target, timeLimitMs: SOLVER_TIME_MS },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
      });
      w.once('message', finish);
      w.once('error', () => finish({ count: null }));
      w.once('exit', () => finish({ count: null }));
    } catch (e) {
      finish({ count: null });
    }
  });
}

function endRound(room, reason) {
  if (room.phase !== 'playing' && room.phase !== 'countdown') return;
  clearTimers(room);
  const r = room.round;

  let best = null;
  for (const [pid, s] of r.solutions) {
    if (!playerByPid(room, pid)) continue;
    if (!best || s.count < best.count || (s.count === best.count && s.time < best.time)) best = { pid, ...s };
  }

  const result = {
    token: r.token,
    roundNum: r.num,
    target: room.target,
    startRobots: r.startRobots.slice(),
    reason,
    winner: null,
    finalRobots: null,
    optimal: r.optimal && r.optimal.count != null ? r.optimal : null,
    optimalPending: !r.optimal,
  };

  if (best) {
    const p = playerByPid(room, best.pid);
    const v = E.verifySolution(room.board.walls, r.startRobots, room.target, best.moves);
    room.robots = v.robots.slice(); // 클래식 규칙: 로봇은 이동한 자리에 그대로 남음
    p.score += 1;
    p.chips.push({ color: room.target.color, shape: room.target.shape });
    result.winner = { id: p.id, name: p.name, count: best.count, moves: best.moves };
    pushChat(room, null, `🏆 ${p.name}님이 ${best.count}수로 라운드 ${r.num} 승리!`);
  } else {
    pushChat(room, null, `⏭ 라운드 ${r.num}: 해답 없이 넘어갑니다.`);
  }
  result.finalRobots = room.robots.slice();
  room.lastResult = result;
  room.phase = room.deck.length === 0 ? 'gameover' : 'reveal';

  if (room.phase === 'gameover') {
    const ranking = [...room.players.values()].sort((a, b) => b.score - a.score);
    if (ranking[0]) pushChat(room, null, `🎉 게임 종료! 우승: ${ranking[0].name} (${ranking[0].score}칩)`);
  }

  io.to(room.code).emit('roundResult', result);
  if (room.phase === 'reveal') {
    const delay = REVEAL_SECONDS * 1000 + (best ? best.count * 500 + 1200 : 0);
    room.revealEndsAt = Date.now() + delay;
    room.timers.next = setTimeout(() => startRound(room), delay);
  }
  broadcast(room);
}

/* ---------------- 소켓 이벤트 ---------------- */
function ctx(socket) {
  const d = socket.data || {};
  const room = rooms.get(d.code);
  if (!room) return null;
  const p = room.players.get(d.clientId);
  if (!p || p.socketId !== socket.id) return null;
  return { room, p };
}
const isHost = (c) => c && c.room.hostId === c.p.id;

io.on('connection', (socket) => {
  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (socket.data && socket.data.code) return ack({ ok: false, error: '이미 입장한 상태입니다.' });
    const name = cleanName(data && data.name);
    if (!name) return ack({ ok: false, error: '닉네임을 입력하세요.' });
    const code = cleanRoom(data && data.room);
    const clientId = String((data && data.clientId) || '').slice(0, 64) || socket.id;

    const room = rooms.get(code) || createRoom(code);
    let p = room.players.get(clientId);
    const alreadyCounted = p && p.connected;
    if (!alreadyCounted && connectedPlayers(room).length >= MAX_PLAYERS) {
      return ack({ ok: false, error: `방이 가득 찼습니다 (최대 ${MAX_PLAYERS}명). 다른 방 코드를 사용하세요.` });
    }

    if (p) {
      // 재접속 (새로고침/네트워크 끊김)
      const oldSocketId = p.socketId;
      p.socketId = socket.id;
      p.connected = true;
      if (p.removeTimer) { clearTimeout(p.removeTimer); p.removeTimer = null; }
      if (oldSocketId && oldSocketId !== socket.id) {
        const old = io.sockets.sockets.get(oldSocketId);
        if (old) old.disconnect(true);
      }
    } else {
      p = {
        clientId, id: rid(), name: uniqueName(room, name, clientId),
        score: 0, chips: [], connected: true, socketId: socket.id,
        lastChat: 0, lastSubmit: 0, removeTimer: null,
      };
      room.players.set(clientId, p);
      pushChat(room, null, `👋 ${p.name}님이 입장했습니다.`);
    }
    socket.join(code);
    socket.data = { code, clientId };
    room.emptySince = null;
    ensureHost(room);
    ack({ ok: true, you: p.id, name: p.name, room: code, chat: room.chat });
    broadcast(room);
  });

  socket.on('submit', (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const c = ctx(socket);
    if (!c) return ack({ ok: false, error: '입장 정보가 없습니다.' });
    const { room, p } = c;
    if (room.phase !== 'playing' && room.phase !== 'countdown') return ack({ ok: false, error: '지금은 제출할 수 없습니다.' });
    if (!data || data.roundNum !== room.roundNum) return ack({ ok: false, error: '이미 지난 라운드입니다.' });
    const now = Date.now();
    if (now - p.lastSubmit < 300) return ack({ ok: false, error: '너무 빠릅니다.' });
    p.lastSubmit = now;

    const r = room.round;
    const res = E.verifySolution(room.board.walls, r.startRobots, room.target, data.moves);
    if (!res.ok) return ack({ ok: false, error: '유효하지 않은 해답입니다.' });

    const prev = r.solutions.get(p.id);
    if (prev && prev.count <= res.count) return ack({ ok: true, improved: false, count: res.count, best: prev.count });
    r.solutions.set(p.id, { count: res.count, moves: res.moves, time: now });

    if (room.phase === 'playing') {
      room.phase = 'countdown';
      r.deadline = now + room.countdown * 1000;
      room.timers.countdown = setTimeout(() => endRound(room, 'timeout'), room.countdown * 1000);
      pushChat(room, null, `⏱ ${p.name}님이 ${res.count}수 해답 발견! ${room.countdown}초 카운트다운 시작`);
    }
    ack({ ok: true, improved: true, count: res.count });
    broadcast(room);
  });

  socket.on('voteSkip', () => {
    const c = ctx(socket);
    if (!c || c.room.phase !== 'playing') return;
    const { room, p } = c;
    room.round.skipVotes.add(p.id);
    const connectedIds = new Set(connectedPlayers(room).map((x) => x.id));
    const votes = [...room.round.skipVotes].filter((id) => connectedIds.has(id)).length;
    const need = Math.floor(connectedIds.size / 2) + 1;
    if (votes >= need) endRound(room, 'skip');
    else broadcast(room);
  });

  socket.on('startGame', () => {
    const c = ctx(socket);
    if (!isHost(c)) return;
    const { room } = c;
    if (room.phase === 'gameover') newBoard(room);
    if (room.phase !== 'lobby' && room.phase !== 'gameover') return;
    pushChat(room, null, '🚀 게임이 시작되었습니다!');
    startRound(room);
  });

  socket.on('nextRound', () => {
    const c = ctx(socket);
    if (!isHost(c) || c.room.phase !== 'reveal') return;
    startRound(c.room);
  });

  socket.on('endRound', () => {
    const c = ctx(socket);
    if (!isHost(c)) return;
    endRound(c.room, c.room.phase === 'countdown' ? 'host' : 'skip');
  });

  socket.on('resetGame', () => {
    const c = ctx(socket);
    if (!isHost(c)) return;
    newBoard(c.room);
    c.room.phase = 'lobby';
    pushChat(c.room, null, '🔄 호스트가 새 보드로 리셋했습니다.');
    broadcast(c.room);
  });

  socket.on('setCountdown', (sec) => {
    const c = ctx(socket);
    if (!isHost(c)) return;
    const v = Number(sec);
    if (!COUNTDOWN_OPTIONS.includes(v)) return;
    c.room.countdown = v;
    broadcast(c.room);
  });

  socket.on('chat', (text) => {
    const c = ctx(socket);
    if (!c) return;
    const now = Date.now();
    if (now - c.p.lastChat < 700) return;
    const t = String(text || '').trim().slice(0, 200);
    if (!t) return;
    c.p.lastChat = now;
    pushChat(c.room, c.p, t);
  });

  socket.on('disconnect', () => {
    const c = ctx(socket);
    if (!c) return;
    const { room, p } = c;
    p.connected = false;
    p.socketId = null;
    pushChat(room, null, `🚪 ${p.name}님이 나갔습니다.`);
    p.removeTimer = setTimeout(() => {
      if (p.connected) return;
      room.players.delete(p.clientId);
      if (rooms.has(room.code)) broadcast(room);
    }, GRACE_MS);
    ensureHost(room);
    broadcast(room);
  });
});

// 빈 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (connectedPlayers(room).length > 0) { room.emptySince = null; continue; }
    if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > ROOM_IDLE_MS) {
      clearTimers(room);
      for (const p of room.players.values()) if (p.removeTimer) clearTimeout(p.removeTimer);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Ricochet Robots server listening on :${PORT} (max ${MAX_PLAYERS} players/room)`);
});
