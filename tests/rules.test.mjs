import test from 'node:test';
import assert from 'node:assert/strict';
import { newGameState } from '../docs/assets/engine.js';
import {
  sideName, recordPosition, repetitionOutcome, noCaptureOutcome, kingCaptureOutcome
} from '../docs/assets/rules.js';

const CFG = { shuffle: 'A1', rule: 'check', level: 'normal' };

function emptyBoard(cfg = CFG) {
  const g = newGameState(cfg);
  for (const p of g.pieces) {
    p.captured = true;
    p.pos = null;
    p.revealed = false;
  }
  return g;
}

function place(g, color, type, r, c) {
  const p = g.pieces.find((q) => q.color === color && q.type === type && q.captured);
  assert.ok(p, `没有可复用的 ${color}${type}`);
  p.captured = false;
  p.pos = { r, c };
  p.revealed = true;
  return p;
}

/** 构造只含重复记录的伪局面 */
function fakeState(seq) {
  const g = { repMap: {}, history: [] };
  for (const e of seq) {
    g.repMap[e.hash] = (g.repMap[e.hash] || 0) + 1;
    g.history.push({ hash: e.hash, checkBy: e.check || null });
  }
  return g;
}

test('sideName 返回中文方名', () => {
  assert.equal(sideName('red'), '红方');
  assert.equal(sideName('black'), '黑方');
});

test('recordPosition 记录局面并在将军规则下标记将军方', () => {
  const g = emptyBoard();
  place(g, 'red', 'K', 9, 4);
  place(g, 'black', 'K', 0, 4);
  place(g, 'red', 'R', 0, 0);
  const { hash, gaveCheck } = recordPosition(g, 'red');
  assert.equal(typeof hash, 'string');
  assert.equal(gaveCheck, 'red');
  assert.equal(g.repMap[hash], 1);
  assert.deepEqual(g.history, [{ hash, checkBy: 'red' }]);
});

test('吃将即胜规则下不标记将军方', () => {
  const g = emptyBoard({ ...CFG, rule: 'kill' });
  place(g, 'red', 'K', 9, 4);
  place(g, 'black', 'K', 0, 4);
  place(g, 'red', 'R', 0, 0);
  assert.equal(recordPosition(g, 'red').gaveCheck, null);
});

test('未满三次重复不判和', () => {
  const g = fakeState([{ hash: 'a' }, { hash: 'b' }]);
  assert.equal(repetitionOutcome(g, 'a'), null);
});

test('三次重复且无长将判和', () => {
  const g = fakeState([{ hash: 'a' }, { hash: 'b' }, { hash: 'a' }, { hash: 'b' }, { hash: 'a' }]);
  const out = repetitionOutcome(g, 'a');
  assert.equal(out.winner, null);
  assert.match(out.reason, /三次重复/);
});

test('三次重复且单方长将判长将方负', () => {
  const g = fakeState([
    { hash: 'a', check: 'red' }, { hash: 'b' },
    { hash: 'a', check: 'red' }, { hash: 'b' },
    { hash: 'a', check: 'red' }
  ]);
  const out = repetitionOutcome(g, 'a');
  assert.equal(out.winner, 'black');
  assert.match(out.reason, /红方长将/);
});

test('120 半回合无吃子才判和', () => {
  assert.equal(noCaptureOutcome({ noCap: 119 }), null);
  const out = noCaptureOutcome({ noCap: 120 });
  assert.equal(out.winner, null);
  assert.match(out.reason, /120 个半回合无吃子/);
});

test('吃掉对方将帅判胜', () => {
  const black = kingCaptureOutcome({ type: 'K', color: 'black' }, 'red');
  assert.equal(black.winner, 'red');
  assert.match(black.reason, /红方吃掉对方将/);
  const red = kingCaptureOutcome({ type: 'K', color: 'red' }, 'black');
  assert.equal(red.winner, 'black');
  assert.match(red.reason, /黑方吃掉对方帅/);
});

test('吃掉己方将帅标记为误吃', () => {
  const out = kingCaptureOutcome({ type: 'K', color: 'red' }, 'red');
  assert.deepEqual(out, { self: true });
});

test('非将帅目标不触发终局判定', () => {
  assert.equal(kingCaptureOutcome({ type: 'P', color: 'red' }, 'black'), null);
  assert.equal(kingCaptureOutcome(null, 'black'), null);
});
