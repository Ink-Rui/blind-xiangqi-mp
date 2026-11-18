import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGameState, effType, pseudoMoves, legalTargets, inCheck, hasLegal, operable, pieceAt, pickAIMove,
  AI_LEVELS, aiProfile
} from '../docs/assets/engine.js';

const CFG = { shuffle: 'A1', rule: 'check', level: 'normal' };

/** 清空棋盘，只保留待摆放的棋子（已吃状态可复用） */
function emptyBoard(cfg = CFG) {
  const g = newGameState(cfg);
  for (const p of g.pieces) {
    p.captured = true;
    p.pos = null;
    p.revealed = false;
  }
  return g;
}

/** 把某个棋子摆到指定位置；revealed=false 时按 slotType 决定走法 */
function place(g, color, type, r, c, revealed = true, slotType = type) {
  const p = g.pieces.find((q) => q.color === color && q.type === type && q.captured);
  assert.ok(p, `没有可复用的 ${color}${type}`);
  p.captured = false;
  p.pos = { r, c };
  p.revealed = revealed;
  p.slotType = slotType;
  return p;
}

const has = (list, r, c) => list.some((t) => t.r === r && t.c === c);
const pair = (r, c) => `${r},${c}`;

test('开局 32 子，兵种数量正确且位置互不重叠', () => {
  const g = newGameState(CFG);
  assert.equal(g.pieces.length, 32);
  const expect = { K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5 };
  for (const color of ['red', 'black']) {
    for (const [type, n] of Object.entries(expect)) {
      assert.equal(g.pieces.filter((p) => p.color === color && p.type === type).length, n, `${color}${type}`);
    }
  }
  const occupied = new Set(g.pieces.map((p) => pair(p.pos.r, p.pos.c)));
  assert.equal(occupied.size, 32);
});

test('A1 半盘内洗：将帅在原点，红黑各自守半盘', () => {
  const g = newGameState({ ...CFG, shuffle: 'A1' });
  const redK = g.pieces.find((p) => p.color === 'red' && p.type === 'K');
  const blackK = g.pieces.find((p) => p.color === 'black' && p.type === 'K');
  assert.deepEqual(redK.pos, { r: 9, c: 4 });
  assert.deepEqual(blackK.pos, { r: 0, c: 4 });
  assert.ok(redK.revealed && blackK.revealed);
  assert.ok(g.pieces.filter((p) => p.color === 'red').every((p) => p.pos.r >= 5));
  assert.ok(g.pieces.filter((p) => p.color === 'black').every((p) => p.pos.r <= 4));
});

test('B 全盘洗：32 子全部暗置且位置唯一', () => {
  const g = newGameState({ ...CFG, shuffle: 'B' });
  assert.ok(g.pieces.every((p) => p.revealed === false));
  assert.equal(new Set(g.pieces.map((p) => pair(p.pos.r, p.pos.c))).size, 32);
});

test('暗子按所在格的兵种走法行棋（effType）', () => {
  const g = emptyBoard();
  const p = place(g, 'red', 'P', 5, 4, false, 'N');
  assert.equal(effType(p), 'N');
  assert.equal(legalTargets(g, p).length, 8);
});

test('马腿被挡时对应两个落点消失', () => {
  const g = emptyBoard();
  const n = place(g, 'red', 'N', 5, 4);
  place(g, 'red', 'P', 4, 4);
  const targets = legalTargets(g, n);
  assert.equal(targets.length, 6);
  assert.ok(!has(targets, 3, 3) && !has(targets, 3, 5));
});

test('车不能穿过己方棋子', () => {
  const g = emptyBoard();
  const r = place(g, 'red', 'R', 5, 4);
  place(g, 'red', 'P', 5, 6);
  const targets = legalTargets(g, r);
  assert.ok(has(targets, 5, 5));
  assert.ok(!has(targets, 5, 6));
  assert.ok(!has(targets, 5, 7));
});

test('炮必须隔一个炮架才能吃子', () => {
  const g = emptyBoard();
  const c = place(g, 'red', 'C', 5, 4);
  place(g, 'red', 'P', 5, 5);
  place(g, 'black', 'P', 5, 7);
  const targets = legalTargets(g, c);
  assert.ok(has(targets, 5, 7), '隔屏应能吃子');
  assert.ok(!has(targets, 5, 6), '炮不能落在炮架与目标之间');
  assert.ok(!has(targets, 5, 5), '不能吃己方炮架');
});

test('兵过河后才能横走', () => {
  const g = emptyBoard();
  const before = place(g, 'red', 'P', 6, 4);
  assert.deepEqual(legalTargets(g, before), [{ r: 5, c: 4 }]);
  const after = place(g, 'red', 'P', 4, 4);
  const targets = legalTargets(g, after);
  assert.equal(targets.length, 3);
  assert.ok(has(targets, 3, 4) && has(targets, 4, 3) && has(targets, 4, 5));
});

test('暗置的仕受九宫限制', () => {
  const g = emptyBoard();
  const a = place(g, 'red', 'A', 9, 3, false, 'A');
  const targets = legalTargets(g, a);
  assert.deepEqual(targets, [{ r: 8, c: 4 }]);
});

test('将帅照面视为被将军', () => {
  const g = emptyBoard();
  place(g, 'red', 'K', 9, 4);
  place(g, 'black', 'K', 0, 4);
  assert.ok(inCheck(g, 'red'));
  assert.ok(inCheck(g, 'black'));
});

test('被牵制的棋子不能走出暴露己方将帅的着法', () => {
  const g = emptyBoard();
  place(g, 'red', 'K', 9, 4);
  const blocker = place(g, 'red', 'R', 9, 2);
  place(g, 'black', 'R', 9, 0);
  place(g, 'black', 'K', 0, 0);
  const targets = legalTargets(g, blocker);
  assert.ok(!has(targets, 8, 2), '离开底线会自曝将帅');
  assert.ok(has(targets, 9, 3), '沿底线移动仍可挡将');
});

test('将死局面没有任何合法着法', () => {
  const g = emptyBoard();
  place(g, 'black', 'K', 0, 4);
  place(g, 'red', 'R', 0, 0);
  place(g, 'red', 'R', 1, 0);
  place(g, 'red', 'K', 9, 4);
  assert.ok(inCheck(g, 'black'));
  assert.equal(hasLegal(g, 'black'), false);
});

test('AI 返回的着法必然合法', () => {
  const g = newGameState({ ...CFG, shuffle: 'B', level: 'hard' });
  const move = pickAIMove(g, 'black');
  assert.ok(move, 'AI 应能给出着法');
  assert.ok(legalTargets(g, move.p).some((t) => t.r === move.t.r && t.c === move.t.c));
  assert.ok(operable(g, move.p, 'black'));
  assert.ok(pieceAt(g, move.t) === undefined || pieceAt(g, move.t).color === 'red');
});

test('五档陪练都能给出合法着法', () => {
  assert.deepEqual(AI_LEVELS, ['easy', 'normal', 'hard', 'expert', 'master']);
  for (const level of AI_LEVELS) {
    const g = newGameState({ ...CFG, shuffle: 'A2', level });
    g.turn = 'black';
    const move = pickAIMove(g, 'black');
    assert.ok(move, level + ' 应能给出着法');
    assert.ok(legalTargets(g, move.p).some((t) => t.r === move.t.r && t.c === move.t.c), level + ' 着法应合法');
    assert.ok(operable(g, move.p, 'black'), level + ' 应操作己方棋子');
  }
});

test('难度逐级增强：失误率不升、预判候选不降', () => {
  assert.equal(aiProfile('easy').mode, 'random');
  assert.equal(aiProfile('normal').mode, 'greedy');
  let prevBlunder = Infinity;
  let prevNoise = Infinity;
  let prevBreadth = -1;
  for (const level of ['hard', 'expert', 'master']) {
    const p = aiProfile(level);
    assert.ok(p.blunder <= prevBlunder, level + ' 失误率不应高于上一档');
    assert.ok(p.noise <= prevNoise, level + ' 随机扰动不应高于上一档');
    assert.ok(p.breadth >= prevBreadth, level + ' 预判候选不应少于上一档');
    prevBlunder = p.blunder;
    prevNoise = p.noise;
    prevBreadth = p.breadth;
  }
  assert.equal(aiProfile('unknown').mode, 'score', '未知档位按困难处理');
});
