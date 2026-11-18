/**
 * 盲下象棋 · 终局判定
 * 从交互层抽出的纯逻辑，便于在 Node 中直接测试（不依赖 DOM）。
 */
import { hashState, inCheck, opp } from './engine.js';

export function sideName(side) {
  return side === 'red' ? '红方' : '黑方';
}

/**
 * 记录一步走完后的局面。
 * @returns {{hash: string, gaveCheck: 'red'|'black'|null}}
 */
export function recordPosition(g, moverSide) {
  const hash = hashState(g);
  g.repMap[hash] = (g.repMap[hash] || 0) + 1;
  const gaveCheck = g.cfg.rule === 'check' && inCheck(g, opp(moverSide)) ? moverSide : null;
  g.history.push({ hash, checkBy: gaveCheck });
  return { hash, gaveCheck };
}

/**
 * 三次重复局面：单方长将判负，否则判和。未触发返回 null。
 */
export function repetitionOutcome(g, hash) {
  if ((g.repMap[hash] || 0) < 3) return null;
  const idx = g.history.map((e) => e.hash).lastIndexOf(hash, g.history.length - 2);
  const seg = g.history.slice(Math.max(idx, 0));
  const givers = [];
  for (const e of seg) if (e.checkBy && givers.indexOf(e.checkBy) < 0) givers.push(e.checkBy);
  if (givers.length === 1) {
    return { winner: opp(givers[0]), reason: sideName(givers[0]) + '长将（重复局面判负）' };
  }
  return { winner: null, reason: '三次重复局面，判和' };
}

/** 120 个半回合无吃子判和 */
export function noCaptureOutcome(g) {
  if (g.noCap < 120) return null;
  return { winner: null, reason: '120 个半回合无吃子，判和' };
}

/**
 * 吃掉将帅的判定。
 * 吃对方将帅 → { winner, reason }；吃己方将帅 → { self: true }；其他目标 → null。
 */
export function kingCaptureOutcome(target, moverSide) {
  if (!target || target.type !== 'K') return null;
  if (target.color === moverSide) return { self: true };
  return {
    winner: moverSide,
    reason: sideName(moverSide) + '吃掉对方' + (target.color === 'red' ? '帅' : '将')
  };
}
