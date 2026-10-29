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
export type PlayMode = 'hot' | 'ai';
export interface Cfg { shuffle: ShuffleMode; rule: RuleMode; play: PlayMode }
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
/** 行列坐标 → 960×1080 逻辑视图的百分比坐标 */
export const PIECE_XY = (r: number, c: number): { x: number; y: number } =>
  ({ x: ((60 + 100 * c) / 960) * 100, y: ((60 + 100 * r) / 1080) * 100 });

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

/** 暗子不可吃操作方已翻开的同色明子；明子只吃敌方 */
export function canCapture(g: PositionSnapshot, mover: Piece, tp?: Piece | null): boolean {
  if (!tp) return true;
  if (!mover.revealed) {
    if (!mover.pos) return false;
    const op = halfOwner(mover.pos);
    return !(tp.revealed && tp.color === op);
  }
  return tp.color !== mover.color;
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
export const operable = (g: GameState, q: Piece, side: Side): boolean =>
  q.revealed ? q.color === side : q.pos ? halfOwner(q.pos) === side : false;

export function hasLegal(g: GameState, side: Side): boolean {
  return g.pieces.some(q => !q.captured && operable(g, q, side) && legalTargets(g, q).length > 0);
}

/** 深拷贝棋子数组（悔棋快照用） */
export function clonePieces(g: GameState): Piece[] {
  return g.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
}

/** 随机陪练：偏好吃子的随机走法（正式人机智能另行开发） */
export function pickAIMove(g: GameState): { p: Piece; t: Pos } | null {
  const all: { p: Piece; t: Pos }[] = [];
  for (const q of g.pieces) {
    if (q.captured || !operable(g, q, 'black')) continue;
    for (const t of legalTargets(g, q)) all.push({ p: q, t });
  }
  if (!all.length) return null;
  const caps = all.filter(m => pieceAt(g, m.t));
  if (caps.length && Math.random() < 0.6) return caps[Math.floor(Math.random() * caps.length)];
  return all[Math.floor(Math.random() * all.length)];
}
