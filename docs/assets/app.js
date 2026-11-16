/**
 * 盲下象棋 · 网页版交互层
 * 规则全部来自与小程序共用的 engine.js（由 miniprogram/core/engine.ts 编译而来）。
 */
import {
  newGameState, legalTargets, pieceAt, operable, halfOwner, inCheck, hasLegal,
  hashState, clonePieces, pickAIMove, opp, CHARS, PIECE_XY
} from './engine.js';
import { ONLINE_READY, createRoom, fetchRoom, markJoined, pushState } from './net.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPTS = {
  shuffle: [
    { v: 'A1', name: 'A1 半盘内洗', desc: '将帅明置九宫原位，各 15 子在本方半盘内洗；归属可由位置推知' },
    { v: 'A2', name: 'A2 跨河全混', desc: '将帅明置，其余 30 子跨河混置；归属未知' },
    { v: 'B', name: 'B 全盘混洗', desc: '32 子含将帅全部暗置混洗；归属完全未知，最刺激' }
  ],
  rule: [
    { v: 'check', name: '将军规则', desc: '将军/应将/将死；仅对已翻开的将帅生效，暗将可被直接吃' },
    { v: 'kill', name: '吃将即胜', desc: '吃掉对方将/帅立即获胜，无将军应将流程' }
  ],
  play: [
    { v: 'hot', name: '双人同屏', desc: '面对面轮流操作同一部设备，信息双方公开' },
    { v: 'ai', name: 'AI 陪练', desc: '单人对弈，你执红先行；难度在下方选择' },
    { v: 'online', name: '联机对战', desc: '建房或输入房间码，和朋友异地对弈' }
  ],
  level: [
    { v: 'easy', name: '简单', desc: 'AI 随手乱走，适合熟悉规则' },
    { v: 'normal', name: '普通', desc: 'AI 倾向吃子，但时常漏算' },
    { v: 'hard', name: '困难', desc: 'AI 权衡吃子与风险，护将推进、不白送子' }
  ]
};

const SHUFFLE_NAME = { A1: 'A1 半盘内洗', A2: 'A2 跨河全混', B: 'B 全盘混洗' };
const RULE_NAME = { check: '将军规则', kill: '吃将即胜' };
const PLAY_NAME = { hot: '双人同屏', ai: 'AI 陪练', online: '联机对战' };
const LEVEL_NAME = { easy: '简单', normal: '普通', hard: '困难' };

const HELP_TEXT = [
  '1. 开局除将帅外，棋子背面朝上随机摆放（B 模式连将帅也暗置）。',
  '2. 暗子按它所在位置的「位置型棋种」走法移动，走完那一步才翻开。',
  '3. 轮到你时，可操作己方半盘的暗子和己方颜色的明子。',
  '4. 暗子谁都可以吃；误吃己方将帅按吃将判负，双人同屏可协商悔一步。',
  '5. 吃掉对方将帅立即获胜；将军规则下被将死或无子可动同样落败。',
  '6. 120 个半回合无吃子，或三次重复局面，判和。'
].join('\n');

const pieceLayer = $('#pieces');
const markLayer = $('#marks');
const hintLayer = $('#hints');

let cfg = loadCfg();
let sel = { ...cfg };
let g = null;
let snaps = [];
let selectedId = null;
let epoch = 0;
let aiTimer = 0;
let aiThinking = false;
let pieceEls = new Map();
let toastTimer = 0;
let modalFns = { ok: null, cancel: null };
/** 联机会话：{ code, color, version, joined, timer, pulling, localBusy, pending, fail } */
let online = null;

/* ---------------- 设置 ---------------- */

function loadCfg() {
  const base = { shuffle: 'A1', rule: 'check', play: 'hot', level: 'normal' };
  try {
    const raw = localStorage.getItem('blind-xiangqi-cfg');
    if (raw) {
      const o = JSON.parse(raw);
      for (const key of Object.keys(base)) {
        if (OPTS[key] && OPTS[key].some((x) => x.v === o[key])) base[key] = o[key];
      }
    }
  } catch (e) { /* 存储不可用时使用默认值 */ }
  return base;
}

function saveCfg() {
  try { localStorage.setItem('blind-xiangqi-cfg', JSON.stringify(sel)); } catch (e) { /* ignore */ }
}

function renderOpts() {
  const map = { shuffle: '#optShuffle', rule: '#optRule', play: '#optPlay', level: '#optLevel' };
  for (const key of Object.keys(map)) {
    const wrap = $(map[key]);
    wrap.innerHTML = '';
    for (const o of OPTS[key]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (sel[key] === o.v ? ' on' : '');
      b.setAttribute('aria-pressed', sel[key] === o.v ? 'true' : 'false');
      const name = document.createElement('span');
      name.className = 'opt-name';
      name.textContent = o.name;
      const desc = document.createElement('span');
      desc.className = 'opt-desc';
      desc.textContent = o.desc;
      b.append(name, desc);
      b.addEventListener('click', () => {
        sel[key] = o.v;
        saveCfg();
        renderOpts();
      });
      wrap.appendChild(b);
    }
  }
  $('#levelGroup').classList.toggle('hidden', sel.play !== 'ai');
  $('#onlineGroup').classList.toggle('hidden', sel.play !== 'online');
  $('#startRow').classList.toggle('hidden', sel.play === 'online');
  $('#onlineState').textContent = ONLINE_READY
    ? '建房方执红先行，加入方执黑。'
    : '联机未配置：请在 assets/config.js 填入 Supabase 地址与 anon key 后重新部署。';
  $('#createRoomBtn').disabled = !ONLINE_READY;
  $('#joinRoomBtn').disabled = !ONLINE_READY;
}

/* ---------------- 棋盘绘制 ---------------- */

function buildGrid() {
  const X = (c) => 80 + 100 * c;
  const Y = (r) => 90 + 100 * r;
  let s = '';
  s += `<rect x="80" y="90" width="800" height="900" rx="6" ry="6" fill="none" stroke="#8a6a45" stroke-width="6"/>`;
  for (let r = 0; r < 10; r++) s += `<line x1="${X(0)}" y1="${Y(r)}" x2="${X(8)}" y2="${Y(r)}"/>`;
  for (let c = 0; c < 9; c++) {
    if (c === 0 || c === 8) {
      s += `<line x1="${X(c)}" y1="${Y(0)}" x2="${X(c)}" y2="${Y(9)}"/>`;
    } else {
      s += `<line x1="${X(c)}" y1="${Y(0)}" x2="${X(c)}" y2="${Y(4)}"/>`;
      s += `<line x1="${X(c)}" y1="${Y(5)}" x2="${X(c)}" y2="${Y(9)}"/>`;
    }
  }
  s += `<path d="M${X(3)} ${Y(0)} L${X(5)} ${Y(2)} M${X(5)} ${Y(0)} L${X(3)} ${Y(2)} M${X(3)} ${Y(7)} L${X(5)} ${Y(9)} M${X(5)} ${Y(7)} L${X(3)} ${Y(9)}"/>`;
  s += `<text class="river" x="296" y="556">楚 河</text>`;
  s += `<text class="river" x="664" y="556">汉 界</text>`;
  $('#boardGrid').innerHTML = s;
}

function fitBoard() {
  const board = $('#board');
  if (!board) return;
  const w = board.clientWidth;
  if (!w) return;
  board.style.setProperty('--pfont', Math.round(w * 0.054) + 'px');
}

/* ---------------- 棋子渲染 ---------------- */

function place(el, pos) {
  const xy = PIECE_XY(pos.r, pos.c);
  el.style.left = xy.x.toFixed(3) + '%';
  el.style.top = xy.y.toFixed(3) + '%';
}

function syncPieces() {
  if (!g) return;
  const alive = new Set();
  for (const p of g.pieces) {
    if (p.captured || !p.pos) continue;
    alive.add(p.id);
    let el = pieceEls.get(p.id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'piece';
      el.dataset.id = p.id;
      el.innerHTML = '<span class="glyph"></span>';
      pieceLayer.appendChild(el);
      pieceEls.set(p.id, el);
    }
    place(el, p.pos);
    el.classList.toggle('red', p.revealed && p.color === 'red');
    el.classList.toggle('black', p.revealed && p.color === 'black');
    el.classList.toggle('dark', !p.revealed);
    el.classList.toggle('sel', p.id === selectedId);
    el.querySelector('.glyph').textContent = p.revealed ? CHARS[p.color][p.type] : '';
    el.setAttribute('aria-label', p.revealed
      ? (p.color === 'red' ? '红方' : '黑方') + CHARS[p.color][p.type]
      : '暗子');
    if (p.revealed && el.dataset.rev !== '1') {
      el.dataset.rev = '1';
      el.classList.add('flip');
      setTimeout(() => el.classList.remove('flip'), 360);
    } else if (!p.revealed) {
      el.dataset.rev = '';
    }
  }
  for (const [id, el] of Array.from(pieceEls.entries())) {
    if (!alive.has(id)) {
      pieceEls.delete(id);
      el.classList.add('gone');
      setTimeout(() => el.remove(), 240);
    }
  }
}

function rebuildPieces() {
  pieceEls.forEach((el) => el.remove());
  pieceEls.clear();
  pieceLayer.innerHTML = '';
}

function addMark(pos, kind) {
  const d = document.createElement('div');
  d.className = 'mark' + (kind === 'to' ? ' to' : '');
  place(d, pos);
  markLayer.appendChild(d);
}

function renderHints() {
  markLayer.innerHTML = '';
  hintLayer.innerHTML = '';
  if (!g) return;
  if (g.lastMove) {
    addMark(g.lastMove.from, 'from');
    addMark(g.lastMove.to, 'to');
  }
  if (g.over || !selectedId) return;
  const p = g.pieces.find((q) => q.id === selectedId);
  if (!p || !p.pos) return;
  for (const t of legalTargets(g, p)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'target' + (pieceAt(g, t) ? ' cap' : '');
    b.dataset.r = t.r;
    b.dataset.c = t.c;
    b.setAttribute('aria-label', '落子');
    place(b, t);
    hintLayer.appendChild(b);
  }
}

/* ---------------- 状态与提示 ---------------- */

function sideName(side) {
  return side === 'red' ? '红方' : '黑方';
}

function updateStatus() {
  if (!g) return;
  $('#turnDot').className = 'turn-dot' + (g.turn === 'black' ? ' black' : '');
  let text;
  if (g.over) {
    text = g.winner ? sideName(g.winner) + '胜' : '和棋';
  } else if (cfg.play === 'ai') {
    text = g.turn === 'red' ? '轮到你走棋' : '陪练思考中…';
  } else if (isOnline()) {
    text = !online.joined ? '等待对手加入' : (g.turn === online.color ? '轮到你走棋' : '等待对方走棋…');
  } else {
    text = sideName(g.turn) + '行棋';
  }
  $('#turnText').textContent = text;
  $('#moveText').textContent = '第 ' + g.moveNum + ' 手';
  $('#noCapText').textContent = '无吃子 ' + g.noCap + '/120';
  $('#undoBtn').disabled = !!g.over || isOnline();
  $('#resignBtn').disabled = !!g.over;

  const tip = $('#hintText');
  if (g.over) {
    tip.textContent = '本局已结束。';
  } else if (cfg.play === 'ai' && g.turn === 'black') {
    tip.textContent = '陪练正在思考…';
  } else if (isOnline() && !online.joined) {
    tip.textContent = '等待对手加入房间…';
  } else if (isOnline() && g.turn !== online.color) {
    tip.textContent = '等待对方走棋…';
  } else if (selectedId) {
    tip.textContent = '已选中棋子，点击亮点落子。';
  } else if (cfg.play === 'ai') {
    tip.textContent = '点击己方可操作的棋子，再点亮点落子。';
  } else if (isOnline()) {
    tip.textContent = '轮到你了：点击己方可操作的棋子。';
  } else {
    tip.textContent = sideName(g.turn) + '行棋：点击己方可操作的棋子。';
  }
}

function toast(msg, type) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast' + (type ? ' ' + type : '');
  }, 2000);
}

/* ---------------- 弹窗 ---------------- */

function openModal(o) {
  $('#modalTitle').textContent = o.title || '提示';
  $('#modalBody').textContent = o.body || '';
  $('#modalOk').textContent = o.okText || '确定';
  const cancelText = o.cancelText === undefined ? '取消' : o.cancelText;
  const cancel = $('#modalCancel');
  cancel.textContent = cancelText;
  cancel.classList.toggle('hidden', !cancelText);
  modalFns = { ok: o.onOk || null, cancel: o.onCancel || null };
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  modalFns = { ok: null, cancel: null };
}

/* ---------------- 对局流程 ---------------- */

function beginGame() {
  leaveOnline();
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  snaps = [];
  selectedId = null;
  hideEnd();
  hideWaiting();
  closeModal();
  g = newGameState(cfg);
  $('#setupView').classList.add('hidden');
  $('#gameView').classList.remove('hidden');
  renderCfgList();
  rebuildPieces();
  markLayer.innerHTML = '';
  hintLayer.innerHTML = '';
  syncPieces();
  renderHints();
  updateStatus();
  requestAnimationFrame(fitBoard);
}

function renderCfgList() {
  const rows = [
    ['洗牌', SHUFFLE_NAME[cfg.shuffle]],
    ['规则', RULE_NAME[cfg.rule]],
    ['模式', cfg.play === 'ai' ? 'AI 陪练 · ' + LEVEL_NAME[cfg.level] : PLAY_NAME[cfg.play]]
  ];
  if (isOnline()) {
    rows.push(['房间', online.code + ' · 你执' + (online.color === 'red' ? '红' : '黑')]);
    rows.push(['对手', online.joined ? '已加入' : '等待加入']);
  }
  $('#cfgList').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}

function toSetup() {
  leaveOnline();
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  g = null;
  snaps = [];
  selectedId = null;
  hideEnd();
  hideWaiting();
  closeModal();
  history.replaceState(null, '', location.pathname);
  $('#gameView').classList.add('hidden');
  $('#setupView').classList.remove('hidden');
  renderOpts();
}

function scheduleAI() {
  if (!g || g.over || cfg.play !== 'ai' || g.turn !== 'black') return;
  aiThinking = true;
  updateStatus();
  const ep = epoch;
  clearTimeout(aiTimer);
  aiTimer = setTimeout(() => {
    if (ep !== epoch || !g || g.over || g.turn !== 'black') return;
    aiThinking = false;
    const mv = pickAIMove(g, 'black');
    if (!mv) { updateStatus(); return; }
    playMove(mv.p, mv.t);
  }, 520 + Math.random() * 380);
}

async function playMove(p, t) {
  if (!g || g.over || g.busy || !p || !p.pos) return;
  const legal = legalTargets(g, p);
  if (!legal.some((x) => x.r === t.r && x.c === t.c)) return;

  const ep = epoch;
  g.busy = true;
  selectedId = null;

  const wasDark = !p.revealed;
  const moverSide = p.revealed ? p.color : halfOwner(p.pos);
  const target = pieceAt(g, t);
  const from = { r: p.pos.r, c: p.pos.c };
  const snap = {
    pieces: clonePieces(g),
    turn: g.turn,
    noCap: g.noCap,
    moveNum: g.moveNum,
    lastMove: g.lastMove ? { from: { ...g.lastMove.from }, to: { ...g.lastMove.to } } : null,
    flippedId: wasDark ? p.id : null,
    revealedIds: []
  };
  if (wasDark) snap.revealedIds.push(p.id);
  if (target && !target.revealed) snap.revealedIds.push(target.id);
  snaps.push(snap);

  if (target) {
    target.revealed = true;
    target.captured = true;
    target.pos = null;
    g.noCap = 0;
  } else {
    g.noCap++;
  }
  p.pos = { r: t.r, c: t.c };
  g.lastMove = { from, to: { r: t.r, c: t.c } };

  syncPieces();
  renderHints();
  updateStatus();

  await sleep(wasDark ? 300 : 200);
  if (ep !== epoch || !g) return;

  let msg = '';
  if (wasDark) {
    p.revealed = true;
    msg = '翻开：' + (p.color === 'red' ? '红' : '黑') + '·' + CHARS[p.color][p.type];
    if (target) {
      msg += '；吃掉' + (target.color === 'red' ? '红' : '黑') + '·' + CHARS[target.color][target.type];
    }
    syncPieces();
    renderHints();
  } else if (target) {
    msg = sideName(moverSide) + '吃掉' + (target.color === 'red' ? '红' : '黑') + '·' + CHARS[target.color][target.type];
  }
  if (msg) toast(msg, wasDark ? 'reveal' : '');

  if (wasDark) {
    await sleep(260);
    if (ep !== epoch || !g) return;
  }
  finishMove(p, target, moverSide);
}

function detectFaceOff() {
  const k = g.pieces.find((q) => q.type === 'K' && q.color === g.turn && !q.captured && q.revealed);
  const k2 = g.pieces.find((q) => q.type === 'K' && q.color !== g.turn && !q.captured && q.revealed);
  if (!k || !k.pos || !k2 || !k2.pos) return false;
  if (k.pos.c !== k2.pos.c) return false;
  let clear = true;
  const lo = Math.min(k.pos.r, k2.pos.r);
  const hi = Math.max(k.pos.r, k2.pos.r);
  for (let r = lo + 1; r < hi; r++) {
    if (pieceAt(g, { r, c: k.pos.c })) { clear = false; break; }
  }
  return clear && hi > lo;
}

function finishMove(p, target, moverSide) {
  if (!g) return;

  if (target && target.type === 'K') {
    if (target.color === moverSide) {
      misEatFlow(p, target, moverSide);
      return;
    }
    endGame(moverSide, sideName(moverSide) + '吃掉对方' + (target.color === 'red' ? '帅' : '将'));
    return;
  }

  const h = hashState(g);
  g.repMap[h] = (g.repMap[h] || 0) + 1;
  const gaveCheck = g.cfg.rule === 'check' && inCheck(g, opp(moverSide)) ? moverSide : null;
  g.history.push({ hash: h, checkBy: gaveCheck });

  if (g.repMap[h] >= 3) {
    const idx = g.history.map((e) => e.hash).lastIndexOf(h, g.history.length - 2);
    const seg = g.history.slice(Math.max(idx, 0));
    const givers = [];
    for (const e of seg) if (e.checkBy && givers.indexOf(e.checkBy) < 0) givers.push(e.checkBy);
    if (givers.length === 1) {
      endGame(opp(givers[0]), sideName(givers[0]) + '长将（重复局面判负）');
      return;
    }
    endGame(null, '三次重复局面，判和');
    return;
  }
  if (g.noCap >= 120) {
    endGame(null, '120 个半回合无吃子，判和');
    return;
  }

  g.turn = opp(g.turn);
  g.moveNum++;
  g.busy = false;
  syncPieces();
  renderHints();
  updateStatus();

  if (g.cfg.rule === 'check' && inCheck(g, g.turn)) {
    toast(detectFaceOff() ? '将帅对脸！' : '将军！', 'check');
  }
  if (!hasLegal(g, g.turn)) {
    endGame(moverSide, sideName(g.turn) + (inCheck(g, g.turn) ? '被将死' : '无子可动'));
    return;
  }
  if (cfg.play === 'ai' && g.turn === 'black') scheduleAI();
  if (isOnline()) commitOnline();
}

/* ---------------- 悔棋 / 误吃 / 认输 / 终局 ---------------- */

function restoreSnap(snap, extraReveal) {
  g.pieces = snap.pieces.map((q) => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
  g.turn = snap.turn;
  g.noCap = snap.noCap;
  g.moveNum = snap.moveNum;
  g.lastMove = snap.lastMove
    ? { from: { ...snap.lastMove.from }, to: { ...snap.lastMove.to } }
    : null;
  g.selected = null;
  g.busy = false;
  g.repMap = {};
  for (const e of g.history) g.repMap[e.hash] = (g.repMap[e.hash] || 0) + 1;
  const reveal = (snap.revealedIds || []).concat(extraReveal || []);
  for (const id of reveal) {
    const q = g.pieces.find((x) => x.id === id);
    if (q) q.revealed = true;
  }
}

function revertOne() {
  const snap = snaps.pop();
  if (!snap) return false;
  if (g.history.length) g.history.pop();
  restoreSnap(snap, [snap.flippedId].filter(Boolean));
  return true;
}

function misEatFlow(attacker, king, moverSide) {
  const snap = snaps.pop();
  const winner = opp(moverSide);
  if (cfg.play === 'ai') {
    endGame(winner, sideName(moverSide) + '误吃己方将帅（人机对局不提供协商，判负）');
    return;
  }
  if (isOnline()) {
    endGame(winner, sideName(moverSide) + '误吃己方将帅（联机不提供协商），判负');
    return;
  }
  openModal({
    title: '误吃己方将帅',
    body: sideName(moverSide) + '走子吃掉暗子，翻开后竟是己方「' + CHARS[king.color][king.type] + '」。\n'
      + '请' + sideName(winner) + '选择：同意则悔一步（攻子退回原位、将帅放回并保持翻开），不同意则按吃将判负。',
    okText: '同意悔棋',
    cancelText: '不同意（判负）',
    onOk() {
      closeModal();
      if (!snap) { endGame(winner, sideName(moverSide) + '误吃己方将帅，判负'); return; }
      restoreSnap(snap, [attacker.id, king.id]);
      selectedId = null;
      rebuildPieces();
      syncPieces();
      renderHints();
      updateStatus();
      toast('已悔一步，' + sideName(g.turn) + '重新行棋', 'reveal');
    },
    onCancel() {
      closeModal();
      endGame(winner, sideName(moverSide) + '误吃己方将帅，赢方不同意悔棋，判负');
    }
  });
}

function endGame(winner, reason) {
  if (!g) return;
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  g.over = true;
  g.winner = winner;
  g.reason = reason;
  g.busy = true;
  g.selected = null;
  selectedId = null;
  for (const p of g.pieces) p.revealed = true;
  syncPieces();
  renderHints();
  updateStatus();
  renderEnd();
  if (isOnline()) commitOnline();
}

function renderEnd() {
  if (!g) return;
  const winner = g.winner;
  let title = '和棋';
  if (winner) {
    if (cfg.play === 'ai') title = winner === 'red' ? '你赢了' : '陪练获胜';
    else if (isOnline()) title = winner === online.color ? '你赢了' : '对手获胜';
    else title = sideName(winner) + '胜';
  }
  const titleEl = $('#endTitle');
  titleEl.textContent = title;
  titleEl.className = 'end-title' + (winner ? (winner === 'red' ? '' : ' black') : ' draw');
  $('#endReason').textContent = g.reason || '';
  $('#endOverlay').classList.remove('hidden');
}

function hideEnd() {
  const el = $('#endOverlay');
  if (el) el.classList.add('hidden');
}

function onUndo() {
  if (!g || g.over || g.busy) return;
  if (isOnline()) { toast('联机对局暂不支持悔棋'); return; }
  if (!snaps.length) { toast('没有可悔的着法'); return; }

  if (cfg.play === 'hot') {
    const req = opp(g.turn);
    const decider = g.turn;
    openModal({
      title: '悔棋请求',
      body: sideName(req) + '请求悔棋一步。\n请' + sideName(decider) + '选择是否同意。',
      okText: '同意',
      cancelText: '拒绝',
      onOk() {
        closeModal();
        if (!revertOne()) return;
        rebuildPieces();
        syncPieces();
        renderHints();
        updateStatus();
        toast('已悔一步，' + sideName(g.turn) + '重新行棋');
      },
      onCancel() { closeModal(); }
    });
    return;
  }

  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  const n = g.turn === 'red' ? 2 : 1;
  let done = false;
  for (let i = 0; i < n && snaps.length; i++) {
    if (revertOne()) done = true;
  }
  if (!done) { toast('没有可悔的着法'); updateStatus(); return; }
  rebuildPieces();
  syncPieces();
  renderHints();
  updateStatus();
  toast('已悔棋，重新行棋');
  if (g.turn === 'black' && !g.over) scheduleAI();
}

function onResign() {
  if (!g || g.over) return;
  const loser = isOnline() ? online.color : (cfg.play === 'ai' ? 'red' : g.turn);
  openModal({
    title: '认输',
    body: isOnline()
      ? '确定认输吗？认输后对手获胜，本局立即结束。'
      : '确定' + sideName(loser) + '认输吗？对方将获胜。',
    okText: '确认认输',
    cancelText: '继续对局',
    onOk() {
      closeModal();
      endGame(opp(loser), isOnline() ? '对方认输，你获胜' : sideName(loser) + '认输');
    }
  });
}

function onRestart() {
  if (!g) return;
  openModal({
    title: '重开本局',
    body: isOnline() ? '重开会同步重置双方的棋盘，确定吗？' : '确定重开吗？当前进度将丢失。',
    okText: '重开',
    cancelText: '取消',
    onOk() {
      closeModal();
      if (isOnline()) resetOnlineGame();
      else beginGame();
    }
  });
}

/* ---------------- 联机 ---------------- */

const ROOM_KEY = 'blind-xiangqi-room';

function isOnline() {
  return !!online;
}

function loadRoom() {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveRoom(code, color) {
  try { localStorage.setItem(ROOM_KEY, JSON.stringify({ code, color })); } catch (e) { /* 忽略隐私模式报错 */ }
}

function leaveOnline() {
  stopPolling();
  online = null;
}

function encodeState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  copy.selected = null;
  copy.busy = false;
  return copy;
}

function decodeState(state) {
  const next = JSON.parse(JSON.stringify(state));
  next.selected = null;
  next.busy = false;
  if (!next.cfg) next.cfg = { ...cfg };
  next.cfg.play = 'online';
  return next;
}

function showWaiting(code) {
  $('#roomCodeText').textContent = code;
  $('#waitOverlay').classList.remove('hidden');
}

function hideWaiting() {
  const el = $('#waitOverlay');
  if (el) el.classList.add('hidden');
}

function stopPolling() {
  if (online && online.timer) {
    clearInterval(online.timer);
    online.timer = 0;
  }
}

function startPolling() {
  stopPolling();
  if (!online) return;
  online.timer = setInterval(pullRoom, 1500);
  pullRoom();
}

async function pullRoom() {
  if (!online || online.pulling || online.localBusy) return;
  if (g && g.busy) return;
  online.pulling = true;
  try {
    const room = await fetchRoom(online.code);
    if (!online) return;
    if (!room) { stopPolling(); toast('房间已不存在'); return; }
    online.fail = 0;
    if (room.version > online.version) applyRemote(room);
  } catch (err) {
    if (!online) return;
    online.fail = (online.fail || 0) + 1;
    if (online.fail === 3) toast('网络有点慢，正在重试…');
  } finally {
    if (online) online.pulling = false;
  }
}

function diffReveal(prev, next) {
  const before = new Map();
  for (const p of prev.pieces) before.set(p.id, p);
  const out = [];
  for (const p of next.pieces) {
    const old = before.get(p.id);
    if (!old || old.revealed || !p.revealed) continue;
    const label = (p.color === 'red' ? '红' : '黑') + '·' + CHARS[p.color][p.type];
    out.push((p.captured ? '被吃 ' : '翻开 ') + label);
  }
  return out.slice(0, 3);
}

function applyRemote(room) {
  if (!g || !online) return;
  if (g.busy) { online.pending = room; return; }
  online.version = room.version;
  if (!online.joined && room.guest_joined) {
    online.joined = true;
    hideWaiting();
    renderCfgList();
    toast('对手已加入，开始对局', 'reveal');
  }
  const next = decodeState(room.state);
  const msgs = diffReveal(g, next);
  const needRebuild = next.history.length < g.history.length;
  g = next;
  if (needRebuild) rebuildPieces();
  selectedId = null;
  syncPieces();
  renderHints();
  updateStatus();
  if (msgs.length) toast(msgs.join('；'), 'reveal');
  if (g.over) renderEnd();
}

async function commitOnline() {
  if (!online || !g) return;
  online.localBusy = true;
  const payload = encodeState(g);
  const base = online.version;
  try {
    const row = await pushState(online.code, base, payload);
    if (!row) throw new Error('conflict');
    online.version = row.version;
    online.fail = 0;
  } catch (err) {
    try {
      const room = await fetchRoom(online.code);
      if (room && online && room.version > online.version) {
        online.localBusy = false;
        applyRemote(room);
      }
      toast('局面已被对手更新，已同步');
    } catch (e2) {
      toast('同步失败，请检查网络');
    }
  } finally {
    if (online) {
      online.localBusy = false;
      const pending = online.pending;
      online.pending = null;
      if (pending && pending.version > online.version) applyRemote(pending);
    }
  }
}

function beginOnlineGame(room, color) {
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  snaps = [];
  selectedId = null;
  hideEnd();
  hideWaiting();
  closeModal();
  cfg = { ...sel, play: 'online' };
  g = decodeState(room.state);
  online = {
    code: room.code,
    color,
    version: room.version,
    joined: !!room.guest_joined,
    timer: 0,
    pulling: false,
    localBusy: false,
    pending: null,
    fail: 0
  };
  saveRoom(room.code, color);
  $('#setupView').classList.add('hidden');
  $('#gameView').classList.remove('hidden');
  renderCfgList();
  rebuildPieces();
  markLayer.innerHTML = '';
  hintLayer.innerHTML = '';
  syncPieces();
  renderHints();
  updateStatus();
  requestAnimationFrame(fitBoard);
  if (online.joined) hideWaiting();
  else showWaiting(online.code);
  startPolling();
}

function resetOnlineGame() {
  if (!online) return;
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  snaps = [];
  selectedId = null;
  hideEnd();
  g = newGameState({ ...cfg, play: 'online' });
  g.cfg.play = 'online';
  rebuildPieces();
  markLayer.innerHTML = '';
  hintLayer.innerHTML = '';
  syncPieces();
  renderHints();
  updateStatus();
  commitOnline();
  toast('已重开，正在同步双方棋盘');
}

async function onCreateRoom() {
  if (!ONLINE_READY) { toast('联机未配置，请先填写 config.js'); return; }
  leaveOnline();
  const btn = $('#createRoomBtn');
  btn.disabled = true;
  try {
    sel.play = 'online';
    const fresh = newGameState({ ...sel, play: 'online' });
    fresh.cfg.play = 'online';
    const room = await createRoom(encodeState(fresh));
    beginOnlineGame(room, 'red');
  } catch (err) {
    openModal({
      title: '建房失败',
      body: '创建房间时出错：\n' + err.message + '\n请稍后重试，或检查 assets/config.js 里的 Supabase 配置。',
      okText: '知道了',
      cancelText: ''
    });
  } finally {
    btn.disabled = !ONLINE_READY;
  }
}

async function joinByCode(raw) {
  if (!ONLINE_READY) { toast('联机未配置，请先填写 config.js'); return; }
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (code.length !== 6) { toast('请输入 6 位房间码'); return; }
  const btn = $('#joinRoomBtn');
  btn.disabled = true;
  try {
    let room = await fetchRoom(code);
    if (!room) { toast('房间不存在或已过期'); return; }
    const saved = loadRoom();
    let color = saved && saved.code === code ? saved.color : null;
    if (!color) {
      if (room.guest_joined) { toast('房间已满，无法加入'); return; }
      const joined = await markJoined(code, room.version);
      if (!joined) { toast('加入失败，请再试一次'); return; }
      room = joined;
      color = 'black';
    }
    sel.play = 'online';
    leaveOnline();
    beginOnlineGame(room, color);
  } catch (err) {
    openModal({
      title: '加入失败',
      body: '加入房间时出错：\n' + err.message + '\n请检查房间码是否正确、网络是否可用。',
      okText: '知道了',
      cancelText: ''
    });
  } finally {
    btn.disabled = !ONLINE_READY;
  }
}

async function copyInviteLink() {
  if (!online) return;
  const url = location.origin + location.pathname + '?room=' + online.code;
  try {
    await navigator.clipboard.writeText(url);
    toast('邀请链接已复制，发给朋友即可');
  } catch (err) {
    openModal({ title: '邀请链接', body: url, okText: '知道了', cancelText: '' });
  }
}

/* ---------------- 交互绑定 ---------------- */

function onBoardClick(e) {
  if (!g || g.over || g.busy) return;
  if (isOnline()) {
    if (!online.joined) { toast('等待对手加入房间'); return; }
    if (g.turn !== online.color) { toast('还没轮到你走棋'); return; }
  }

  const targetEl = e.target.closest('.target');
  if (targetEl) {
    const p = g.pieces.find((q) => q.id === selectedId);
    if (!p) return;
    playMove(p, { r: Number(targetEl.dataset.r), c: Number(targetEl.dataset.c) });
    return;
  }

  const el = e.target.closest('.piece');
  if (!el) return;
  const p = g.pieces.find((q) => q.id === el.dataset.id);
  if (!p || !p.pos) return;

  if (cfg.play === 'ai' && g.turn === 'black') { toast('陪练思考中…'); return; }

  if (!operable(g, p, g.turn)) {
    if (p.revealed) toast('这是' + (p.color === 'red' ? '红' : '黑') + '方明子，由对方操作');
    else toast('该暗子在' + (halfOwner(p.pos) === 'red' ? '红' : '黑') + '方半盘，由对方操作');
    return;
  }

  selectedId = selectedId === p.id ? null : p.id;
  syncPieces();
  renderHints();
  updateStatus();
}

function bind() {
  $('#startBtn').addEventListener('click', () => {
    cfg = { ...sel };
    saveCfg();
    beginGame();
  });
  $('#board').addEventListener('click', onBoardClick);
  $('#undoBtn').addEventListener('click', onUndo);
  $('#resignBtn').addEventListener('click', onResign);
  $('#restartBtn').addEventListener('click', onRestart);
  $('#backBtn').addEventListener('click', toSetup);
  $('#againBtn').addEventListener('click', () => {
    if (isOnline()) resetOnlineGame();
    else beginGame();
  });
  $('#toSetupBtn').addEventListener('click', toSetup);
  $('#createRoomBtn').addEventListener('click', onCreateRoom);
  $('#joinRoomBtn').addEventListener('click', () => joinByCode($('#roomInput').value));
  $('#roomInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinByCode($('#roomInput').value);
  });
  $('#copyLinkBtn').addEventListener('click', copyInviteLink);
  $('#cancelRoomBtn').addEventListener('click', toSetup);
  $('#helpBtn').addEventListener('click', () => {
    openModal({ title: '玩法速览', body: HELP_TEXT, okText: '知道了', cancelText: '' });
  });

  $('#modalOk').addEventListener('click', () => {
    const fn = modalFns.ok;
    modalFns = {};
    if (fn) fn(); else closeModal();
  });
  $('#modalCancel').addEventListener('click', () => {
    const fn = modalFns.cancel;
    modalFns = {};
    if (fn) fn(); else closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
  });
  window.addEventListener('resize', fitBoard);
}

buildGrid();
renderOpts();
bind();
if (window.ResizeObserver) new ResizeObserver(fitBoard).observe($('#board'));

// 邀请链接：?room=CODE 直接进入加入流程
const inviteCode = new URLSearchParams(location.search).get('room');
if (inviteCode) {
  sel.play = 'online';
  renderOpts();
  $('#roomInput').value = inviteCode.toUpperCase();
  joinByCode(inviteCode);
}
