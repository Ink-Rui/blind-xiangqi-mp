import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAME_KEY, CLIENT_KEY, DEFAULT_NAME, NAME_MAX,
  normalizeName, loadName, saveName, loadClientId,
  scoreOf, rankScore, makeEntry, compareEntries, betterEntry, sortEntries
} from '../docs/assets/leaderboard.js';

function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    dump: () => Object.fromEntries(map)
  };
}

test('昵称清洗：去敏感字符、压缩空白、限长、空值回退', () => {
  assert.equal(normalizeName('  盲  侠  '), '盲 侠');
  assert.equal(normalizeName('<b>小明</b>'), 'b小明/b');
  assert.equal(normalizeName(''), DEFAULT_NAME);
  assert.equal(normalizeName(null), DEFAULT_NAME);
  assert.equal(normalizeName('一'.repeat(NAME_MAX + 5)).length, NAME_MAX);
});

test('昵称本地保存与读取', () => {
  const s = fakeStorage();
  assert.equal(loadName(s), DEFAULT_NAME);
  assert.equal(saveName(s, ' 棋 圣 '), '棋 圣');
  assert.equal(s.dump()[NAME_KEY], '棋 圣');
  assert.equal(loadName(s), '棋 圣');
});

test('客户端身份持久化，重复读取不变', () => {
  const s = fakeStorage();
  const id = loadClientId(s);
  assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  assert.equal(loadClientId(s), id);
  assert.equal(s.dump()[CLIENT_KEY], id);
});

test('成绩分值与提交行：胜 3 / 和 1 / 负 0', () => {
  assert.equal(scoreOf('win'), 3);
  assert.equal(scoreOf('draw'), 1);
  assert.equal(scoreOf('loss'), 0);
  assert.deepEqual(makeEntry('win', 23, 65000), {
    result: 'win', score: 3, moves: 23, ms: 65000, rank_score: 3976934
  });
  assert.deepEqual(makeEntry('weird', -1, NaN), {
    result: 'loss', score: 0, moves: 0, ms: 0, rank_score: 0
  });
});

test('排序分：胜越快越高，和/负撑得越久越高', () => {
  const fastWin = rankScore({ result: 'win', score: 3, moves: 20, ms: 60000 });
  const slowWin = rankScore({ result: 'win', score: 3, moves: 40, ms: 60000 });
  const shortLoss = rankScore({ result: 'loss', score: 0, moves: 5, ms: 10000 });
  const longLoss = rankScore({ result: 'loss', score: 0, moves: 50, ms: 100000 });
  const draw = rankScore({ result: 'draw', score: 1, moves: 30, ms: 60000 });
  assert.ok(fastWin > slowWin, '同用时下，手数少的胜局更高');
  assert.ok(longLoss > shortLoss, '负局撑得越久越高');
  assert.ok(slowWin > draw && draw > longLoss, '胜 > 和 > 负');
  assert.ok(rankScore({ result: 'win', score: 3, moves: 30, ms: 1 }) <= 3000000 + 999999);
  assert.ok(rankScore({ result: 'draw', score: 1, moves: 9999, ms: 99999999 }) > rankScore({ result: 'loss', score: 0, moves: 0, ms: 0 }));
});

test('排序：先比胜负，再比手数，最后比用时', () => {
  const rows = [
    { result: 'loss', score: 0, moves: 3, ms: 1000 },
    { result: 'win', score: 3, moves: 40, ms: 90000 },
    { result: 'win', score: 3, moves: 30, ms: 120000 },
    { result: 'draw', score: 1, moves: 10, ms: 10000 },
    { result: 'win', score: 3, moves: 30, ms: 60000 }
  ];
  assert.deepEqual(sortEntries(rows).map((r) => r.moves + '/' + r.ms), [
    '30/60000', '30/120000', '40/90000', '10/10000', '3/1000'
  ]);
});

test('更好成绩才覆盖：同分比手数，再比用时', () => {
  const prev = { result: 'win', score: 3, moves: 30, ms: 90000 };
  assert.equal(betterEntry({ result: 'win', score: 3, moves: 29, ms: 99999 }, prev), true);
  assert.equal(betterEntry({ result: 'win', score: 3, moves: 31, ms: 1000 }, prev), false);
  assert.equal(betterEntry({ result: 'win', score: 3, moves: 30, ms: 80000 }, prev), true);
  assert.equal(betterEntry({ result: 'win', score: 3, moves: 30, ms: 90000 }, prev), false);
  assert.equal(betterEntry({ result: 'draw', score: 1, moves: 1, ms: 1 }, prev), false);
  assert.equal(betterEntry({ result: 'win', score: 3, moves: 1, ms: 1 }, null), true);
  assert.equal(compareEntries(prev, { result: 'win', score: 3, moves: 30, ms: 90000 }), 0);
});
