(() => {
  'use strict';
  const E = window.RREngine;
  const $ = (s) => document.querySelector(s);

  const COLOR_HEX = { red: '#e53935', green: '#2e9e48', blue: '#1e6fd9', yellow: '#f2b705' };
  const COLOR_KO = { red: '빨강', green: '초록', blue: '파랑', yellow: '노랑', any: '아무 로봇' };
  const SHAPE_KO = { circle: '원', triangle: '삼각형', square: '사각형', hexagon: '육각형', vortex: '소용돌이' };
  const DIR_ARROW = { up: '↑', right: '→', down: '↓', left: '←' };
  const ROBOT_KO = ['빨강', '초록', '파랑', '노랑'];
  const ACTIVE = (ph) => ph === 'playing' || ph === 'countdown';

  /* ---------- 접속 정보 ---------- */
  function getClientId() {
    let id = sessionStorage.getItem('rr_cid'); // 탭마다 별도 → 새로고침해도 점수 유지
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('rr_cid', id);
    }
    return id;
  }
  const clientId = getClientId();
  const socket = io();

  let joined = false, joinInfo = null, me = null;
  let S = null;                 // 서버 상태 스냅샷
  let builtBoardId = null;
  const local = { roundNum: -1, robots: [], history: [], selected: 0 };
  let animating = false, animToken = 0;
  let deadlineLocal = null, nextLocal = null;
  let gameOverShownFor = null;
  let robotEls = [], markerEls = [], targetCellEls = {}, centerEl = null, destLayer = null;

  /* ---------- 유틸 ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function shapeSVG(shape, color) {
    const fill = COLOR_HEX[color] || '#888';
    const st = 'stroke="rgba(0,0,0,.35)" stroke-width="3"';
    let inner = '';
    switch (shape) {
      case 'circle': inner = `<circle cx="50" cy="50" r="31" fill="${fill}" ${st}/>`; break;
      case 'triangle': inner = `<polygon points="50,14 87,81 13,81" fill="${fill}" ${st}/>`; break;
      case 'square': inner = `<rect x="19" y="19" width="62" height="62" rx="7" fill="${fill}" ${st}/>`; break;
      case 'hexagon': inner = `<polygon points="50,13 82,31.5 82,68.5 50,87 18,68.5 18,31.5" fill="${fill}" ${st}/>`; break;
      case 'vortex':
        inner = `<path d="M50 50 L50 13 A37 37 0 0 1 87 50 Z" fill="${COLOR_HEX.red}"/>
          <path d="M50 50 L87 50 A37 37 0 0 1 50 87 Z" fill="${COLOR_HEX.green}"/>
          <path d="M50 50 L50 87 A37 37 0 0 1 13 50 Z" fill="${COLOR_HEX.blue}"/>
          <path d="M50 50 L13 50 A37 37 0 0 1 50 13 Z" fill="${COLOR_HEX.yellow}"/>
          <circle cx="50" cy="50" r="37" fill="none" ${st}/><circle cx="50" cy="50" r="10" fill="#fff"/>`;
        break;
    }
    return `<svg viewBox="0 0 100 100" class="shape" aria-hidden="true">${inner}</svg>`;
  }
  const targetLabel = (t) => (t ? `${COLOR_KO[t.color]} ${SHAPE_KO[t.shape]}` : '-');
  const pct = (n) => `${n * 6.25}%`;
  const myBest = () => { const b = S && S.bests.find((x) => x.id === me); return b ? b.count : null; };
  const isHost = () => S && S.hostId === me;
  const solvedNow = () => S && S.target && local.history.length > 0 && E.isSolved(local.robots, S.target);
  const canPlay = () => S && ACTIVE(S.phase) && !animating && local.roundNum === S.roundNum && !solvedNow();

  /* ---------- 입장 ---------- */
  const params = new URLSearchParams(location.search);
  $('#nameInput').value = localStorage.getItem('rr_name') || '';
  $('#roomInput').value = params.get('room') || localStorage.getItem('rr_room') || '';

  function doJoin() {
    const name = $('#nameInput').value.trim();
    const room = $('#roomInput').value.trim() || 'LOBBY';
    if (!name) { $('#joinError').textContent = '닉네임을 입력하세요.'; return; }
    localStorage.setItem('rr_name', name);
    localStorage.setItem('rr_room', room);
    $('#joinBtn').disabled = true;
    socket.emit('join', { name, room, clientId }, (res) => {
      $('#joinBtn').disabled = false;
      if (!res || !res.ok) { $('#joinError').textContent = (res && res.error) || '입장에 실패했습니다.'; return; }
      joined = true;
      joinInfo = { name, room };
      me = res.you;
      $('#joinScreen').classList.add('hidden');
      $('#gameScreen').classList.remove('hidden');
      $('#chatLog').innerHTML = '';
      (res.chat || []).forEach(addChat);
      history.replaceState(null, '', `?room=${encodeURIComponent(res.room)}`);
    });
  }
  $('#joinBtn').addEventListener('click', doJoin);
  ['#nameInput', '#roomInput'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); }));

  socket.on('connect', () => {
    setConn(true);
    if (joined && joinInfo) {
      socket.emit('join', { ...joinInfo, clientId }, (res) => {
        if (res && res.ok) { me = res.you; $('#chatLog').innerHTML = ''; (res.chat || []).forEach(addChat); }
        else toast((res && res.error) || '재접속 실패');
      });
    }
  });
  socket.on('disconnect', () => setConn(false));
  function setConn(ok) {
    const p = $('#connPill');
    p.textContent = ok ? '● 연결됨' : '● 연결 끊김 - 재접속 중…';
    p.classList.toggle('bad', !ok);
  }

  /* ---------- 보드 구성 ---------- */
  function buildBoard() {
    const board = $('#board');
    board.innerHTML = '';
    targetCellEls = {};
    const cells = [];
    for (let i = 0; i < 256; i++) {
      const c = el('div', 'cell');
      if (E.CENTER_CELLS.includes(i)) c.classList.add('center-cell');
      cells.push(c);
      board.appendChild(c);
    }
    for (const t of S.targets) {
      cells[t.pos].innerHTML = shapeSVG(t.shape, t.color);
      targetCellEls[t.id] = cells[t.pos];
    }
    // 벽 (윗변/왼변만 그리면 대칭이므로 전부 표현됨)
    for (let i = 0; i < 256; i++) {
      const r = i >> 4, c = i & 15, w = S.walls[i];
      if ((w & E.N) && r > 0) {
        const wall = el('div', 'wall h');
        wall.style.left = `calc(${pct(c)} - 0.55%)`;
        wall.style.top = `calc(${pct(r)} - 0.55%)`;
        board.appendChild(wall);
      }
      if ((w & E.W) && c > 0) {
        const wall = el('div', 'wall v');
        wall.style.left = `calc(${pct(c)} - 0.55%)`;
        wall.style.top = `calc(${pct(r)} - 0.55%)`;
        board.appendChild(wall);
      }
    }
    centerEl = el('div', 'center-block');
    board.appendChild(centerEl);

    markerEls = [0, 1, 2, 3].map((i) => {
      const m = el('div', 'start-marker');
      m.style.color = COLOR_HEX[E.COLORS[i]];
      board.appendChild(m);
      return m;
    });
    destLayer = el('div', 'dest-layer');
    board.appendChild(destLayer);

    robotEls = [0, 1, 2, 3].map((i) => {
      const r = el('div', 'robot');
      r.dataset.ri = i;
      const body = el('div', 'body', String(i + 1));
      body.style.background = COLOR_HEX[E.COLORS[i]];
      r.appendChild(body);
      r.addEventListener('click', (e) => { e.stopPropagation(); select(i); });
      board.appendChild(r);
      return r;
    });
    builtBoardId = S.boardId;
  }

  function renderTargetsOnBoard() {
    const active = S && ACTIVE(S.phase) && S.target;
    for (const t of S.targets) {
      const c = targetCellEls[t.id];
      if (!c) continue;
      c.classList.toggle('active', !!(S.target && S.target.id === t.id && S.phase !== 'lobby'));
      c.classList.toggle('dim', !!(active && S.target.id !== t.id));
    }
    centerEl.innerHTML = S.target && S.phase !== 'lobby' ? shapeSVG(S.target.shape, S.target.color) : '';
  }

  function renderRobots() {
    if (!robotEls.length) return;
    const play = canPlay();
    robotEls.forEach((r, i) => {
      const p = local.robots[i];
      if (p == null) return;
      r.style.left = pct(p & 15);
      r.style.top = pct(p >> 4);
      r.classList.toggle('selected', i === local.selected && play);
    });
    // 라운드 시작 위치 표시
    const start = S && ACTIVE(S.phase) ? S.robots : null;
    markerEls.forEach((m, i) => {
      const show = start && start[i] !== local.robots[i];
      m.classList.toggle('hidden', !show);
      if (show) { m.style.left = pct(start[i] & 15); m.style.top = pct(start[i] >> 4); }
    });
    renderDest();
    renderRobotBtns();
  }

  // 선택된 로봇이 갈 수 있는 4방향 도착점 + 경로 표시
  function renderDest() {
    if (!destLayer) return;
    destLayer.innerHTML = '';
    if (!canPlay()) return;
    const ri = local.selected;
    const from = local.robots[ri];
    const color = COLOR_HEX[E.COLORS[ri]];
    for (const dir of E.DIR_KEYS) {
      const to = E.moveRobot(S.walls, local.robots, ri, dir);
      if (to === from) continue;
      const r1 = from >> 4, c1 = from & 15, r2 = to >> 4, c2 = to & 15;
      const track = el('div', 'track');
      track.style.background = color;
      if (r1 === r2) {
        track.style.left = `calc(${pct(Math.min(c1, c2))} + 3.125%)`;
        track.style.width = pct(Math.abs(c2 - c1));
        track.style.top = `calc(${pct(r1)} + 2.4%)`;
        track.style.height = '1.45%';
      } else {
        track.style.top = `calc(${pct(Math.min(r1, r2))} + 3.125%)`;
        track.style.height = pct(Math.abs(r2 - r1));
        track.style.left = `calc(${pct(c1)} + 2.4%)`;
        track.style.width = '1.45%';
      }
      track.addEventListener('click', (e) => { e.stopPropagation(); doMove(ri, dir); });
      destLayer.appendChild(track);

      const d = el('div', 'dest');
      d.style.left = pct(c2);
      d.style.top = pct(r2);
      const s = el('span', null, DIR_ARROW[dir]);
      s.style.background = color;
      d.appendChild(s);
      d.addEventListener('click', (e) => { e.stopPropagation(); doMove(ri, dir); });
      destLayer.appendChild(d);
    }
  }

  function renderRobotBtns() {
    const wrap = $('#robotBtns');
    if (!wrap.children.length) {
      E.COLORS.forEach((c, i) => {
        const b = el('button', 'robot-btn', `${i + 1} ${ROBOT_KO[i]}`);
        b.style.setProperty('--c', COLOR_HEX[c]);
        b.addEventListener('click', () => select(i));
        wrap.appendChild(b);
      });
    }
    [...wrap.children].forEach((b, i) => b.classList.toggle('selected', i === local.selected));
  }

  /* ---------- 조작 ---------- */
  function select(i) {
    local.selected = i;
    renderRobots();
  }

  function doMove(ri, dir) {
    if (!canPlay()) {
      if (S && ACTIVE(S.phase) && solvedNow()) toast('이미 목표에 도착했어요. 되돌리기/처음으로를 눌러 다시 시도하세요.');
      return;
    }
    local.selected = ri;
    const np = E.moveRobot(S.walls, local.robots, ri, dir);
    if (np === local.robots[ri]) {
      const r = robotEls[ri];
      r.classList.remove('bump'); void r.offsetWidth; r.classList.add('bump');
      return;
    }
    local.robots[ri] = np;
    local.history.push({ robot: ri, dir });
    renderRobots();
    renderMoveInfo();
    if (solvedNow()) onSolved();
  }

  function undo() {
    if (!S || !ACTIVE(S.phase) || animating || !local.history.length) return;
    local.history.pop();
    replayLocal();
  }
  function resetLocal() {
    if (!S || !ACTIVE(S.phase) || animating) return;
    local.history = [];
    replayLocal();
  }
  function replayLocal() {
    const rb = S.robots.slice();
    for (const m of local.history) rb[m.robot] = E.moveRobot(S.walls, rb, m.robot, m.dir);
    local.robots = rb;
    renderRobots();
    renderMoveInfo();
  }

  function onSolved() {
    const count = local.history.length;
    const best = myBest();
    if (best != null && count >= best) {
      toast(`목표 도착! (${count}수) 하지만 내 기록 ${best}수보다 짧아야 제출됩니다.`);
      renderMoveInfo();
      return;
    }
    socket.emit('submit', { roundNum: local.roundNum, moves: local.history }, (res) => {
      if (!res) return;
      if (!res.ok) toast(`제출 실패: ${res.error}`);
      else if (res.improved) toast(`✅ ${res.count}수 해답 제출 완료! 더 짧은 해답에 도전해 보세요.`);
      else toast(`이미 ${res.best}수 기록이 있어요.`);
    });
    renderMoveInfo();
  }

  document.querySelectorAll('.dpad button').forEach((b) => b.addEventListener('click', () => doMove(local.selected, b.dataset.dir)));
  $('#undoBtn').addEventListener('click', undo);
  $('#resetBtn').addEventListener('click', resetLocal);

  document.addEventListener('keydown', (e) => {
    if (!joined) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const dirMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
    const k = e.key;
    if (dirMap[k]) { e.preventDefault(); doMove(local.selected, dirMap[k]); return; }
    if (['1', '2', '3', '4'].includes(k)) { select(Number(k) - 1); return; }
    const colorKey = { r: 0, g: 1, b: 2, y: 3, R: 0, G: 1, B: 2, Y: 3 };
    if (k in colorKey) { select(colorKey[k]); return; }
    if (k === 'Tab') { e.preventDefault(); select((local.selected + (e.shiftKey ? 3 : 1)) % 4); return; }
    if (k === 'z' || k === 'Z' || k === 'Backspace') { e.preventDefault(); undo(); return; }
    if (k === 'Escape') { resetLocal(); }
  });

  // 모바일 스와이프
  let touch = null;
  $('#board').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const robot = e.target.closest && e.target.closest('.robot');
    touch = { x: t.clientX, y: t.clientY, ri: robot ? Number(robot.dataset.ri) : null };
  }, { passive: true });
  $('#board').addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    const ri = touch.ri != null ? touch.ri : local.selected;
    touch = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return; // 짧은 터치는 click 처리
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    local.selected = ri;
    doMove(ri, dir);
  });

  /* ---------- 서버 이벤트 ---------- */
  socket.on('state', (state) => {
    S = state;
    if (S.boardId !== builtBoardId) {
      buildBoard();
      local.roundNum = -1;
      if (!ACTIVE(S.phase)) local.history = [];
    }
    if (ACTIVE(S.phase) && S.roundNum !== local.roundNum) {
      // 새 라운드 시작
      animToken++;
      animating = false;
      local.roundNum = S.roundNum;
      local.robots = S.robots.slice();
      local.history = [];
      hideBanner();
      closeOverlay();
    } else if (!ACTIVE(S.phase) && !animating) {
      local.robots = S.robots.slice();
      if (S.phase === 'lobby') local.history = [];
    }
    deadlineLocal = S.remainingMs != null ? Date.now() + S.remainingMs : null;
    nextLocal = S.nextInMs != null ? Date.now() + S.nextInMs : null;
    renderAll();
    maybeShowGameOver();
  });

  socket.on('roundResult', async (res) => {
    if (res.winner) showBanner(`🏆 ${res.winner.name}님 ${res.winner.count}수 승리!`);
    else showBanner('⏭ 해답 없이 넘어갑니다');
    if (res.winner) {
      await playSolution(res.startRobots, res.winner.moves, res.finalRobots);
    } else {
      local.robots = res.finalRobots.slice();
      renderRobots();
    }
    setTimeout(hideBanner, 2500);
    maybeShowGameOver();
  });

  socket.on('optimal', (data) => {
    if (S && S.lastResult && S.lastResult.roundNum === data.roundNum) {
      S.lastResult.optimal = data.optimal;
      S.lastResult.optimalPending = false;
      renderResultPanel();
    }
  });

  socket.on('chat', addChat);

  async function playSolution(start, moves, finalRobots) {
    const token = ++animToken;
    animating = true;
    local.robots = start.slice();
    local.history = [];
    renderRobots();
    renderMoveInfo();
    await sleep(500);
    for (const m of moves) {
      if (token !== animToken) return;
      local.robots[m.robot] = E.moveRobot(S.walls, local.robots, m.robot, m.dir);
      local.history.push(m);
      renderRobots();
      renderMoveInfo();
      await sleep(480);
    }
    if (token !== animToken) return;
    await sleep(500);
    animating = false;
    if (finalRobots) local.robots = finalRobots.slice();
    renderAll();
  }

  /* ---------- 렌더링 ---------- */
  function renderAll() {
    if (!S) return;
    renderTopbar();
    renderStatus();
    renderTargetPanel();
    renderTargetsOnBoard();
    renderHostPanel();
    renderBests();
    renderScores();
    renderResultPanel();
    renderRobots();
    renderMoveInfo();
  }

  function renderTopbar() {
    const conn = S.players.filter((p) => p.connected).length;
    $('#roomPill').textContent = `방: ${S.code}`;
    $('#playerPill').textContent = `👥 ${conn}/${S.maxPlayers}`;
    const used = S.totalTargets - S.remaining;
    $('#roundPill').textContent = S.roundNum ? `라운드 ${S.roundNum} · 칩 ${used}/${S.totalTargets}` : '게임 대기';
  }

  function renderStatus() {
    const bar = $('#statusBar');
    bar.className = 'status-bar ' + S.phase;
    const hostName = (S.players.find((p) => p.id === S.hostId) || {}).name || '-';
    switch (S.phase) {
      case 'lobby':
        bar.textContent = isHost() ? '👑 준비되면 오른쪽 호스트 메뉴에서 [게임 시작]을 누르세요.' : `호스트(${hostName})가 게임을 시작하길 기다리는 중…`;
        break;
      case 'playing':
        bar.textContent = '🎯 목표 칸에 로봇을 멈춰 세우세요! 첫 해답이 나오면 카운트다운이 시작됩니다.';
        break;
      case 'countdown':
        bar.textContent = '⏱ 카운트다운 중! 더 적은 수의 해답을 찾아보세요.';
        break;
      case 'reveal':
        bar.textContent = '📣 라운드 결과 — 잠시 후 다음 라운드가 시작됩니다.';
        break;
      case 'gameover':
        bar.textContent = '🎉 게임 종료! 최종 순위를 확인하세요.';
        break;
    }
  }

  function renderTargetPanel() {
    const show = S.target && S.phase !== 'lobby';
    $('#targetBig').innerHTML = show ? shapeSVG(S.target.shape, S.target.color) : '<div class="placeholder">?</div>';
    $('#targetName').textContent = show ? targetLabel(S.target) : '대기 중';
    updateTimer();
  }

  function updateTimer() {
    const t = $('#timer');
    if (!S) return;
    if (S.phase === 'countdown' && deadlineLocal) {
      const sec = Math.max(0, Math.ceil((deadlineLocal - Date.now()) / 1000));
      t.textContent = `⏱ ${sec}초`;
      t.className = 'timer' + (sec <= 10 ? ' urgent' : '');
    } else if (S.phase === 'reveal' && nextLocal) {
      const sec = Math.max(0, Math.ceil((nextLocal - Date.now()) / 1000));
      t.textContent = `다음 라운드까지 ${sec}초`;
      t.className = 'timer soft';
    } else if (S.phase === 'playing') {
      t.textContent = '해답 대기 중';
      t.className = 'timer soft';
    } else {
      t.textContent = '';
      t.className = 'timer';
    }
  }
  setInterval(updateTimer, 250);

  function renderHostPanel() {
    const panel = $('#hostPanel');
    panel.classList.toggle('hidden', !isHost());
    if (!isHost()) return;
    const ph = S.phase;
    $('#startBtn').classList.toggle('hidden', !(ph === 'lobby' || ph === 'gameover'));
    $('#startBtn').textContent = ph === 'gameover' ? '새 게임 시작' : '게임 시작';
    $('#nextBtn').classList.toggle('hidden', ph !== 'reveal');
    $('#endBtn').classList.toggle('hidden', !ACTIVE(ph));
    $('#endBtn').textContent = ph === 'countdown' ? '지금 종료 (최고 기록 승리)' : '이 목표 건너뛰기';
    $('#countdownSel').value = String(S.countdown);
  }
  $('#startBtn').addEventListener('click', () => socket.emit('startGame'));
  $('#nextBtn').addEventListener('click', () => socket.emit('nextRound'));
  $('#endBtn').addEventListener('click', () => socket.emit('endRound'));
  $('#newBoardBtn').addEventListener('click', () => {
    if (confirm('새 보드로 리셋할까요? 모든 점수가 초기화됩니다.')) socket.emit('resetGame');
  });
  $('#countdownSel').addEventListener('change', (e) => socket.emit('setCountdown', Number(e.target.value)));

  function renderBests() {
    const ol = $('#bestList');
    ol.innerHTML = '';
    if (!S.bests.length) {
      ol.appendChild(el('li', 'empty', ACTIVE(S.phase) ? '아직 제출된 해답이 없습니다.' : '-'));
    }
    S.bests.forEach((b, i) => {
      const li = el('li', b.id === me ? 'me' : '');
      li.appendChild(el('span', 'rank', `${i + 1}`));
      li.appendChild(el('span', 'name', b.name + (b.id === me ? ' (나)' : '')));
      li.appendChild(el('span', 'val', `${b.count}수`));
      ol.appendChild(li);
    });
    const skip = $('#skipBtn');
    const conn = S.players.filter((p) => p.connected).length;
    const need = Math.floor(conn / 2) + 1;
    skip.classList.toggle('hidden', S.phase !== 'playing');
    skip.textContent = `🙋 건너뛰기 투표 (${S.skipVotes}/${need})`;
  }
  $('#skipBtn').addEventListener('click', () => { socket.emit('voteSkip'); toast('건너뛰기에 투표했습니다.'); });

  function renderScores() {
    const ol = $('#scoreList');
    ol.innerHTML = '';
    const players = S.players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    players.forEach((p, i) => {
      const li = el('li', (p.id === me ? 'me ' : '') + (p.connected ? '' : 'offline'));
      li.appendChild(el('span', 'rank', `${i + 1}`));
      const name = el('span', 'name', (p.id === S.hostId ? '👑 ' : '') + p.name + (p.id === me ? ' (나)' : '') + (p.connected ? '' : ' · 오프라인'));
      li.appendChild(name);
      const chips = el('span', 'chips');
      chips.innerHTML = p.chips.map((c) => shapeSVG(c.shape, c.color)).join('');
      li.appendChild(chips);
      li.appendChild(el('span', 'val', `${p.score}`));
      ol.appendChild(li);
    });
  }

  function renderResultPanel() {
    const panel = $('#resultPanel');
    const lr = S && S.lastResult;
    if (!lr) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '';
    panel.appendChild(el('h3', null, `📣 라운드 ${lr.roundNum} 결과`));
    const p1 = el('p', 'result-line');
    p1.textContent = lr.winner ? `🏆 ${lr.winner.name} — ${lr.winner.count}수` : '아무도 풀지 못했습니다.';
    panel.appendChild(p1);
    const p2 = el('p', 'result-line soft');
    if (lr.optimal) p2.textContent = `🤖 컴퓨터 최적해: ${lr.optimal.count}수` + (lr.winner && lr.winner.count === lr.optimal.count ? ' (최적해 달성! 👏)' : '');
    else if (lr.optimalPending) p2.textContent = '🤖 최적해 계산 중…';
    else p2.textContent = '🤖 최적해: 계산 시간 초과(매우 어려운 문제)';
    panel.appendChild(p2);
    const row = el('div', 'btn-row');
    if (lr.winner) {
      const b = el('button', null, '▶ 우승 해답 다시보기');
      b.addEventListener('click', () => { if (!animating) playSolution(lr.startRobots, lr.winner.moves, lr.finalRobots); });
      row.appendChild(b);
    }
    if (lr.optimal && lr.optimal.moves && lr.optimal.moves.length) {
      const b = el('button', null, '▶ 최적해 보기');
      b.addEventListener('click', () => { if (!animating) playSolution(lr.startRobots, lr.optimal.moves, lr.finalRobots); });
      row.appendChild(b);
    }
    panel.appendChild(row);
  }

  function renderMoveInfo() {
    const box = $('#moveInfo');
    box.innerHTML = '';
    const head = el('div', 'move-head');
    const label = animating ? '재생 중' : (ACTIVE(S && S.phase) ? '내 이동' : '이동 기록');
    head.appendChild(el('b', null, `${label}: ${local.history.length}수`));
    const best = myBest();
    if (ACTIVE(S && S.phase) && best != null) head.appendChild(el('span', 'soft', ` · 내 최고 기록 ${best}수`));
    if (ACTIVE(S && S.phase) && !animating && solvedNow()) head.appendChild(el('span', 'ok', ' · 🎉 목표 도착!'));
    box.appendChild(head);
    const list = el('div', 'move-list');
    local.history.forEach((m, i) => {
      const chip = el('span', 'move-chip', `${i + 1}. ${DIR_ARROW[m.dir]}`);
      chip.style.background = COLOR_HEX[E.COLORS[m.robot]];
      list.appendChild(chip);
    });
    box.appendChild(list);
  }

  /* ---------- 배너 / 오버레이 / 채팅 ---------- */
  function showBanner(text) { const b = $('#banner'); b.textContent = text; b.classList.remove('hidden'); }
  function hideBanner() { $('#banner').classList.add('hidden'); }
  function closeOverlay() { $('#overlay').classList.add('hidden'); }

  function maybeShowGameOver() {
    if (!S || S.phase !== 'gameover' || animating || gameOverShownFor === S.boardId) return;
    gameOverShownFor = S.boardId;
    const card = $('#overlayCard');
    card.innerHTML = '';
    card.appendChild(el('h2', null, '🎉 게임 종료!'));
    const ol = el('ol', 'final-list');
    const medals = ['🥇', '🥈', '🥉'];
    S.players.slice().sort((a, b) => b.score - a.score).forEach((p, i) => {
      const li = el('li', p.id === me ? 'me' : '');
      li.appendChild(el('span', 'rank', medals[i] || `${i + 1}`));
      li.appendChild(el('span', 'name', p.name));
      li.appendChild(el('span', 'val', `${p.score}칩`));
      ol.appendChild(li);
    });
    card.appendChild(ol);
    const row = el('div', 'btn-row');
    if (isHost()) {
      const b = el('button', 'primary', '새 게임 시작');
      b.addEventListener('click', () => { socket.emit('startGame'); closeOverlay(); });
      row.appendChild(b);
    }
    const c = el('button', null, '닫기');
    c.addEventListener('click', closeOverlay);
    row.appendChild(c);
    card.appendChild(row);
    $('#overlay').classList.remove('hidden');
  }

  function addChat(m) {
    const log = $('#chatLog');
    const line = el('div', 'chat-line' + (m.system ? ' system' : ''));
    if (m.system) line.textContent = m.text;
    else {
      line.appendChild(el('b', null, m.name + ': '));
      line.appendChild(document.createTextNode(m.text));
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(line);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (!v) return;
    socket.emit('chat', v);
    $('#chatInput').value = '';
  });
})();
