import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats, normalizeStats, applyResult, formatDuration, winRate, loadStats, saveStats, STATS_KEY
} from '../docs/assets/stats.js';

function entry(result, extra = {}) {
  return { at: 1763000000000, mode: 'ai', result, moves: 20, ms: 90000, ...extra };
}

test('emptyStats 全为零', () => {
  const s = emptyStats();
  assert.deepEqual(s, { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, best: 0, recent: [] });
});

test('applyResult 累计胜负并维护连胜与最高连胜', () => {
  let s = emptyStats();
  s = applyResult(s, entry('win'));
  s = applyResult(s, entry('win'));
  s = applyResult(s, entry('win'));
  assert.equal(s.games, 3);
  assert.equal(s.wins, 3);
  assert.equal(s.streak, 3);
  assert.equal(s.best, 3);

  s = applyResult(s, entry('loss'));
  assert.equal(s.streak, 0);
  assert.equal(s.best, 3);
  assert.equal(s.losses, 1);

  s = applyResult(s, entry('draw'));
  assert.equal(s.draws, 1);
  assert.equal(s.games, 5);
  assert.equal(s.winRate, undefined);
});

test('applyResult 不修改入参', () => {
  const s = emptyStats();
  const next = applyResult(s, entry('win'));
  assert.equal(s.games, 0);
  assert.notEqual(next, s);
});

test('最近对局按时间倒序且只保留 5 条', () => {
  let s = emptyStats();
  for (let i = 0; i < 7; i++) s = applyResult(s, entry(i % 2 ? 'win' : 'loss', { moves: i }));
  assert.equal(s.recent.length, 5);
  assert.equal(s.recent[0].moves, 6);
  assert.equal(s.recent[4].moves, 2);
});

test('normalizeStats 容错非法数据', () => {
  const s = normalizeStats({ games: '9', wins: -3, draws: 1.8, streak: 2, recent: [null, { result: 'x' }, { result: 'win', mode: 'online' }] });
  assert.equal(s.games, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.draws, 1);
  assert.equal(s.best, 2);
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].mode, 'online');
  assert.deepEqual(normalizeStats(null), emptyStats());
});

test('winRate 计算四舍五入', () => {
  assert.equal(winRate(emptyStats()), 0);
  let s = emptyStats();
  s = applyResult(s, entry('win'));
  s = applyResult(s, entry('win'));
  s = applyResult(s, entry('loss'));
  assert.equal(winRate(s), 67);
});

test('formatDuration 输出 m:ss 与 h:mm:ss', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5), '0:00');
  assert.equal(formatDuration(9500), '0:09');
  assert.equal(formatDuration(61000), '1:01');
  assert.equal(formatDuration(3600000), '1:00:00');
  assert.equal(formatDuration(3661000), '1:01:01');
});

test('load/save 读写 localStorage 兼容对象', () => {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v))
  };
  assert.deepEqual(loadStats(fake), emptyStats());
  const s = applyResult(emptyStats(), entry('win'));
  assert.equal(saveStats(fake, s), true);
  assert.ok(store.get(STATS_KEY).includes('"games":1'));
  assert.deepEqual(loadStats(fake), s);
});

test('loadStats 遇到损坏 JSON 返回空战绩', () => {
  const fake = { getItem: () => 'not-json' };
  assert.deepEqual(loadStats(fake), emptyStats());
});
