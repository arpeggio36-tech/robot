'use strict';
// 최적해 계산 전용 워커 스레드 (메인 이벤트 루프를 막지 않기 위해 분리)
const { parentPort, workerData } = require('worker_threads');
const E = require('./public/engine.js');

const { walls, robots, target, timeLimitMs } = workerData;
let result;
try {
  result = E.solve(walls, robots, target, { maxDepth: 20, timeLimitMs, ttMax: 800000 });
} catch (e) {
  result = { count: null };
}
parentPort.postMessage(result);
