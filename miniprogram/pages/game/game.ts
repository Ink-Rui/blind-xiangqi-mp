import {
  Cfg, GameState, Piece, Pos, Side,
  CHARS, PIECE_XY, halfOwner, opp,
  newGameState, hashState, pieceAt, legalTargets, operable, inCheck, hasLegal,
  clonePieces, pickAIMove
} from '../../core/engine';

/** 渲染视图模型：WXML 数据驱动的轻量棋子快照 */
interface VMPiece {
  id: string; x: number; y: number;
  revealed: boolean; sel: boolean; incheck: boolean; lastmv: boolean; dying: boolean;
  color: Side; char: string; backCls: string;
}
interface UndoCtx {
  snap: { pieces: Piece[]; turn: Side; noCap: number; moveNum: number; lastMove: { from: Pos; to: Pos } | null };
  attackerId: string; kingId: string; moverSide: Side;
}

const SHUFFLES = ['A1', 'A2', 'B'];
const RULES = ['check', 'kill'];
const PLAYS = ['hot', 'ai'];
const MODE_TEXT: Record<string, string> = { A1: 'A1 半盘内洗', A2: 'A2 跨河全混', B: 'B 全盘混洗' };
const RULE_TEXT: Record<string, string> = { check: '将军规则', kill: '吃将即胜' };
const PLAY_TEXT: Record<string, string> = { hot: '同屏', ai: '陪练' };

Page({
  data: {
    viewPieces: [],
    hints: [],
    marks: [],
    trayRed: [],
    trayBlack: [],
    status: { turnCls: 'red', turnText: '红方行棋', modeText: '', moveText: '第 1 手', noCapText: '无吃子 0/120' },
    toast: { show: false, cls: '', text: '' },
    showUndo: false, undoText: '',
    showEnd: false, endTitle: '', endTitleCls: '', endReason: '',
    showRules: false,
    vibOn: true
  },

  G: null as GameState | null,
  epoch: 0,                              // 对局世代：startGame 递增，作废跨局遗留回调
  dyingPos: {} as Record<string, Pos>,   // 被吃子：定格在原格用于「翻明再消失」动画
  dyingOut: {} as Record<string, boolean>,
  toastTimer: 0,
  undoCtx: null as UndoCtx | null,

  onLoad(opts: Record<string, string | undefined>) {
    const cfg: Cfg = {
      shuffle: opts.shuffle && SHUFFLES.indexOf(opts.shuffle) >= 0 ? opts.shuffle as Cfg['shuffle'] : 'A1',
      rule: opts.rule && RULES.indexOf(opts.rule) >= 0 ? opts.rule as Cfg['rule'] : 'check',
      play: opts.play && PLAYS.indexOf(opts.play) >= 0 ? opts.play as Cfg['play'] : 'hot'
    };
    // 震动开关：本地持久化，默认开
    this.setData({ vibOn: wx.getStorageSync('vibOn') !== false });
    this.startGame(cfg);
  },

  /* ================= 开局 ================= */
  startGame(cfg: Cfg) {
    this.epoch++;
    const ep = this.epoch;
    this.G = newGameState(cfg);
    this.dyingPos = {};
    this.dyingOut = {};
    this.undoCtx = null;
    this.G.busy = true;
    this.setData({ showEnd: false, showUndo: false, showRules: false });
    this.render();
    setTimeout(() => {
      if (!this.G || ep !== this.epoch) return;
      this.G.busy = false;
      this.render();
      this.showToast(cfg.shuffle === 'B' ? '全盘混洗：连将帅都是未知！' : '洗牌完成，红方先行', '', 1800);
    }, 420);
  },

  /* ================= 渲染 ================= */
  render() {
    const g = this.G;
    if (!g) return;
    const pieces: VMPiece[] = [];
    for (const p of g.pieces) {
      const dyingAt = this.dyingPos[p.id];
      if (p.captured && !dyingAt) continue;
      const pos = p.pos || dyingAt;
      if (!pos) continue;
      const { x, y } = PIECE_XY(pos.r, pos.c);
      pieces.push({
        id: p.id, x, y,
        revealed: p.revealed || !!dyingAt,   // 被吃暗子先翻明再消失
        sel: g.selected === p,
        incheck: p.type === 'K' && !p.captured && p.revealed && !g.over && inCheck(g, p.color),
        lastmv: !!g.lastMove && !!p.pos && !p.captured && p.pos.r === g.lastMove.to.r && p.pos.c === g.lastMove.to.c,
        dying: p.captured,
        color: p.color,
        char: CHARS[p.color][p.type],
        backCls: g.cfg.shuffle === 'A1' ? (pos.r <= 4 ? 'bk' : 'rd') : 'neutral'
      });
    }
    const marks: { x: number; y: number }[] = [];
    if (g.lastMove) {
      for (const pt of [g.lastMove.from, g.lastMove.to]) {
        if (pieceAt(g, pt)) continue;
        const { x, y } = PIECE_XY(pt.r, pt.c);
        marks.push({ x, y });
      }
    }
    const hints: { r: number; c: number; x: number; y: number; cap: boolean }[] = [];
    if (g.selected && !g.over) {
      for (const t of legalTargets(g, g.selected)) {
        const { x, y } = PIECE_XY(t.r, t.c);
        hints.push({ r: t.r, c: t.c, x, y, cap: !!pieceAt(g, t) });
      }
    }
    const trayRed = g.pieces.filter(p => p.captured && p.color === 'red' && !this.dyingPos[p.id]).map(p => CHARS.red[p.type]);
    const trayBlack = g.pieces.filter(p => p.captured && p.color === 'black' && !this.dyingPos[p.id]).map(p => CHARS.black[p.type]);
    this.setData({
      viewPieces: pieces, hints, marks, trayRed, trayBlack,
      status: {
        turnCls: g.over ? 'over' : g.turn,
        turnText: g.over ? '对局结束'
          : (g.turn === 'red' ? '红方' : '黑方') + '行棋' + (g.cfg.play === 'ai' && g.turn === 'black' ? '（陪练）' : ''),
        modeText: MODE_TEXT[g.cfg.shuffle] + ' · ' + RULE_TEXT[g.cfg.rule] + ' · ' + PLAY_TEXT[g.cfg.play],
        moveText: '第 ' + g.moveNum + ' 手',
        noCapText: '无吃子 ' + g.noCap + '/120'
      }
    });
  },

  /* ================= 交互 ================= */
  onPieceTap(e: any) {
    const g = this.G;
    if (!g || g.busy || g.over) return;
    const p = g.pieces.find(q => q.id === e.currentTarget.dataset.id);
    if (!p || !p.pos) return;
    if (g.cfg.play === 'ai' && g.turn === 'black') { this.showToast('陪练思考中…'); return; }
    const side = g.turn;
    if (!operable(g, p, side)) {
      if (p.revealed) this.showToast('这是' + (p.color === 'red' ? '红' : '黑') + '方的明子，由对方操作');
      else this.showToast('该暗子在' + (halfOwner(p.pos) === 'red' ? '红' : '黑') + '方半盘，由对方操作');
      return;
    }
    if (g.selected === p) { g.selected = null; this.render(); return; }
    g.selected = p;
    this.render();
  },

  onHintTap(e: any) {
    const g = this.G;
    if (!g || g.busy || g.over || !g.selected) return;
    const t: Pos = { r: Number(e.currentTarget.dataset.r), c: Number(e.currentTarget.dataset.c) };
    this.tryMove(g.selected, t);
  },

  /* ================= 走子管线 ================= */
  tryMove(p: Piece, t: Pos) {
    const g = this.G;
    if (!g || g.busy || g.over) return;
    const legal = legalTargets(g, p);
    if (!legal.some(x => x.r === t.r && x.c === t.c)) return;
    g.busy = true; g.selected = null;
    const ep = this.epoch;
    const snap = { pieces: clonePieces(g), turn: g.turn, noCap: g.noCap, moveNum: g.moveNum, lastMove: g.lastMove };
    const wasDark = !p.revealed;
    const moverSide: Side = p.revealed ? p.color : (p.pos ? halfOwner(p.pos) : g.turn);
    const target = pieceAt(g, t);
    const from = { r: p.pos!.r, c: p.pos!.c };

    if (target) { target.captured = true; target.pos = null; g.noCap = 0; } else g.noCap++;
    p.pos = { r: t.r, c: t.c };
    g.lastMove = { from, to: { r: t.r, c: t.c } };

    // 被吃子动画：暗子先翻明，再缩小消失
    if (target) {
      this.dyingPos[target.id] = { r: t.r, c: t.c };
      if (!target.revealed) {
        this.render(); this.vibrate('light');
        setTimeout(() => { if (this.dyingPos[target.id]) { this.dyingOut[target.id] = true; this.render(); } }, 700);
        setTimeout(() => { delete this.dyingPos[target.id]; delete this.dyingOut[target.id]; this.render(); }, 1250);
      } else {
        this.dyingOut[target.id] = true;
        this.render(); this.vibrate('light');
        setTimeout(() => { delete this.dyingPos[target.id]; delete this.dyingOut[target.id]; this.render(); }, 550);
      }
    } else {
      this.render();
    }

    // 暗子行走后留悬念延时再翻开（与原型一致）
    const wait = 280 + (wasDark ? 340 + 600 : 120);
    setTimeout(() => { if (this.G && ep === this.epoch) this.afterMove(p, target || null, wasDark, moverSide, snap); }, wait + 120);
  },

  afterMove(p: Piece, target: Piece | null, wasDark: boolean, moverSide: Side, snap: UndoCtx['snap']) {
    const g = this.G;
    if (!g) return;
    if (wasDark) {
      p.revealed = true;
      this.render();
      let msg = '翻开：' + (p.color === 'red' ? '红' : '黑') + '·' + CHARS[p.color][p.type];
      if (target) msg += '；吃掉暗子：' + (target.color === 'red' ? '红' : '黑') + '·' + CHARS[target.color][target.type];
      this.showToast(msg, '', 2000);
    } else if (target && target.revealed) {
      this.showToast((moverSide === 'red' ? '红' : '黑') + '方吃掉' + (target.color === 'red' ? '红' : '黑') + '·' + CHARS[target.color][target.type]);
    }

    // 将帅被吃判定
    if (target && target.type === 'K') {
      if (target.color === moverSide) { this.misEatFlow(p, target, moverSide, snap); return; }
      this.endGame(moverSide, (moverSide === 'red' ? '红方' : '黑方') + '吃掉对方' + (target.color === 'red' ? '帅' : '将'));
      return;
    }

    // 重复局面（长将简化判罚）
    const h = hashState(g);
    g.repMap[h] = (g.repMap[h] || 0) + 1;
    const gaveCheck: Side | null = g.cfg.rule === 'check' && inCheck(g, opp(moverSide)) ? moverSide : null;
    g.history.push({ hash: h, checkBy: gaveCheck });
    if (g.repMap[h] >= 3) {
      const idx = g.history.map(e2 => e2.hash).lastIndexOf(h, g.history.length - 2);
      const seg = g.history.slice(Math.max(idx, 0));
      const givers: Side[] = [];
      for (const e2 of seg) if (e2.checkBy && givers.indexOf(e2.checkBy) < 0) givers.push(e2.checkBy);
      if (givers.length === 1) {
        const s = givers[0];
        this.endGame(opp(s), (s === 'red' ? '红方' : '黑方') + '长将（重复局面判负）');
        return;
      }
      this.endGame(null, '三次重复局面，判和');
      return;
    }
    if (g.noCap >= 120) { this.endGame(null, '120 半回合无吃子，判和'); return; }

    // 换边
    g.turn = opp(g.turn);
    g.moveNum++;
    this.render();
    if (g.cfg.rule === 'check' && inCheck(g, g.turn)) {
      const k = g.pieces.find(q => q.type === 'K' && q.color === g.turn && !q.captured && q.revealed);
      const k2 = g.pieces.find(q => q.type === 'K' && q.color !== g.turn && !q.captured && q.revealed);
      let duilian = false;
      if (k && k.pos && k2 && k2.pos) {
        const a = k.pos, b = k2.pos;
        if (a.c === b.c && Math.abs(a.r - b.r) > 1) {
          let clear = true;
          for (let rr = Math.min(a.r, b.r) + 1; rr < Math.max(a.r, b.r); rr++) {
            if (pieceAt(g, { r: rr, c: a.c })) { clear = false; break; }
          }
          duilian = clear;
        }
      }
      this.showToast(duilian ? '将帅对脸！' : '将军！', 'red', 1500);
      this.vibrate('medium');
    }
    this.render();
    if (!hasLegal(g, g.turn)) {
      this.endGame(moverSide, (g.turn === 'red' ? '红方' : '黑方') + (inCheck(g, g.turn) ? '被将死' : '无子可动'));
      return;
    }
    g.busy = false;
    this.render();
    if (g.cfg.play === 'ai' && g.turn === 'black' && !g.over) {
      const ep = this.epoch;
      setTimeout(() => { if (this.G && ep === this.epoch) this.aiMove(); }, 650 + Math.random() * 350);
    }
  },

  /* ================= 误吃己方将帅 ================= */
  misEatFlow(attacker: Piece, king: Piece, moverSide: Side, snap: UndoCtx['snap']) {
    const g = this.G;
    if (!g) return;
    const winner = opp(moverSide);
    if (g.cfg.play === 'ai') {
      this.endGame(winner, (moverSide === 'red' ? '红方' : '黑方') + '误吃己方将帅（人机不提供协商，判负）');
      return;
    }
    this.setData({
      showUndo: true,
      undoText: (moverSide === 'red' ? '红方' : '黑方') + '走子吃掉暗子，翻开后竟是己方「' + CHARS[king.color][king.type] + '」。\n请' + (winner === 'red' ? '红方' : '黑方') + '（赢方）选择：同意则悔一步（攻子退回原位、将帅放回并保持翻开），不同意则按吃将判负。'
    });
    this.undoCtx = { snap, attackerId: attacker.id, kingId: king.id, moverSide };
  },

  onUndoYes() {
    const ctx = this.undoCtx;
    const g = this.G;
    if (!ctx || !g) return;
    g.pieces = ctx.snap.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
    g.turn = ctx.snap.turn; g.noCap = ctx.snap.noCap; g.moveNum = ctx.snap.moveNum; g.lastMove = ctx.snap.lastMove;
    const at = g.pieces.find(q => q.id === ctx.attackerId);
    if (at) at.revealed = true;      // 攻子已被公开翻明，不回滚信息
    const kg = g.pieces.find(q => q.id === ctx.kingId);
    if (kg) kg.revealed = true;      // 将帅放回并保持翻开
    g.history.pop();
    g.repMap = {};
    for (const e2 of g.history) g.repMap[e2.hash] = (g.repMap[e2.hash] || 0) + 1;
    this.setData({ showUndo: false });
    g.busy = false; g.selected = null;
    this.showToast('已悔一步，' + (g.turn === 'red' ? '红方' : '黑方') + '重新行棋');
    this.render();
  },

  onUndoNo() {
    const ctx = this.undoCtx;
    if (!ctx) return;
    this.setData({ showUndo: false });
    this.endGame(opp(ctx.moverSide), (ctx.moverSide === 'red' ? '红方' : '黑方') + '误吃己方将帅，赢方不同意悔棋，判负');
  },

  /* ================= 终局 ================= */
  endGame(winner: Side | null, reason: string) {
    const g = this.G;
    if (!g) return;
    g.over = true; g.winner = winner; g.busy = true; g.selected = null;
    this.dyingPos = {}; this.dyingOut = {};
    for (const p of g.pieces) p.revealed = true;   // 终局全量翻明
    this.render();
    this.vibrate('heavy');
    this.setData({
      endTitle: winner ? (winner === 'red' ? '红方胜' : '黑方胜') : '和棋',
      endTitleCls: winner === 'red' ? 'rr' : (winner === 'black' ? 'rb' : ''),
      endReason: reason,
      showEnd: false
    });
    const ep = this.epoch;
    setTimeout(() => { if (this.G && ep === this.epoch) this.setData({ showEnd: true }); }, 900);
  },

  /* ================= 随机陪练 ================= */
  aiMove() {
    const g = this.G;
    if (!g || g.over || g.busy) return;
    const mv = pickAIMove(g);
    if (!mv) return;
    this.tryMove(mv.p, mv.t);
  },

  /* ================= 头部按钮 ================= */
  onRestart() {
    const g = this.G;
    if (g) this.startGame({ ...g.cfg });
  },
  onBackSetup() {
    wx.navigateBack();
  },
  onRulesOpen() { this.setData({ showRules: true }); },
  onRulesClose() { this.setData({ showRules: false }); },

  /* ================= 反馈 ================= */
  showToast(text: string, cls?: string, dur?: number) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setData({ toast: { show: true, cls: cls || '', text } });
    this.toastTimer = setTimeout(() => { this.setData({ 'toast.show': false }); }, dur || 1800);
  },

  onToggleVib() {
    const vibOn = !this.data.vibOn;
    this.setData({ vibOn });
    try { wx.setStorageSync('vibOn', vibOn); } catch (e) { /* 存储失败不影响对局 */ }
    this.showToast(vibOn ? '已开启震动反馈' : '已关闭震动反馈', '', 1500);
  },

  vibrate(type: 'light' | 'medium' | 'heavy') {
    if (!this.data.vibOn) return;   // 用户已关闭震动
    // 仅关键事件震动：吃子 light / 将军 medium / 终局 heavy；普通走子不震
    // （安卓不支持强度分级一律默认强度，模拟器还会播放屏幕晃动动画，故高频轻震全部移除）
    try { wx.vibrateShort({ type }); } catch (e) { /* 设备不支持时静默 */ }
  }
});
