/*
 * 리코셰 로봇 게임 엔진 (클래식 에디션: 대각선/90도 꺾임 장애물 없음)
 * - 브라우저(window.RREngine)와 Node(require) 양쪽에서 같은 코드를 사용합니다.
 * - 보드: 16x16, 중앙 2x2 막힘, 로봇 4대(빨강/초록/파랑/노랑), 목표 17개(16색 + 소용돌이 1)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RREngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 16;
  const N = 1, E = 2, S = 4, W = 8;
  const SIDE = {
    N: { bit: N, dr: -1, dc: 0, opp: S },
    E: { bit: E, dr: 0, dc: 1, opp: W },
    S: { bit: S, dr: 1, dc: 0, opp: N },
    W: { bit: W, dr: 0, dc: -1, opp: E },
  };
  const DIRS = { up: SIDE.N, right: SIDE.E, down: SIDE.S, left: SIDE.W };
  const DIR_KEYS = ['up', 'right', 'down', 'left'];
  const COLORS = ['red', 'green', 'blue', 'yellow'];
  const SHAPES = ['circle', 'triangle', 'square', 'hexagon'];
  const CENTER_CELLS = [7 * 16 + 7, 7 * 16 + 8, 8 * 16 + 7, 8 * 16 + 8];
  const MAX_MOVES = 40;
  const ROTATE_SIDE = { N: 'E', E: 'S', S: 'W', W: 'N' };
  const CORNER_TYPES = [['N', 'E'], ['E', 'S'], ['S', 'W'], ['W', 'N']];

  const idx = (r, c) => r * SIZE + c;

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 벽은 양쪽 칸에 대칭으로 기록
  function addWall(walls, r, c, side) {
    const s = SIDE[side];
    walls[idx(r, c)] |= s.bit;
    const r2 = r + s.dr, c2 = c + s.dc;
    if (r2 >= 0 && r2 < SIZE && c2 >= 0 && c2 < SIZE) walls[idx(r2, c2)] |= s.opp;
  }

  // 보드 전체를 시계방향으로 k번 회전
  function rotate(r, c, side, k) {
    for (let i = 0; i < k; i++) {
      const nr = c, nc = SIZE - 1 - r;
      r = nr; c = nc;
      side = ROTATE_SIDE[side];
    }
    return { r, c, side };
  }

  /*
   * 사분면(8x8) 하나를 "왼쪽 위" 방향 기준으로 생성.
   * 원작 보드 구조를 따름:
   *  - 바깥 테두리(위/왼쪽)에 수직으로 튀어나온 벽 1개씩
   *  - ㄱ자(L자) 코너 벽 4개(소용돌이가 있는 사분면은 5개), 각 코너 칸에 목표물
   */
  function genQuadrant(rng, count) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const walls = [];
      walls.push({ r: 0, c: 1 + Math.floor(rng() * 6), side: 'E' }); // 위쪽 테두리 벽
      walls.push({ r: 1 + Math.floor(rng() * 6), c: 0, side: 'S' }); // 왼쪽 테두리 벽
      const spots = [];
      let tries = 0;
      while (spots.length < count && tries < 400) {
        tries++;
        const r = 1 + Math.floor(rng() * 6);
        const c = 1 + Math.floor(rng() * 6);
        if (r >= 6 && c >= 6) continue; // 중앙 블록 바로 옆 제외
        if (spots.some((s) => Math.abs(s.r - r) < 2 && Math.abs(s.c - c) < 2)) continue; // 코너끼리 붙지 않게
        if (spots.filter((s) => s.r === r).length >= 2) continue;
        if (spots.filter((s) => s.c === c).length >= 2) continue;
        spots.push({ r, c, corner: CORNER_TYPES[Math.floor(rng() * 4)] });
      }
      if (spots.length === count) return { walls, spots };
    }
    throw new Error('quadrant generation failed');
  }

  function generateBoard(rng) {
    rng = rng || Math.random;
    const walls = new Array(SIZE * SIZE).fill(0);
    // 바깥 테두리
    for (let i = 0; i < SIZE; i++) {
      addWall(walls, 0, i, 'N');
      addWall(walls, SIZE - 1, i, 'S');
      addWall(walls, i, 0, 'W');
      addWall(walls, i, SIZE - 1, 'E');
    }
    // 중앙 2x2 블록
    addWall(walls, 7, 7, 'N'); addWall(walls, 7, 7, 'W');
    addWall(walls, 7, 8, 'N'); addWall(walls, 7, 8, 'E');
    addWall(walls, 8, 7, 'S'); addWall(walls, 8, 7, 'W');
    addWall(walls, 8, 8, 'S'); addWall(walls, 8, 8, 'E');

    const vortexQ = Math.floor(rng() * 4);
    const shapeOffset = Math.floor(rng() * 4);
    const targets = [];
    let tid = 0;
    for (let q = 0; q < 4; q++) {
      const quad = genQuadrant(rng, q === vortexQ ? 5 : 4);
      for (const w of quad.walls) {
        const p = rotate(w.r, w.c, w.side, q);
        addWall(walls, p.r, p.c, p.side);
      }
      const colorOrder = shuffle([0, 1, 2, 3], rng);
      quad.spots.forEach((s, i) => {
        for (const side of s.corner) {
          const p = rotate(s.r, s.c, side, q);
          addWall(walls, p.r, p.c, p.side);
        }
        const p = rotate(s.r, s.c, 'N', q);
        if (i < 4) {
          const ci = colorOrder[i];
          // 라틴 방진: 색깔마다 4가지 모양이 정확히 한 번씩
          targets.push({ id: tid++, color: COLORS[ci], shape: SHAPES[(ci + q + shapeOffset) % 4], pos: idx(p.r, p.c) });
        } else {
          targets.push({ id: tid++, color: 'any', shape: 'vortex', pos: idx(p.r, p.c) });
        }
      });
    }
    return { walls, targets };
  }

  function randomRobots(targets, rng) {
    rng = rng || Math.random;
    const forbidden = new Set(CENTER_CELLS.concat(targets.map((t) => t.pos)));
    const robots = [];
    while (robots.length < 4) {
      const p = Math.floor(rng() * SIZE * SIZE);
      if (forbidden.has(p) || robots.includes(p)) continue;
      robots.push(p);
    }
    return robots;
  }

  function randomFreeCell(targets, robots, rng) {
    rng = rng || Math.random;
    const forbidden = new Set(CENTER_CELLS.concat(targets.map((t) => t.pos), robots));
    for (;;) {
      const p = Math.floor(rng() * SIZE * SIZE);
      if (!forbidden.has(p)) return p;
    }
  }

  // 로봇은 벽이나 다른 로봇에 부딪힐 때까지 직진
  function moveRobot(walls, robots, ri, dir) {
    const d = DIRS[dir];
    let pos = robots[ri];
    for (;;) {
      if (walls[pos] & d.bit) break;
      const r = Math.floor(pos / SIZE) + d.dr;
      const c = (pos % SIZE) + d.dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
      const next = r * SIZE + c;
      let blocked = false;
      for (let i = 0; i < robots.length; i++) if (i !== ri && robots[i] === next) { blocked = true; break; }
      if (blocked) break;
      pos = next;
    }
    return pos;
  }

  function isSolved(robots, target) {
    if (!target) return false;
    if (target.color === 'any') return robots.includes(target.pos);
    return robots[COLORS.indexOf(target.color)] === target.pos;
  }

  // 서버 검증용: 해답을 재생해 보고 목표 도달 시점의 수를 반환
  function verifySolution(walls, startRobots, target, moves) {
    if (!Array.isArray(moves) || moves.length === 0 || moves.length > MAX_MOVES) return { ok: false, error: 'invalid' };
    const robots = startRobots.slice();
    const clean = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (!m || !Number.isInteger(m.robot) || m.robot < 0 || m.robot > 3 || !Object.prototype.hasOwnProperty.call(DIRS, m.dir)) {
        return { ok: false, error: 'invalid move' };
      }
      const np = moveRobot(walls, robots, m.robot, m.dir);
      if (np === robots[m.robot]) return { ok: false, error: 'no-op move' };
      robots[m.robot] = np;
      clean.push({ robot: m.robot, dir: m.dir });
      if (isSolved(robots, target)) return { ok: true, count: i + 1, robots, moves: clean };
    }
    return { ok: false, error: 'not solved' };
  }

  // 휴리스틱: 다른 로봇을 무시하고 "직선 위 아무 칸에나 멈출 수 있다"고 가정한 최소 이동 수 (하한값)
  function heuristicMap(walls, targetPos) {
    const h = new Uint8Array(SIZE * SIZE).fill(255);
    h[targetPos] = 0;
    const q = [targetPos];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      for (const k of DIR_KEYS) {
        const d = DIRS[k];
        let p = cur;
        for (;;) {
          if (walls[p] & d.bit) break;
          const r = Math.floor(p / SIZE) + d.dr, c = (p % SIZE) + d.dc;
          if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
          p = r * SIZE + c;
          if (h[p] === 255) { h[p] = h[cur] + 1; q.push(p); }
        }
      }
    }
    return h;
  }

  // 최적해 탐색 (IDA* + 전치표). 시간 제한을 넘기면 count:null
  function solve(walls, start, target, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 20;
    const timeLimit = opts.timeLimitMs || 5000;
    const ttMax = opts.ttMax || 1000000;
    if (isSolved(start, target)) return { count: 0, moves: [] };
    const h = heuristicMap(walls, target.pos);
    const ti = target.color === 'any' ? -1 : COLORS.indexOf(target.color);
    const rb = start.slice();
    const hOf = () => (ti < 0 ? Math.min(h[rb[0]], h[rb[1]], h[rb[2]], h[rb[3]]) : h[rb[ti]]);
    const keyOf = () => {
      let a, b, c, d;
      if (ti < 0) {
        const s = [rb[0], rb[1], rb[2], rb[3]].sort((x, y) => x - y);
        a = s[0]; b = s[1]; c = s[2]; d = s[3];
      } else {
        const o = [];
        for (let i = 0; i < 4; i++) if (i !== ti) o.push(rb[i]);
        o.sort((x, y) => x - y);
        a = rb[ti]; b = o[0]; c = o[1]; d = o[2];
      }
      return ((a * 256 + b) * 256 + c) * 256 + d;
    };
    const deadline = Date.now() + timeLimit;
    const tt = new Map();
    const path = [];
    let nodes = 0, timedOut = false;

    function dfs(depth, limit) {
      if (isSolved(rb, target)) return true;
      const remain = limit - depth;
      if (remain <= 0 || hOf() > remain) return false;
      const key = keyOf();
      const seen = tt.get(key);
      if (seen !== undefined && seen >= remain) return false;
      if (seen !== undefined || tt.size < ttMax) tt.set(key, remain);
      if ((++nodes & 2047) === 0 && Date.now() > deadline) { timedOut = true; return false; }
      for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 4; k++) {
          const np = moveRobot(walls, rb, r, DIR_KEYS[k]);
          if (np === rb[r]) continue;
          const old = rb[r];
          rb[r] = np;
          path.push(r * 4 + k);
          if (dfs(depth + 1, limit)) return true;
          path.pop();
          rb[r] = old;
          if (timedOut) return false;
        }
      }
      return false;
    }

    for (let limit = Math.max(1, hOf()); limit <= maxDepth; limit++) {
      tt.clear();
      if (dfs(0, limit)) {
        return { count: path.length, moves: path.map((m) => ({ robot: m >> 2, dir: DIR_KEYS[m & 3] })) };
      }
      if (timedOut) return { count: null, timedOut: true };
    }
    return { count: null };
  }

  return {
    SIZE, N, E, S, W, DIRS, DIR_KEYS, COLORS, SHAPES, CENTER_CELLS, MAX_MOVES,
    shuffle, generateBoard, randomRobots, randomFreeCell, moveRobot, isSolved, verifySolution, heuristicMap, solve,
  };
});
