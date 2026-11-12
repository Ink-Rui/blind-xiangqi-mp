/**
 * 盲下象棋 · 核心引擎（纯函数，无任何小程序/浏览器 API 依赖）
 * 从 V1 可玩原型移植；对应 PRD FR-01~FR-10、15、17、21、28。
 * 本文件保持自包含（无跨文件 import），便于复用到其他端与无头压测。
 */

export type Side = 'red' | 'black';
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P';
export interface Pos { r: number; c: number }
export interface Piece {
  id: string;
  color: Side;
  type: PieceType;
  /** 洗牌时所在位置对应的「位置型棋种」，暗子按此走法行棋 */
  slotType: PieceType | null;
  revealed: boolean;
  captured: boolean;
  pos: Pos | null;
}
export interface Slot { r: number; c: number; t: PieceType }
export type ShuffleMode = 'A1' | 'A2' | 'B';
export type RuleMode = 'check' | 'kill';
export type PlayMode = 'hot' | 'ai' | 'online';
export type Level = 'easy' | 'normal' | 'hard';
export interface Cfg { shuffle: ShuffleMode; rule: RuleMode; play: PlayMode; level: Level }
export interface HistoryEntry { hash: string; checkBy: Side | null }
export interface LastMove { from: Pos; to: Pos }
export interface GameState {
  cfg: Cfg;
  turn: Side;
  moveNum: number;
  /** 连续无吃子的半回合数 */
  noCap: number;
  over: boolean;
  winner: Side | null;
  reason: string;
  pieces: Piece[];
  history: HistoryEntry[];
  repMap: Record<string, number>;
  lastMove: LastMove | null;
  selected: Piece | null;
  busy: boolean;
}

export const CHARS: Record<Side, Record<PieceType, string>> = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' }
};
export const NAMES: Record<PieceType, string> = { K: '将/帅', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '兵' };

/** 32 个起始位及其「位置型棋种」 */
export const SLOTS: Slot[] = (() => {
  const back = 'RNBAKABNR';
  const s: Slot[] = [];
  for (let c = 0; c < 9; c++) s.push({ r: 0, c, t: back[c] as PieceType });
  s.push({ r: 2, c: 1, t: 'C' }, { r: 2, c: 7, t: 'C' });
  for (const c of [0, 2, 4, 6, 8]) s.push({ r: 3, c, t: 'P' });
  for (const c of [0, 2, 4, 6, 8]) s.push({ r: 6, c, t: 'P' });
  s.push({ r: 7, c: 1, t: 'C' }, { r: 7, c: 7, t: 'C' });
  for (let c = 0; c < 9; c++) s.push({ r: 9, c, t: back[c] as PieceType });
  return s;
})();

export const opp = (s: Side): Side => (s === 'red' ? 'black' : 'red');
/** 上 5 行为黑方半盘，下 5 行为红方半盘 */
export const halfOwner = (pos: Pos): Side => (pos.r <= 4 ? 'black' : 'red');
/** 行列坐标 → 960×1080 逻辑视图的百分比坐标（格框居中：左右各留 80、上下各留 90） */
export const PIECE_XY = (r: number, c: number): { x: number; y: number } =>
  ({ x: ((80 + 100 * c) / 960) * 100, y: ((90 + 100 * r) / 1080) * 100 });

function shuffleArr<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function newGameState(cfg: Cfg): GameState {
  const g: GameState = {
    cfg, turn: 'red', moveNum: 1, noCap: 0, over: false, winner: null, reason: '',
    pieces: [], history: [], repMap: {}, lastMove: null, selected: null, busy: false
  };
  // 生成 32 子
  let id = 0;
  for (const color of ['red', 'black'] as Side[]) {
    const roster: [PieceType, number][] = [['K', 1], ['A', 2], ['B', 2], ['N', 2], ['R', 2], ['C', 2], ['P', 5]];
    for (const [t, n] of roster) {
      for (let i = 0; i < n; i++) {
        g.pieces.push({ id: 'p' + id++, color, type: t, slotType: null, revealed: false, captured: false, pos: null });
      }
    }
  }
  // 洗牌
  const kings = {
    red: g.pieces.find(p => p.color === 'red' && p.type === 'K')!,
    black: g.pieces.find(p => p.color === 'black' && p.type === 'K')!
  };
  if (cfg.shuffle === 'B') {
    const slots = shuffleArr(SLOTS.slice());
    const ps = shuffleArr(g.pieces.slice());
    ps.forEach((p, i) => { p.pos = { r: slots[i].r, c: slots[i].c }; p.slotType = slots[i].t; p.revealed = false; });
  } else {
    kings.red.pos = { r: 9, c: 4 }; kings.red.slotType = 'K'; kings.red.revealed = true;
    kings.black.pos = { r: 0, c: 4 }; kings.black.slotType = 'K'; kings.black.revealed = true;
    const rest = g.pieces.filter(p => p.type !== 'K');
    if (cfg.shuffle === 'A1') {
      for (const side of ['red', 'black'] as Side[]) {
        const own = shuffleArr(SLOTS.filter(s => halfOwner(s) === side && !(s.r === (side === 'red' ? 9 : 0) && s.c === 4)));
        const pcs = shuffleArr(rest.filter(p => p.color === side));
        pcs.forEach((p, i) => { p.pos = { r: own[i].r, c: own[i].c }; p.slotType = own[i].t; });
      }
    } else { // A2
      const slots = shuffleArr(SLOTS.filter(s => !(s.r === 9 && s.c === 4) && !(s.r === 0 && s.c === 4)));
      const pcs = shuffleArr(rest);
      pcs.forEach((p, i) => { p.pos = { r: slots[i].r, c: slots[i].c }; p.slotType = slots[i].t; });
    }
  }
  g.repMap[hashState(g)] = 1;
  return g;
}

export function hashState(g: GameState): string {
  return g.pieces.map(p => p.id + ':' + (p.pos ? p.pos.r + '_' + p.pos.c : 'x') + (p.revealed ? 1 : 0)).join('|') + '#' + g.turn;
}

/** 只读位置快照：将军检查等场景只需要 pieces 与 cfg（如 simMove 的模拟结果） */
export interface PositionSnapshot { pieces: Piece[]; cfg: Cfg }

export const pieceAt = (g: PositionSnapshot, t: Pos): Piece | undefined =>
  g.pieces.find(p => !p.captured && p.pos && p.pos.r === t.r && p.pos.c === t.c);

export const effType = (p: Piece): PieceType => (p.revealed ? p.type : (p.slotType as PieceType));

/* ================= 走法生成（纯逻辑） ================= */
export function pseudoMoves(g: PositionSnapshot, p: Piece): Pos[] {
  if (!p.pos) return [];
  const t = effType(p);
  const { r, c } = p.pos;
  const out: Pos[] = [];
  const ok = (rr: number, cc: number) => rr >= 0 && rr < 10 && cc >= 0 && cc < 9;
  const palaceOf = (base: number) => (base <= 4 ? 'top' : 'bot');
  const inPalace = (rr: number, cc: number, pal: string) => cc >= 3 && cc <= 5 && (pal === 'top' ? rr <= 2 : rr >= 7);
  if (t === 'R') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let rr = r + dr, cc = c + dc;
      while (ok(rr, cc)) { out.push({ r: rr, c: cc }); if (pieceAt(g, { r: rr, c: cc })) break; rr += dr; cc += dc; }
    }
  } else if (t === 'C') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let rr = r + dr, cc = c + dc;
      while (ok(rr, cc) && !pieceAt(g, { r: rr, c: cc })) { out.push({ r: rr, c: cc }); rr += dr; cc += dc; }
      if (ok(rr, cc)) { // 第一个子为炮架
        rr += dr; cc += dc;
        while (ok(rr, cc)) { if (pieceAt(g, { r: rr, c: cc })) { out.push({ r: rr, c: cc }); break; } rr += dr; cc += dc; }
      }
    }
  } else if (t === 'N') {
    for (const [dr, dc, lr, lc] of [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0], [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]]) {
      if (!pieceAt(g, { r: r + lr, c: c + lc }) && ok(r + dr, c + dc)) out.push({ r: r + dr, c: c + dc });
    }
  } else if (t === 'B') {
    for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
      const rr = r + dr, cc = c + dc;
      if (!ok(rr, cc) || pieceAt(g, { r: r + dr / 2, c: c + dc / 2 })) continue;
      if (!p.revealed) { // 暗象受河界限制
        if (r <= 4 && rr > 4) continue;
        if (r >= 5 && rr < 5) continue;
      }
      out.push({ r: rr, c: cc });
    }
  } else if (t === 'A') {
    const pal = p.revealed ? null : palaceOf(r); // 明士可出九宫
    for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (!ok(rr, cc)) continue;
      if (pal && !inPalace(rr, cc, pal)) continue;
      out.push({ r: rr, c: cc });
    }
  } else if (t === 'K') {
    const pal = p.revealed ? (p.color === 'red' ? 'bot' : 'top') : palaceOf(r);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (ok(rr, cc) && inPalace(rr, cc, pal)) out.push({ r: rr, c: cc });
    }
    if (g.cfg.rule === 'kill' && p.revealed) { // 飞将：对脸直接吃对方明帅
      const ek = g.pieces.find(q => q.type === 'K' && q.color !== p.color && !q.captured && q.revealed);
      if (ek && ek.pos && ek.pos.c === c) {
        let clear = true;
        const lo = Math.min(r, ek.pos.r), hi = Math.max(r, ek.pos.r);
        for (let rr = lo + 1; rr < hi; rr++) if (pieceAt(g, { r: rr, c })) { clear = false; break; }
        if (clear && hi > lo) out.push({ r: ek.pos.r, c: ek.pos.c });
      }
    }
  } else if (t === 'P') {
    const dir = p.revealed ? (p.color === 'red' ? -1 : 1) : (r <= 4 ? 1 : -1);
    if (ok(r + dir, c)) out.push({ r: r + dir, c });
    if (p.revealed) {
      const crossed = p.color === 'red' ? r <= 4 : r >= 5;
      if (crossed) { if (ok(r, c - 1)) out.push({ r, c: c - 1 }); if (ok(r, c + 1)) out.push({ r, c: c + 1 }); }
    }
  }
  return out;
}

/** 吃子限制只对「已翻开的子」生效：暗子归属未知，谁都可以吃（可能误吃己方将帅） */
export function canCapture(g: PositionSnapshot, mover: Piece, tp?: Piece | null): boolean {
  if (!tp) return true;
  if (!tp.revealed) return true;                  // 目标是暗子：身份未知，允许吃（翻开才知道吃到了谁）
  if (!mover.revealed) {
    if (!mover.pos) return false;
    const op = halfOwner(mover.pos);
    return tp.color !== op;                       // 暗子不可吃所在半盘操作方已翻开的同色明子
  }
  return tp.color !== mover.color;                // 明子不可吃己方明子
}

/** 模拟走子（含自动翻开），用于将军安全性检查 */
export function simMove(g: GameState, p: Piece, t: Pos): { pieces: Piece[]; cfg: Cfg } {
  const pieces: Piece[] = g.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
  const sp = pieces.find(q => q.id === p.id)!;
  const tp = pieces.find(q => !q.captured && q.pos && q.pos.r === t.r && q.pos.c === t.c);
  if (tp) { tp.captured = true; tp.pos = null; }
  sp.pos = { r: t.r, c: t.c };
  if (!sp.revealed) sp.revealed = true;
  return { pieces, cfg: g.cfg };
}

export function inCheck(g: PositionSnapshot, side: Side): boolean {
  const k = g.pieces.find(q => q.type === 'K' && q.color === side && !q.captured && q.revealed);
  if (!k || !k.pos) return false;
  for (const e of g.pieces) {
    if (e.captured || e.color === side || !e.pos) continue;
    if (pseudoMoves(g, e).some(t => {
      const tp = pieceAt(g, t);
      return tp && tp.color === side && tp.type === 'K' && canCapture(g, e, tp);
    })) return true;
  }
  const k2 = g.pieces.find(q => q.type === 'K' && q.color !== side && !q.captured && q.revealed);
  if (k2 && k2.pos && k2.pos.c === k.pos.c) {
    let clear = true;
    const lo = Math.min(k.pos.r, k2.pos.r), hi = Math.max(k.pos.r, k2.pos.r);
    for (let rr = lo + 1; rr < hi; rr++) if (pieceAt(g, { r: rr, c: k.pos.c })) { clear = false; break; }
    if (clear && hi > lo) return true; // 对脸视为受将
  }
  return false;
}

export function legalTargets(g: GameState, p: Piece): Pos[] {
  let ms = pseudoMoves(g, p).filter(t => {
    const tp = pieceAt(g, t);
    return canCapture(g, p, tp) && !(g.cfg.rule === 'check' && tp && tp.revealed && tp.type === 'K');
  });
  if (g.cfg.rule === 'check' && p.revealed) {
    const ownK = g.pieces.find(q => q.type === 'K' && q.color === p.color && !q.captured);
    if (ownK && ownK.revealed) {
      ms = ms.filter(t => !inCheck(simMove(g, p, t), p.color));
    }
  }
  return ms;
}

/** 操作权 R1：暗子归所在半盘方，明子归颜色方 */
export const operable = (g: PositionSnapshot, q: Piece, side: Side): boolean =>
  q.revealed ? q.color === side : q.pos ? halfOwner(q.pos) === side : false;

export function hasLegal(g: GameState, side: Side): boolean {
  return g.pieces.some(q => !q.captured && operable(g, q, side) && legalTargets(g, q).length > 0);
}

/** 深拷贝棋子数组（悔棋快照用） */
export function clonePieces(g: GameState): Piece[] {
  return g.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
}

/** 子力估值（AI 评估用） */
const AI_VALUE: Record<PieceType, number> = { K: 1000, R: 90, C: 45, N: 40, B: 20, A: 20, P: 10 };

/** side 一方（按操作权规则）能否吃掉 target */
function isCapturable(g: PositionSnapshot, target: Piece, side: Side): boolean {
  if (!target.pos) return false;
  for (const q of g.pieces) {
    if (q.captured || q.color !== side || !q.pos) continue;
    if (!operable(g, q, side)) continue;
    if (pseudoMoves(g, q).some(t2 => t2.r === target.pos!.r && t2.c === target.pos!.c) &&
        canCapture(g, q, target)) return true;
  }
  return false;
}

/** 己方是否有子能吃回 target 所在格（几何意义上的保护） */
function isDefended(g: PositionSnapshot, target: Piece, side: Side): boolean {
  if (!target.pos) return false;
  for (const q of g.pieces) {
    if (q.captured || q.color !== side || !q.pos || q.id === target.id) continue;
    if (!operable(g, q, side)) continue;
    if (pseudoMoves(g, q).some(t2 => t2.r === target.pos!.r && t2.c === target.pos!.c)) return true;
  }
  return false;
}

/** 攻击 target 的对方子中最便宜的价值（暗子按期望价值计） */
function minAttackerValue(g: PositionSnapshot, target: Piece, side: Side, darkEV: number): number {
  if (!target.pos) return Infinity;
  let mn = Infinity;
  let hasDark = false;
  for (const q of g.pieces) {
    if (q.captured || q.color !== side || !q.pos) continue;
    if (!operable(g, q, side)) continue;
    if (!pseudoMoves(g, q).some(t2 => t2.r === target.pos!.r && t2.c === target.pos!.c) ||
        !canCapture(g, q, target)) continue;
    if (q.revealed) mn = Math.min(mn, AI_VALUE[q.type]);
    else hasDark = true;
  }
  if (hasDark) mn = Math.min(mn, darkEV);
  return mn;
}

/** hard 难度单步评估（不偷看暗子身份，只用双方都可推算的信息做期望定价）：
 *  吃子价值 - 保护感知被吃风险 + 翻子归属/推进/将军小分 - 重复局面罚分 */
function aiScore(g: GameState, m: { p: Piece; t: Pos }, side: Side): number {
  const { p, t } = m;
  const from = p.pos!;
  const enemy = opp(side);
  let s = Math.random() * 1.5;                 // 少量随机，避免走出死循环

  // 可观测统计：存留暗子集合（明子身份公开、被吃子公告过，双方都能数出各方剩余暗子数）
  const H = g.pieces.filter(q => !q.captured && !q.revealed && q.pos);
  const N = H.length || 1;
  const myHArr = H.filter(q => q.color === side);
  const enHArr = H.filter(q => q.color !== side);
  const myH = myHArr.length, enH = enHArr.length;
  const sumV = (arr: Piece[]) => arr.reduce((a, q) => a + AI_VALUE[q.type], 0);
  const myK = g.pieces.find(q => q.type === 'K' && q.color === side && !q.captured);
  const kHidden = !!(myK && !myK.revealed);
  const enK = g.pieces.find(q => q.type === 'K' && q.color === enemy && !q.captured);
  const enKHidden = !!(enK && !enK.revealed);
  const myAvgNoK = (myH - (kHidden ? 1 : 0)) > 0 ? (sumV(myHArr) - (kHidden ? AI_VALUE.K : 0)) / (myH - (kHidden ? 1 : 0)) : 0;
  const enAvgNoK = (enH - (enKHidden ? 1 : 0)) > 0 ? (sumV(enHArr) - (enKHidden ? AI_VALUE.K : 0)) / (enH - (enKHidden ? 1 : 0)) : 0;
  const enAvg = enH ? sumV(enHArr) / enH : 0;
  const pMine = myH / N;                       // 操作中的暗子翻开后属于己方的概率
  const pEnemy = enH / N;

  const target = pieceAt(g, t);
  if (target) {
    if (target.revealed) {
      s += AI_VALUE[target.type];
      if (target.type === 'K') s += 4000;   // 吃对方明将 → 直接获胜
      s += 30;                              // 交战倾向：鼓励主动
    } else {
      // 吃暗子期望定价：敌子收益 − 误吃己方子损失 − 误吃己方暗将(判负)风险 + 命中对方暗将(直接获胜)收益 + 交战倾向
      s += ((enH - (enKHidden ? 1 : 0)) / N) * enAvgNoK;
      s -= ((myH - (kHidden ? 1 : 0)) / N) * myAvgNoK;
      if (enKHidden) s += 2500 / N;
      if (kHidden) s -= 2500 / N;
      s += 15;
    }
  }
  const after = simMove(g, p, t);              // simMove 会把走子方翻明
  if (!p.revealed) {
    // 翻明的归属定价：翻到己方色 → 己方多得一个明子；翻到对方色 → 送给对方（期望损失）
    s += pMine * 12 - pEnemy * enAvg * 0.3;
  }
  // 走完暴露在对方火力下 → 保护感知定价：有保护只计「换子亏损」，无保护全额计险
  const moved = after.pieces.find(q => q.id === p.id)!;
  const movedAtRisk = isCapturable(after, moved, enemy);
  if (movedAtRisk) {
    const riskV = p.revealed ? AI_VALUE[p.type] : (myH / N) * myAvgNoK;
    const defended = isDefended(after, moved, side);
    const atkV = minAttackerValue(after, moved, enemy, enAvgNoK);
    const cost = defended ? Math.max(0, riskV - atkV) : riskV;
    s -= cost * 0.8;
    if (!p.revealed && kHidden) s -= 2000 / N;   // 若翻出的恰是己方暗将且落点被攻击 → 判负风险
  }
  // 威胁对方明将：下一步即可斩将 → 奖励；但攻击子自身悬在外面时不算威胁（否则是白送）
  const enKr = after.pieces.find(q => q.type === 'K' && q.color === enemy && !q.captured && q.revealed);
  if (enKr && enKr.pos && isCapturable(after, enKr, side) && !movedAtRisk) s += 150;
  // 己方明将安全：相对基线（走之前本就被攻击不重复罚；新增攻击重罚；解脱攻击奖励）
  const myKrNow = g.pieces.find(q => q.type === 'K' && q.color === side && !q.captured && q.revealed);
  const dBefore = !!(myKrNow && myKrNow.pos && isCapturable(g, myKrNow, enemy));
  const myKrAfter = after.pieces.find(q => q.type === 'K' && q.color === side && !q.captured && q.revealed);
  const dAfter = !!(myKrAfter && myKrAfter.pos && isCapturable(after, myKrAfter, enemy));
  if (dAfter && !dBefore) s -= 800;
  if (!dAfter && dBefore) s += 500;
  if (!p.revealed) s += g.moveNum <= 20 ? 3 : 1;   // 早翻子：换取信息与操作权
  s += (side === 'black' ? t.r - from.r : from.r - t.r) * 0.1;   // 向对方半盘推进（弱：推进会让出狙击线）
  if (g.cfg.rule === 'check' && inCheck(after, enemy)) s += 12;
  // 避免第三次重复局面（长将判罚/无吃子判和都吃亏）
  const h = after.pieces.map(q => q.id + ':' + (q.pos ? q.pos.r + '_' + q.pos.c : 'x') + (q.revealed ? 1 : 0)).join('|') + '#' + enemy;
  if ((g.repMap[h] || 0) >= 2) s -= 300;
  return s;
}

/** 陪练走子：easy 纯随机 / normal 60% 偏好吃子 / hard 期望定价单层评估（不偷看暗子身份） */
export function pickAIMove(g: GameState, side: Side = 'black'): { p: Piece; t: Pos } | null {
  const all: { p: Piece; t: Pos }[] = [];
  for (const q of g.pieces) {
    if (q.captured || !operable(g, q, side)) continue;
    for (const t of legalTargets(g, q)) all.push({ p: q, t });
  }
  if (!all.length) return null;
  const level: Level = g.cfg.level || 'normal';
  if (level === 'easy') return all[Math.floor(Math.random() * all.length)];
  if (level === 'normal') {
    const caps = all.filter(m => pieceAt(g, m.t));
    if (caps.length && Math.random() < 0.6) return caps[Math.floor(Math.random() * caps.length)];
    return all[Math.floor(Math.random() * all.length)];
  }
  // hard：可直吃对方明将先走；否则按单层期望评估选最优（并列随机）
  const winNow = all.find(m => { const tp = pieceAt(g, m.t); return tp && tp.revealed && tp.type === 'K' && tp.color !== side; });
  if (winNow) return winNow;
  let best: { p: Piece; t: Pos }[] = [];
  let bestScore = -Infinity;
  for (const m of all) {
    const s = aiScore(g, m, side);
    if (s > bestScore + 0.01) { bestScore = s; best = [m]; }
    else if (s > bestScore - 0.01) best.push(m);
  }
  return best[Math.floor(Math.random() * best.length)];
}
