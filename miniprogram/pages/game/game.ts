import {
  Cfg, GameState, Piece, Pos, Side,
  CHARS, PIECE_XY, halfOwner, opp,
  newGameState, hashState, pieceAt, legalTargets, operable, inCheck, hasLegal,
  clonePieces, pickAIMove
} from '../../core/engine';
import { callRoom, RoomAsk, RoomRes, RoomState } from '../../core/net';

/** 渲染视图模型：WXML 数据驱动的轻量棋子快照 */
interface VMPiece {
  id: string; x: number; y: number;
  revealed: boolean; sel: boolean; incheck: boolean; lastmv: boolean; dying: boolean;
  color: Side; char: string; backCls: string;
}
interface UndoCtx {
  snap: { pieces: Piece[]; turn: Side; noCap: number; moveNum: number; lastMove: { from: Pos; to: Pos } | null; flippedId?: string | null };
  attackerId: string; kingId: string; moverSide: Side;
}

const SHUFFLES = ['A1', 'A2', 'B'];
const RULES = ['check', 'kill'];
const PLAYS = ['hot', 'ai'];
const LEVELS = ['easy', 'normal', 'hard'];
const MODE_TEXT: Record<string, string> = { A1: 'A1 半盘内洗', A2: 'A2 跨河全混', B: 'B 全盘混洗' };
const RULE_TEXT: Record<string, string> = { check: '将军规则', kill: '吃将即胜' };
const PLAY_TEXT: Record<string, string> = { hot: '同屏', ai: '陪练', online: '联机' };
const LEVEL_TEXT: Record<string, string> = { easy: '简单', normal: '普通', hard: '困难' };
const sideName = (s: string) => (s === 'red' ? '红方' : '黑方');

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
    showEndBar: false,
    showRules: false,
    showAsk: false, askText: '',
    canUndo: false, canPass: false,
    vibOn: true,
    /* 联机 */
    online: false,
    roomCode: '',
    onlineWait: false,       // 等待对方加入
    netText: '',
    oppOffline: false,
    shareTitle: ''
  },

  G: null as GameState | null,
  epoch: 0,                              // 对局世代：startGame 递增，作废跨局遗留回调
  dyingPos: {} as Record<string, Pos>,   // 被吃子：定格在原格用于「翻明再消失」动画
  dyingOut: {} as Record<string, boolean>,
  toastTimer: 0,
  undoCtx: null as UndoCtx | null,
  snaps: [] as UndoCtx['snap'][],        // 悔棋快照栈（每半回合一个，翻开信息不回滚）
  askCtx: null as 'undo' | 'pass' | null,
  /* 联机状态 */
  roomCode: '',
  role: '' as '' | Side,
  ver: 0,
  netTimer: 0,
  polling: false,
  syncing: false,
  currentAsk: null as RoomAsk | null,

  onLoad(opts: Record<string, string | undefined>) {
    // 震动开关：本地持久化，默认开
    this.setData({ vibOn: wx.getStorageSync('vibOn') !== false });
    if (opts.room) { this.startOnline(opts.room); return; }
    const cfg: Cfg = {
      shuffle: opts.shuffle && SHUFFLES.indexOf(opts.shuffle) >= 0 ? opts.shuffle as Cfg['shuffle'] : 'A1',
      rule: opts.rule && RULES.indexOf(opts.rule) >= 0 ? opts.rule as Cfg['rule'] : 'check',
      play: opts.play && PLAYS.indexOf(opts.play) >= 0 ? opts.play as Cfg['play'] : 'hot',
      level: opts.level && LEVELS.indexOf(opts.level) >= 0 ? opts.level as Cfg['level'] : 'normal'
    };
    this.startGame(cfg);
  },

  onShow() {
    if (this.data.online && this.roomCode && this.role && !this.polling) { this.startPoll(); this.syncOnce(); }
  },
  onHide() {
    if (this.data.online) this.stopPoll();
  },
  onUnload() {
    this.stopPoll();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  },

  onShareAppMessage() {
    if (this.data.online && this.roomCode) {
      return {
        title: '来和我下一盘盲棋（房间 ' + this.roomCode + '）',
        path: '/pages/game/game?room=' + this.roomCode
      };
    }
    return { title: '盲下象棋 · 暗子走完才翻开的象棋', path: '/pages/index/index' };
  },

  /* ================= 开局 ================= */
  startGame(cfg: Cfg) {
    this.epoch++;
    const ep = this.epoch;
    this.G = newGameState(cfg);
    this.dyingPos = {};
    this.dyingOut = {};
    this.undoCtx = null;
    this.snaps = [];
    this.askCtx = null;
    this.G.busy = true;
    this.setData({ showEnd: false, showEndBar: false, showUndo: false, showRules: false, showAsk: false, canUndo: false, canPass: false });
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
          : this.data.online
            ? (g.turn === this.role ? '轮到你走棋' : '等待对方走棋')
            : (g.turn === 'red' ? '红方' : '黑方') + '行棋' + (g.cfg.play === 'ai' && g.turn === 'black' ? '（陪练）' : ''),
        modeText: MODE_TEXT[g.cfg.shuffle] + ' · ' + RULE_TEXT[g.cfg.rule] + ' · ' + PLAY_TEXT[g.cfg.play] +
          (g.cfg.play === 'ai' ? ' · ' + LEVEL_TEXT[g.cfg.level || 'normal'] : '') +
          (this.data.online && this.role ? ' · 你执' + (this.role === 'red' ? '红' : '黑') : ''),
        moveText: '第 ' + g.moveNum + ' 手',
        noCapText: '无吃子 ' + g.noCap + '/120',
        check: !g.over && inCheck(g, g.turn)
      },
      canUndo: this.data.online
        ? !g.over && !g.busy && !!this.role && this.role === opp(g.turn) && !this.currentAsk
        : !g.over && !g.busy && this.snaps.length > 0 && !this.undoCtx && !this.askCtx,
      canPass: this.data.online
        ? !g.over && !g.busy && !!this.role && this.role === g.turn && !this.currentAsk
        : !g.over && !g.busy && g.cfg.play === 'hot' && !this.undoCtx && !this.askCtx
    });
  },

  /* ================= 交互 ================= */
  onPieceTap(e: any) {
    const g = this.G;
    if (!g || g.busy || g.over) return;
    const p = g.pieces.find(q => q.id === e.currentTarget.dataset.id);
    if (!p || !p.pos) return;
    if (g.cfg.play === 'ai' && g.turn === 'black') { this.showToast('陪练思考中…'); return; }
    if (this.data.online) {
      if (this.currentAsk) { this.showToast('请先处理协商请求'); return; }
      if (this.role && g.turn !== this.role) { this.showToast('等待对方走棋'); return; }
    }
    const side = g.turn;
    if (!operable(g, p, side)) {
      if (p.revealed) this.showToast('这是' + (p.color === 'red' ? '红' : '黑') + '方的明子，由对方操作');
      else this.showToast('该暗子在' + (halfOwner(p.pos) === 'red' ? '红' : '黑') + '方半盘，由对方操作');
      return;
    }
    if (g.selected === p) { g.selected = null; this.render(); return; }
    g.selected = p;
    this.vibrate('light');   // 选中棋子轻震反馈
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
    if (this.data.online) { this.onlineMove(p, t); return; }
    g.busy = true; g.selected = null;
    const ep = this.epoch;
    const wasDark = !p.revealed;
    const snap = { pieces: clonePieces(g), turn: g.turn, noCap: g.noCap, moveNum: g.moveNum, lastMove: g.lastMove, flippedId: wasDark ? p.id : null as string | null };
    this.snaps.push(snap);
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
        this.render(); this.vibrate('medium');
        setTimeout(() => { if (this.dyingPos[target.id]) { this.dyingOut[target.id] = true; this.render(); } }, 700);
        setTimeout(() => { delete this.dyingPos[target.id]; delete this.dyingOut[target.id]; this.render(); }, 1250);
      } else {
        this.dyingOut[target.id] = true;
        this.render(); this.vibrate('medium');
        setTimeout(() => { delete this.dyingPos[target.id]; delete this.dyingOut[target.id]; this.render(); }, 550);
      }
    } else {
      this.render(); this.vibrate('light');   // 普通走子轻震
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
    this.snaps.pop();   // 该快照已交给 undoCtx，避免悔棋栈重复回退
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
    if (this.data.online) { this.onlineAnswer(true); return; }
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
    if (this.data.online) { this.onlineAnswer(false); return; }
    const ctx = this.undoCtx;
    if (!ctx) return;
    this.setData({ showUndo: false });
    this.endGame(opp(ctx.moverSide), (ctx.moverSide === 'red' ? '红方' : '黑方') + '误吃己方将帅，赢方不同意悔棋，判负');
  },

  /* ================= 悔棋 / 让一手（协商） ================= */
  /** 回退最近半回合；翻开过的棋子信息不回滚 */
  revertOne(): boolean {
    const g = this.G;
    const snap = this.snaps.pop();
    if (!g || !snap) return false;
    g.pieces = snap.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
    g.turn = snap.turn; g.noCap = snap.noCap; g.moveNum = snap.moveNum;
    g.lastMove = snap.lastMove ? { from: { ...snap.lastMove.from }, to: { ...snap.lastMove.to } } : null;
    g.history.pop();
    g.repMap = {};
    for (const e2 of g.history) g.repMap[e2.hash] = (g.repMap[e2.hash] || 0) + 1;
    if (snap.flippedId) {
      const fp = g.pieces.find(q => q.id === snap.flippedId);
      if (fp) fp.revealed = true;   // 已公开翻明的暗子保持翻开
    }
    g.selected = null;
    this.dyingPos = {}; this.dyingOut = {};
    return true;
  },

  onUndoTap() {
    const g = this.G;
    if (!g || g.over || g.busy || this.undoCtx || this.askCtx) return;
    if (this.data.online) {
      if (this.currentAsk) { this.showToast('已有待处理的协商请求'); return; }
      if (this.role !== opp(g.turn)) { this.showToast('要等对方走完一手后再请求悔棋'); return; }
      this.sendAsk('undo');
      return;
    }
    if (!this.snaps.length) { this.showToast('没有可悔的着法'); return; }
    if (g.cfg.play === 'hot') {
      const req = opp(g.turn);   // 刚走完一手的一方发起悔棋
      this.askCtx = 'undo';
      this.setData({ showAsk: true, askText: (req === 'red' ? '红方' : '黑方') + '请求悔棋一步。\n请' + (g.turn === 'red' ? '红方' : '黑方') + '（对方）选择是否同意。' });
      return;
    }
    // 陪练模式：直接撤销到玩家行棋（AI 已应手则连 AI 一起撤）
    const n = g.turn === 'red' ? 2 : 1;
    let done = false;
    for (let i = 0; i < n && this.snaps.length; i++) done = this.revertOne() || done;
    if (!done) return;
    g.busy = false;
    this.showToast('已悔棋，重新行棋');
    this.render();
  },

  onPassTap() {
    const g = this.G;
    if (!g || g.over || g.busy || this.undoCtx || this.askCtx) return;
    if (this.data.online) {
      if (this.currentAsk) { this.showToast('已有待处理的协商请求'); return; }
      if (g.turn !== this.role) { this.showToast('还没轮到你走棋'); return; }
      this.sendAsk('pass');
      return;
    }
    if (g.cfg.play !== 'hot') return;
    this.askCtx = 'pass';
    this.setData({ showAsk: true, askText: (g.turn === 'red' ? '红方' : '黑方') + '请求让一手（跳过本次行棋）。\n请' + (g.turn === 'red' ? '黑方' : '红方') + '（对方）选择是否同意。' });
  },

  onAskYes() {
    if (this.data.online) { this.onlineAnswer(true); return; }
    const type = this.askCtx;
    this.askCtx = null;
    this.setData({ showAsk: false });
    const g = this.G;
    if (!g || g.over) return;
    if (type === 'undo') {
      if (!this.revertOne()) return;
      g.busy = false;
      this.showToast('已悔一步，' + (g.turn === 'red' ? '红方' : '黑方') + '重新行棋');
      this.render();
    } else if (type === 'pass') {
      const from = g.turn;
      g.turn = opp(g.turn);
      g.moveNum++;
      this.showToast((from === 'red' ? '红方' : '黑方') + '让一手');
      this.render();
      if (!hasLegal(g, g.turn)) {
        this.endGame(from, (g.turn === 'red' ? '红方' : '黑方') + '无子可动');
        return;
      }
      g.busy = false;
      this.render();
    }
  },

  onAskNo() {
    if (this.data.online) { this.onlineAnswer(false); return; }
    this.askCtx = null;
    this.setData({ showAsk: false });
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
    setTimeout(() => { if (this.G && ep === this.epoch) this.setData({ showEnd: true }); }, 2200);   // 留时间看清最后一手
  },

  /** 终局弹窗「查看棋局」：关闭弹窗回看终局面 */
  onViewBoard() {
    this.setData({ showEnd: false, showEndBar: true });
  },
  /** 回看时悬浮条「结果」：重新打开终局弹窗 */
  onEndReopen() {
    this.setData({ showEndBar: false, showEnd: true });
  },

  /* ================= 随机陪练 ================= */
  aiMove() {
    const g = this.G;
    if (!g || g.over || g.busy || g.turn !== 'black') return;   // turn 校验：悔棋后遗留的定时器直接作废
    const mv = pickAIMove(g);
    if (!mv) return;
    this.tryMove(mv.p, mv.t);
  },

  /* ================= 联机 ================= */
  /** 进房：走 join 动作，房主重进也会命中原座位 */
  startOnline(rawCode: string) {
    this.epoch++;
    this.roomCode = String(rawCode || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    this.G = null;
    this.role = '';
    this.ver = 0;
    this.currentAsk = null;
    this.snaps = [];
    this.setData({
      online: true, roomCode: this.roomCode, onlineWait: true, netText: '连接中…',
      oppOffline: false, showEnd: false, showEndBar: false, showUndo: false,
      showAsk: false, showRules: false, canUndo: false, canPass: false
    });
    callRoom('join', { code: this.roomCode }).then(res => {
      if (!res.ok) {
        this.setData({ onlineWait: false, netText: '' });
        wx.showModal({
          title: '无法进入房间', content: res.msg || '房间不可用', showCancel: false,
          success: () => this.leavePage()
        });
        return;
      }
      this.role = res.role || '';
      this.ver = res.version || 1;
      if (res.state) this.G = this.toG(res.state);
      this.setData({ onlineWait: res.status === 'waiting' });
      this.render();
      this.startPoll();
      if (res.status !== 'waiting' && this.G) {
        this.showToast('你执' + (this.role === 'red' ? '红' : '黑') + '，' + (this.G.turn === this.role ? '轮到你走棋' : '等待对方走棋'), '', 2200);
      }
    });
  },

  /** 服务端棋局 → 本地 GameState（不含历史表，客户端只负责渲染与合法走法提示） */
  toG(st: RoomState): GameState {
    return {
      cfg: {
        shuffle: st.cfg.shuffle as Cfg['shuffle'],
        rule: st.cfg.rule as Cfg['rule'],
        play: 'online' as Cfg['play'],
        level: 'normal' as Cfg['level']
      },
      pieces: st.pieces.map((q: any) => ({ ...q, pos: q.pos ? { r: q.pos.r, c: q.pos.c } : null })),
      turn: st.turn,
      moveNum: st.moveNum,
      noCap: st.noCap,
      over: st.over,
      winner: st.winner,
      reason: st.reason,
      lastMove: st.lastMove ? { from: { ...st.lastMove.from }, to: { ...st.lastMove.to } } : null,
      history: [],
      repMap: {},
      selected: null,
      busy: false
    } as GameState;
  },

  startPoll() {
    this.stopPoll();
    this.polling = true;
    const tick = () => {
      if (!this.polling) return;
      this.syncOnce().then(() => {
        if (!this.polling) return;
        const wait = this.data.onlineWait ? 1800 : (this.G && this.G.over ? 4000 : 1300);
        this.netTimer = setTimeout(tick, wait) as unknown as number;
      });
    };
    tick();
  },
  stopPoll() {
    this.polling = false;
    if (this.netTimer) { clearTimeout(this.netTimer); this.netTimer = 0; }
  },

  syncOnce(): Promise<void> {
    if (this.syncing || !this.roomCode) return Promise.resolve();
    this.syncing = true;
    return callRoom('sync', { code: this.roomCode, since: this.ver }).then(res => {
      this.syncing = false;
      if (!res.ok) {
        this.setData({ netText: res.msg || '连接中断，正在重试…' });
        return;
      }
      this.onSync(res);
    });
  },

  onSync(res: RoomRes) {
    if (res.role) this.role = res.role;
    const waiting = res.status === 'waiting';
    const offline = !waiting && res.oppOnline === false;
    this.setData({ onlineWait: waiting, oppOffline: offline, netText: waiting ? '' : (offline ? '对方暂时离线…' : '') });
    if (waiting) return;
    if (typeof res.version === 'number' && res.version > this.ver) {
      this.ver = res.version;
      this.applyRemote(res, res.lastAction === 'move');
    }
    if (res.events && res.events.length) {
      const last = res.events[res.events.length - 1];
      if (last && last.text) this.showToast(last.text, last.cls || '', 2000);
    }
    this.handleAsk(res.ask || null);
  },

  /** 协商请求：只有在轮到自己决定时才弹窗 */
  handleAsk(ask: RoomAsk | null) {
    this.currentAsk = ask;
    if (!ask) {
      if (this.data.showAsk || this.data.showUndo) this.setData({ showAsk: false, showUndo: false });
    } else if (ask.decider === this.role) {
      if (ask.type === 'miseat') {
        this.setData({
          showUndo: true,
          undoText: '对方走子吃掉暗子，翻开后竟是己方「' + ((ask.info && ask.info.kingChar) || '将') + '」。\n请选择：同意则让对方悔一步，不同意则按吃将判负（对方输）。'
        });
      } else if (ask.type === 'undo') {
        this.setData({ showAsk: true, askText: sideName(ask.by) + '请求悔棋一步。\n请' + sideName(ask.decider) + '选择是否同意。' });
      } else {
        this.setData({ showAsk: true, askText: sideName(ask.by) + '请求让一手（跳过本次行棋）。\n请' + sideName(ask.decider) + '选择是否同意。' });
      }
      this.setData({ netText: '' });
    } else {
      this.setData({ netText: '等待对方处理请求…' });
    }
    this.render();
  },

  sendAsk(type: 'undo' | 'pass') {
    this.setData({ netText: type === 'undo' ? '发送悔棋请求…' : '发送让一手请求…' });
    callRoom('ask', { code: this.roomCode, type }).then(res => {
      if (!res.ok) { this.setData({ netText: '' }); this.showToast(res.msg || '请求发送失败'); return; }
      if (typeof res.version === 'number') this.ver = res.version;
      this.applyRemote(res, false);
      this.showToast(type === 'undo' ? '已请求悔棋，等待对方回应' : '已请求让一手，等待对方回应', '', 2000);
      this.handleAsk(res.ask || null);
    });
  },

  onlineAnswer(accept: boolean) {
    const ask = this.currentAsk;
    if (!ask) return;
    this.currentAsk = null;
    this.setData({ showAsk: false, showUndo: false, netText: '提交中…' });
    callRoom('answer', { code: this.roomCode, accept }).then(res => {
      if (!res.ok) {
        this.showToast(res.msg || '提交失败');
        this.handleAsk(ask);
        return;
      }
      if (typeof res.version === 'number') this.ver = res.version;
      this.applyRemote(res, false);
      this.setData({ netText: '' });
      if (res.events && res.events.length) this.showToast(res.events[res.events.length - 1].text || '', '', 2000);
      this.handleAsk(res.ask || null);
    });
  },

  onlineMove(p: Piece, t: Pos) {
    const g = this.G;
    if (!g || !p.pos) return;
    const from = { r: p.pos.r, c: p.pos.c };
    g.busy = true;
    g.selected = null;
    this.setData({ netText: '同步中…' });
    this.render();
    callRoom('move', { code: this.roomCode, from, to: { r: t.r, c: t.c }, ver: this.ver }).then(res => {
      if (!res.ok) {
        this.showToast(res.msg || '走子失败');
        this.setData({ netText: '' });
        if (this.G) { this.G.busy = false; this.render(); }
        return;
      }
      const animate = res.lastAction === 'move' && (res.version || 0) > this.ver;
      if (typeof res.version === 'number') this.ver = res.version;
      this.setData({ netText: '' });
      this.applyRemote(res, animate);
      this.handleAsk(res.ask || null);
    });
  },

  /** 应用服务端棋局：animate 时补上落子/吃子/翻开的节奏，保持与同屏模式一致的观感 */
  applyRemote(res: RoomRes, animateFlag: boolean) {
    const st = res.state;
    if (!st) return;
    const old = this.G;
    const alreadyOver = !!old && old.over;
    // 心跳也会推高版本号，只有 moveNum 真的变了才是新的一步，避免重复播放动画
    const animate = animateFlag && !!old && !alreadyOver && st.moveNum !== old.moveNum;
    const oldPieces = old ? old.pieces : [];
    const g = this.toG(st);
    const ep = this.epoch;

    let mover: Piece | null = null;
    let wasDark = false;
    if (animate && g.lastMove) {
      const to = g.lastMove.to;
      mover = g.pieces.find(q => !q.captured && !!q.pos && q.pos.r === to.r && q.pos.c === to.c) || null;
      if (mover) {
        const before = oldPieces.find(q => q.id === mover!.id);
        wasDark = !!before && !before.revealed;
      }
    }
    const dying: { id: string; pos: Pos }[] = [];
    for (const op of oldPieces) {
      if (op.captured || !op.pos) continue;
      const np = g.pieces.find(q => q.id === op.id);
      if (np && np.captured) dying.push({ id: op.id, pos: { r: op.pos.r, c: op.pos.c } });
    }

    this.dyingPos = {};
    this.dyingOut = {};
    for (const d of dying) this.dyingPos[d.id] = d.pos;
    if (mover && wasDark) mover.revealed = false;   // 先暗子落位，稍后翻开

    this.G = g;
    g.selected = null;
    g.busy = true;
    this.render();

    const alive = () => this.G === g && ep === this.epoch;

    if (!animate) {
      if (g.over) { if (!alreadyOver) this.finishRemote(g); return; }
      g.busy = false;
      this.render();
      return;
    }

    const tReveal = 620;
    const tCap = wasDark ? 900 : 360;
    this.vibrate(wasDark ? 'light' : (dying.length ? 'medium' : 'light'));

    if (dying.length) {
      setTimeout(() => {
        if (!alive()) return;
        for (const d of dying) this.dyingOut[d.id] = true;
        this.render();
      }, tCap);
      setTimeout(() => {
        if (!alive()) return;
        for (const d of dying) { delete this.dyingPos[d.id]; delete this.dyingOut[d.id]; }
        this.render();
      }, tCap + 480);
    }

    if (wasDark && mover) {
      setTimeout(() => {
        if (!alive() || !mover) return;
        mover.revealed = true;
        this.render();
        let msg = '翻开：' + (mover.color === 'red' ? '红' : '黑') + '·' + CHARS[mover.color][mover.type];
        if (dying.length) {
          const dp = g.pieces.find(q => q.id === dying[0].id);
          if (dp) msg += '；吃掉：' + (dp.color === 'red' ? '红' : '黑') + '·' + CHARS[dp.color][dp.type];
        }
        this.showToast(msg, '', 2000);
      }, tReveal);
    } else if (dying.length && mover) {
      const dp = g.pieces.find(q => q.id === dying[0].id);
      if (dp) this.showToast(sideName(mover.color) + '吃掉' + sideName(dp.color) + '·' + CHARS[dp.color][dp.type]);
    }

    setTimeout(() => {
      if (!alive()) return;
      if (g.over) { this.finishRemote(g); return; }
      g.busy = false;
      this.render();
      if (g.cfg.rule === 'check' && inCheck(g, g.turn)) {
        this.showToast(g.turn === this.role ? '你被将军！' : '将军！', 'red', 1500);
        this.vibrate('medium');
      }
    }, tCap + 520);
  },

  finishRemote(g: GameState) {
    g.busy = true;
    this.dyingPos = {};
    this.dyingOut = {};
    for (const p of g.pieces) p.revealed = true;
    this.render();
    this.vibrate('heavy');
    this.setData({
      endTitle: g.winner ? (g.winner === 'red' ? '红方胜' : '黑方胜') + (g.winner === this.role ? '（你）' : '') : '和棋',
      endTitleCls: g.winner === 'red' ? 'rr' : (g.winner === 'black' ? 'rb' : ''),
      endReason: g.reason,
      showEnd: false
    });
    const ep = this.epoch;
    setTimeout(() => { if (this.G === g && ep === this.epoch) this.setData({ showEnd: true }); }, 1400);
  },

  onResign() {
    if (!this.data.online || !this.G || this.G.over) return;
    wx.showModal({
      title: '认输', content: '确定认输吗？对方将获胜。',
      success: (r: any) => {
        if (!r.confirm) return;
        callRoom('resign', { code: this.roomCode }).then(res => {
          if (!res.ok) { this.showToast(res.msg || '操作失败'); return; }
          if (typeof res.version === 'number') this.ver = res.version;
          this.applyRemote(res, false);
        });
      }
    });
  },

  /** 离开对局页：正常返回上一页；从分享卡片直接进入（无上一页）时回首页 */
  leavePage() {
    this.stopPoll();
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  onCopyCode() {
    wx.setClipboardData({
      data: this.roomCode,
      success: () => this.showToast('房间码已复制'),
      fail: () => {}
    });
  },

  onQuitRoom() {
    wx.showModal({
      title: '关闭房间', content: '关闭后好友将无法加入，确定吗？',
      success: (r: any) => {
        if (!r.confirm) return;
        callRoom('close', { code: this.roomCode }).then(() => this.leavePage());
      }
    });
  },

  /* ================= 头部按钮 ================= */
  onRestart() {
    if (this.data.online) {
      wx.showModal({
        title: '退出房间',
        content: this.G && !this.G.over ? '退出将视为认输，确定退出？' : '确定退出房间？',
        success: (r: any) => {
          if (!r.confirm) return;
          const leave = () => this.leavePage();
          if (this.G && !this.G.over) callRoom('resign', { code: this.roomCode }).then(leave);
          else leave();
        }
      });
      return;
    }
    const g = this.G;
    if (g) this.startGame({ ...g.cfg });
  },
  /** 终局弹窗「再来一局」：同设置重新洗牌（含陪练难度） */
  onAgain() {
    const g = this.G;
    if (g) this.startGame({ ...g.cfg });
  },
  onBackSetup() {
    if (this.data.online) { this.leavePage(); return; }
    this.stopPoll();
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
    if (vibOn) this.vibrate('medium');   // 立即试震一下，方便确认手机有反应
  },

  vibrate(type: 'light' | 'medium' | 'heavy') {
    if (!this.data.vibOn) return;   // 用户已关闭震动
    // 选中/走子/翻子 light · 吃子/将军 medium · 终局 heavy
    // 部分安卓机型/基础库对 vibrateShort 带 type 参数会直接 fail，失败时回退 vibrateLong 保证有震感
    try {
      wx.vibrateShort({
        type,
        fail: () => { try { wx.vibrateLong({ fail: () => {} }); } catch (e) { /* 静默 */ } }
      });
    } catch (e) {
      try { wx.vibrateLong({ fail: () => {} }); } catch (e2) { /* 静默 */ }
    }
  }
});
