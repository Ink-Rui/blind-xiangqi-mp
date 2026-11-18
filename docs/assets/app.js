/**
 * 盲下象棋 · 网页版交互层
 * 规则全部来自与小程序共用的 engine.js（由 miniprogram/core/engine.ts 编译而来）。
 */
import {
  newGameState, legalTargets, pieceAt, operable, halfOwner, inCheck, hasLegal,
  clonePieces, pickAIMove, opp, CHARS, NAMES, PIECE_XY
} from './engine.js';
import { ONLINE_READY, createRoom, fetchRoom, markJoined, pushState, touchRoom } from './net.js';
import { SUPABASE_URL } from './config.js';
import { sideName, recordPosition, repetitionOutcome, noCaptureOutcome, kingCaptureOutcome } from './rules.js';
import { emptyStats, applyResult, formatDuration, winRate, loadStats, saveStats } from './stats.js';

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
/** 暗子选中时显示的「位置型棋种」单字（与真实身份无关，仅提示该格走法） */
const SLOT_CHAR = { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '兵' };

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
let moveLog = [];
let selectedId = null;
let epoch = 0;
let aiTimer = 0;
let aiThinking = false;
let pieceEls = new Map();
let toastTimer = 0;
let vibOn = true;
try { vibOn = localStorage.getItem('blind-xiangqi-vib') !== 'off'; } catch (e) { /* ignore */ }
let modalFns = { ok: null, cancel: null };
/** 联机会话：{ code, color, version, joined, timer, pulling, localBusy, pending, fail } */
let online = null;
/** 回放帧：每一次有效走子后记录一份轻量棋盘快照 */
let frames = [];
/** 回放状态：{ idx, timer, saved, savedSel } */
let review = null;
/** 计时与本地战绩 */
let gameStart = 0;
let lastMoveAt = 0;
let clockTimer = 0;
let elapsedFinal = 0;
let statsRecorded = false;
let stats = emptyStats();
try { stats = loadStats(window.localStorage); } catch (e) { /* 隐私模式下退化为空战绩 */ }
/** Android/Chrome 的安装事件 */
let installPrompt = null;

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
  board.style.setProperty('--pfont', Math.round(w * 0.05) + 'px');
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
    const glyph = el.querySelector('.glyph');
    const typeHint = !p.revealed && p.id === selectedId;
    glyph.textContent = p.revealed
      ? CHARS[p.color][p.type]
      : (typeHint ? (SLOT_CHAR[p.slotType] || '?') : '?');
    glyph.classList.toggle('typehint', typeHint);
    el.setAttribute('aria-label', p.revealed
      ? (p.color === 'red' ? '红方' : '黑方') + CHARS[p.color][p.type]
      : (typeHint ? '暗子，此位置按' + NAMES[p.slotType] + '走' : '暗子'));
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

function vibrate(ms) {
  if (!vibOn || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(ms); } catch (e) { /* 部分浏览器不支持 */ }
}

function syncVibBtn() {
  const btn = $('#vibBtn');
  btn.textContent = vibOn ? '震动开' : '震动关';
  btn.classList.toggle('muted', !vibOn);
}

/* ---------------- 音效（WebAudio 合成，无外部资源） ---------------- */
let soundOn = true;
try { soundOn = localStorage.getItem('blind-xiangqi-sound') !== 'off'; } catch (e) { /* ignore */ }
let audioCtx = null;

function audio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(freq, dur, type, gain, delay) {
  if (!soundOn) return;
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + (delay || 0);
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  vol.gain.setValueAtTime(0.0001, t0);
  vol.gain.exponentialRampToValueAtTime(gain || 0.05, t0 + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(vol).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function sfx(kind) {
  if (kind === 'select') tone(880, 0.05, 'triangle', 0.03);
  else if (kind === 'move') tone(420, 0.07, 'sine', 0.05);
  else if (kind === 'reveal') { tone(660, 0.09, 'triangle', 0.05); tone(990, 0.12, 'triangle', 0.04, 0.07); }
  else if (kind === 'capture') { tone(180, 0.16, 'sawtooth', 0.05); tone(110, 0.2, 'square', 0.02, 0.02); }
  else if (kind === 'win') { tone(523, 0.12, 'triangle', 0.05); tone(659, 0.12, 'triangle', 0.05, 0.1); tone(784, 0.22, 'triangle', 0.05, 0.2); }
  else if (kind === 'lose') { tone(392, 0.16, 'sine', 0.045); tone(311, 0.2, 'sine', 0.045, 0.14); tone(262, 0.26, 'sine', 0.04, 0.3); }
  else if (kind === 'draw') { tone(392, 0.18, 'sine', 0.04); tone(330, 0.22, 'sine', 0.04, 0.14); }
}

function syncSoundBtn() {
  const btn = $('#soundBtn');
  btn.textContent = soundOn ? '音效开' : '音效关';
  btn.classList.toggle('muted', !soundOn);
}

function updateStatus() {
  if (!g) return;
  const chip = $('#turnChip');
  let cls = 'turn-chip';
  let text;
  if (g.over) {
    text = g.winner ? sideName(g.winner) + '胜' : '和棋';
    cls += ' over';
  } else if (cfg.play === 'ai') {
    const mine = g.turn === 'red';
    text = mine ? '轮到你走棋' : '陪练思考中…';
    cls += mine ? ' red' : ' black thinking';
  } else if (isOnline()) {
    const mine = g.turn === online.color;
    text = !online.joined ? '等待对手加入' : (mine ? '轮到你走棋' : '等待对方走棋…');
    cls += mine ? ' red' : ' black';
  } else {
    text = sideName(g.turn) + '行棋';
    cls += g.turn === 'red' ? ' red' : ' black';
  }
  chip.className = cls;
  chip.textContent = text;

  $('#moveChip').textContent = '第 ' + g.moveNum + ' 手';
  $('#noCapChip').textContent = '无吃子 ' + g.noCap + '/120';
  $('#undoBtn').disabled = !!g.over || isOnline();
  $('#resignBtn').disabled = !!g.over;
  renderCfgList();
  renderTrays();

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
    const p = g.pieces.find((q) => q.id === selectedId);
    if (p && !p.revealed && p.slotType) {
      tip.textContent = '暗子：按此位置的「' + NAMES[p.slotType] + '」走法行棋，点亮点落子后翻开。';
    } else if (p) {
      tip.textContent = '已选中' + CHARS[p.color][p.type] + '，点击亮点落子。';
    } else {
      tip.textContent = '已选中棋子，点击亮点落子。';
    }
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

/* ---------------- 计时 / 战绩 / 回放 ---------------- */

function startClock() {
  stopClock();
  gameStart = Date.now();
  lastMoveAt = gameStart;
  elapsedFinal = 0;
  syncClock();
  clockTimer = setInterval(syncClock, 1000);
}

function stopClock() {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = 0;
  }
}

function elapsedMs() {
  if (elapsedFinal) return elapsedFinal;
  return gameStart ? Date.now() - gameStart : 0;
}

function syncClock() {
  const el = $('#timeChip');
  if (!el) return;
  el.textContent = '用时 ' + formatDuration(elapsedMs());
}

/** 计入战绩的一方；双人同屏不区分个人胜负 */
function humanSide() {
  if (cfg.play === 'ai') return 'red';
  if (isOnline() && online) return online.color;
  return null;
}

function recordResult() {
  if (!g || !g.over || statsRecorded) return;
  const mine = humanSide();
  if (!mine) return;
  statsRecorded = true;
  const result = !g.winner ? 'draw' : (g.winner === mine ? 'win' : 'loss');
  stats = applyResult(stats, {
    at: Date.now(),
    mode: cfg.play,
    result,
    moves: moveLog.length,
    ms: elapsedMs()
  });
  saveStats(window.localStorage, stats);
  renderStats();
}

function renderStats() {
  const nums = $('#statsNums');
  if (!nums) return;
  const s = stats;
  $('#statsSub').textContent = s.games
    ? '胜率 ' + winRate(s) + '% · 最高连胜 ' + s.best
    : 'AI 与联机对局计入';
  const cells = [['局数', s.games], ['胜', s.wins], ['负', s.losses], ['和', s.draws], ['连胜', s.streak]];
  nums.innerHTML = cells.map(([k, v]) => '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>').join('');
  const recent = $('#statsRecent');
  if (!s.recent.length) {
    recent.innerHTML = '<li class="stats-empty">还没有完成的对局</li>';
    return;
  }
  const modeName = { ai: 'AI', online: '联机' };
  const word = { win: '胜', loss: '负', draw: '和' };
  recent.innerHTML = s.recent.map((r) => {
    const d = new Date(r.at || 0);
    const day = (d.getMonth() + 1) + '/' + d.getDate();
    return '<li><i class="res ' + r.result + '">' + word[r.result] + '</i>'
      + '<span>' + modeName[r.mode] + ' · ' + r.moves + ' 手 · ' + formatDuration(r.ms) + '</span>'
      + '<em>' + day + '</em></li>';
  }).join('');
}

function coordText(pos) {
  return '(' + (pos.c + 1) + ',' + (pos.r + 1) + ')';
}

/** 当前局面 → 回放帧（只保留渲染所需字段） */
function frameNow(label) {
  return {
    label: label || '',
    turn: g.turn,
    moveNum: g.moveNum,
    noCap: g.noCap,
    pieces: g.pieces.map((p) => ({
      id: p.id,
      color: p.color,
      type: p.type,
      slotType: p.slotType,
      revealed: !!p.revealed,
      captured: !!p.captured,
      pos: p.pos ? { r: p.pos.r, c: p.pos.c } : null
    })),
    lastMove: g.lastMove ? { from: { ...g.lastMove.from }, to: { ...g.lastMove.to } } : null
  };
}

function resetFrames() {
  frames = g ? [frameNow('开局')] : [];
}

/** 走子完成后追加一帧，label 即棋谱里的一行 */
function pushMoveFrame() {
  const m = moveLog[moveLog.length - 1];
  let label = '开局';
  if (m) {
    label = '第 ' + m.no + ' 手 · ' + sideName(m.side) + ' ' + m.piece + ' '
      + coordText(m.from) + '→' + coordText(m.to)
      + (m.capture ? ' 吃' + m.capture : '')
      + (m.ms ? ' · ' + (m.ms / 1000).toFixed(1) + 's' : '');
  }
  frames.push(frameNow(label));
}

function startReview() {
  if (!g) return;
  if (isOnline()) { toast('联机对局的回放暂未开放'); return; }
  if (frames.length < 2) { toast('还没有可回放的着法'); return; }
  if (review) return;
  stopClock();
  review = { idx: 0, timer: 0, saved: g, savedSel: selectedId };
  hideEnd();
  $('#replayBar').classList.remove('hidden');
  showFrame(0);
}

function showFrame(i) {
  if (!review || !frames.length) return;
  const idx = Math.max(0, Math.min(frames.length - 1, i));
  review.idx = idx;
  const f = frames[idx];
  const pseudo = {
    pieces: f.pieces.map((p) => ({ ...p, pos: p.pos ? { ...p.pos } : null })),
    turn: f.turn,
    moveNum: f.moveNum,
    noCap: f.noCap,
    lastMove: f.lastMove ? { from: { ...f.lastMove.from }, to: { ...f.lastMove.to } } : null,
    history: [],
    repMap: {},
    cfg: { ...cfg },
    over: true,
    winner: null,
    selected: null,
    busy: true
  };
  g = pseudo;
  selectedId = null;
  rebuildPieces();
  markLayer.innerHTML = '';
  hintLayer.innerHTML = '';
  syncPieces();
  renderHints();
  $('#revLabel').textContent = idx + '/' + (frames.length - 1) + ' · ' + (f.label || '开局');
  $('#revPrev').disabled = idx === 0;
  $('#revNext').disabled = idx >= frames.length - 1;
  $('#revPlay').textContent = review.timer ? '暂停' : '播放';
}

function stopReplay() {
  if (review && review.timer) {
    clearInterval(review.timer);
    review.timer = 0;
  }
}

function toggleReplay() {
  if (!review) return;
  if (review.timer) {
    stopReplay();
    showFrame(review.idx);
    return;
  }
  if (review.idx >= frames.length - 1) showFrame(0);
  review.timer = setInterval(() => {
    if (!review) return;
    if (review.idx >= frames.length - 1) {
      stopReplay();
      showFrame(review.idx);
      return;
    }
    showFrame(review.idx + 1);
  }, 700);
  showFrame(review.idx);
}

function exitReview() {
  if (!review) return;
  stopReplay();
  const saved = review.saved;
  review = null;
  g = saved;
  selectedId = null;
  $('#replayBar').classList.add('hidden');
  rebuildPieces();
  markLayer.innerHTML = '';
  hintLayer.innerHTML = '';
  syncPieces();
  renderHints();
  updateStatus();
  if (g && g.over) $('#endOverlay').classList.remove('hidden');
}

/* ---------------- 对局流程 ---------------- */

function setHeader(mode) {
  const game = mode === 'game';
  $('#brandBar').classList.toggle('hidden', game);
  $('#gameBar').classList.toggle('hidden', !game);
  $('#pageTitle').textContent = game ? '盲下象棋 · 对局' : '盲下象棋';
  $('#pageSub').textContent = game
    ? '暗子走完翻开 · 一半棋艺一半运气'
    : '标准棋盘 · 暗置洗牌 · 走完翻开';
  if (game) {
    const rc = $('#revealChip');
    rc.textContent = '翻开：—';
    rc.classList.add('hidden');
  }
}

function showReveal(msg) {
  const el = $('#revealChip');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function newDailyGame(c) {
  const orig = Math.random;
  Math.random = mulberry32(dailySeed(c.daily));
  try {
    return newGameState(c);
  } finally {
    Math.random = orig;
  }
}

function dailySeed(key) {
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function beginGame() {
  leaveOnline();
  if (review) exitReview();
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  snaps = [];
  moveLog = [];
  selectedId = null;
  statsRecorded = false;
  hideEnd();
  hideWaiting();
  closeModal();
  g = cfg.daily ? newDailyGame(cfg) : newGameState(cfg);
  resetFrames();
  startClock();
  $('#setupView').classList.add('hidden');
  $('#gameView').classList.remove('hidden');
  setHeader('game');
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
  if (!g) return;
  let text = (cfg.daily ? '今日一局 · ' : '') + SHUFFLE_NAME[cfg.shuffle] + ' · ' + RULE_NAME[cfg.rule] + ' · '
    + (cfg.play === 'ai' ? 'AI · ' + LEVEL_NAME[cfg.level] : PLAY_NAME[cfg.play]);
  if (isOnline()) text += ' · 房 ' + online.code;
  $('#modeChip').textContent = text;
  $('#modeChip').title = text;
}

/** 被吃掉的棋子托盘：红/黑各一列，行数随被吃数量增长 */
function renderTrays() {
  if (!g) return;
  const red = [];
  const black = [];
  for (const p of g.pieces) {
    if (!p.captured) continue;
    (p.color === 'red' ? red : black).push(CHARS[p.color][p.type]);
  }
  paintTray('#trayRed', red, 'red');
  paintTray('#trayBlack', black, 'black');
}

function paintTray(sel, chars, color) {
  const wrap = $(sel);
  if (!chars.length) {
    wrap.innerHTML = '<span class="tray-empty">尚无</span>';
    return;
  }
  wrap.innerHTML = chars.map((c) => '<span class="tp ' + color + '">' + c + '</span>').join('');
}

function toSetup() {
  if (review) exitReview();
  leaveOnline();
  epoch++;
  clearTimeout(aiTimer);
  aiThinking = false;
  stopClock();
  g = null;
  snaps = [];
  moveLog = [];
  frames = [];
  statsRecorded = false;
  delete sel.daily;
  delete cfg.daily;
  selectedId = null;
  hideEnd();
  hideWaiting();
  closeModal();
  history.replaceState(null, '', location.pathname);
  $('#gameView').classList.add('hidden');
  $('#setupView').classList.remove('hidden');
  setHeader('setup');
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
  }, 620 + Math.random() * 420);
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
  const thinkMs = lastMoveAt ? Date.now() - lastMoveAt : 0;
  const target = pieceAt(g, t);
  if (target) sfx('capture');
  else if (wasDark) sfx('reveal');
  else sfx('move');
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
  moveLog.push({
    no: moveLog.length + 1,
    side: moverSide,
    piece: CHARS[p.color][p.type],
    from,
    to: { r: t.r, c: t.c },
    capture: target ? CHARS[target.color][target.type] : '',
    reveal: wasDark,
    check: false,
    ms: thinkMs
  });

  syncPieces();
  renderHints();
  updateStatus();
  const movedEl = pieceEls.get(p.id);
  if (movedEl) {
    movedEl.classList.add('settle');
    setTimeout(() => movedEl.classList.remove('settle'), 320);
  }

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
  if (msg) {
    showReveal(msg);
    vibrate(wasDark ? 18 : 10);
  }

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

  const king = kingCaptureOutcome(target, moverSide);
  if (king) {
    if (king.self) misEatFlow(p, target, moverSide);
    else endGame(king.winner, king.reason);
    return;
  }

  pushMoveFrame();
  lastMoveAt = Date.now();

  const { hash, gaveCheck } = recordPosition(g, moverSide);
  if (moveLog.length) moveLog[moveLog.length - 1].check = !!gaveCheck;

  const rep = repetitionOutcome(g, hash);
  if (rep) { endGame(rep.winner, rep.reason); return; }
  const quiet = noCaptureOutcome(g);
  if (quiet) { endGame(quiet.winner, quiet.reason); return; }

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
  if (moveLog.length) moveLog.pop();
  if (frames.length > 1) frames.pop();
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
  stopClock();
  g.over = true;
  g.winner = winner;
  g.reason = reason;
  g.busy = true;
  g.selected = null;
  selectedId = null;
  for (const p of g.pieces) p.revealed = true;
  if (frames.length) frames.push(frameNow('终局 · ' + (winner ? sideName(winner) + '胜' : '和棋')));
  syncPieces();
  renderHints();
  updateStatus();
  renderEnd();
  if (isOnline()) commitOnline();
}

function resultTitle() {
  if (!g || !g.winner) return '和棋';
  if (cfg.play === 'ai') return g.winner === 'red' ? '你赢了' : '陪练获胜';
  if (isOnline()) return g.winner === online.color ? '你赢了' : '对手获胜';
  return sideName(g.winner) + '胜';
}

function renderEnd() {
  if (!g) return;
  if (!elapsedFinal) elapsedFinal = elapsedMs();
  recordResult();
  stopClock();
  syncClock();
  $('#endStats').textContent = endStatsText();
  const winner = g.winner;
  const mine = cfg.play === 'ai' ? 'red' : (isOnline() ? online.color : null);
  if (!winner) sfx('draw');
  else if (mine && winner !== mine) sfx('lose');
  else sfx('win');

  const titleEl = $('#endTitle');
  titleEl.textContent = resultTitle();
  titleEl.className = 'end-title' + (winner ? (winner === 'red' ? '' : ' black') : ' draw');
  $('#endReason').textContent = g.reason || '';
  $('#endOverlay').classList.remove('hidden');
}

function endStatsText() {
  const parts = ['本局用时 ' + formatDuration(elapsedMs())];
  if (moveLog.length) parts.push(moveLog.length + ' 手');
  if (humanSide()) parts.push('累计 ' + stats.wins + ' 胜 ' + stats.losses + ' 负 ' + stats.draws + ' 和');
  return parts.join(' · ');
}

function hideEnd() {
  const el = $('#endOverlay');
  if (el) el.classList.add('hidden');
}

/* ---------------- 战绩分享图 ---------------- */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = ch;
      y += lineH;
    } else {
      line += ch;
    }
  }
  if (line) ctx.fillText(line, x, y);
  return y;
}

function saveShareCard() {
  if (!g) return;
  const W = 750;
  const H = 1000;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d');
  const serif = '"Songti SC", "Noto Serif SC", "SimSun", serif';
  const sans = '"PingFang SC", "Microsoft YaHei", sans-serif';

  const bg = x.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f8f1e4');
  bg.addColorStop(1, '#e7dcc7');
  x.fillStyle = bg;
  x.fillRect(0, 0, W, H);

  x.fillStyle = 'rgba(120,95,55,.10)';
  for (let py = 14; py < H; py += 28) {
    for (let px = 14; px < W; px += 28) {
      x.beginPath();
      x.arc(px, py, 1.5, 0, Math.PI * 2);
      x.fill();
    }
  }

  roundRect(x, 40, 40, W - 80, H - 80, 30);
  x.fillStyle = 'rgba(255,252,245,.92)';
  x.fill();
  x.strokeStyle = 'rgba(120,95,55,.24)';
  x.lineWidth = 2;
  x.stroke();

  x.textAlign = 'center';
  x.fillStyle = '#2b2724';
  x.font = '700 34px ' + serif;
  x.fillText('盲 下 象 棋', W / 2, 148);
  x.fillStyle = '#8a7c69';
  x.font = '19px ' + sans;
  x.fillText('开局暗置 · 走完翻开 · 一半棋艺一半运气', W / 2, 186);

  x.fillStyle = g.winner === 'red' ? '#a02c24' : (g.winner ? '#2b2724' : '#857c72');
  x.font = '800 88px ' + serif;
  x.fillText(resultTitle(), W / 2, 330);

  x.fillStyle = '#7c7161';
  x.font = '23px ' + sans;
  wrapText(x, g.reason || '', W / 2, 386, W - 190, 34);

  x.strokeStyle = 'rgba(120,95,55,.22)';
  x.setLineDash([6, 8]);
  x.beginPath();
  x.moveTo(120, 490);
  x.lineTo(W - 120, 490);
  x.stroke();
  x.setLineDash([]);

  let redCap = 0;
  let blackCap = 0;
  for (const p of g.pieces) if (p.captured) (p.color === 'red' ? redCap++ : blackCap++);
  const playText = cfg.play === 'ai' ? 'AI 陪练 · ' + LEVEL_NAME[cfg.level] : PLAY_NAME[cfg.play];
  const rows = [
    ['洗牌模式', SHUFFLE_NAME[cfg.shuffle]],
    ['胜负规则', RULE_NAME[cfg.rule]],
    ['对局形式', playText],
    ['本局用时', formatDuration(elapsedMs()) + ' · ' + (moveLog.length || Math.max(0, g.moveNum - 1)) + ' 手'],
    ['被吃棋子', '红 ' + redCap + ' · 黑 ' + blackCap]
  ];
  if (humanSide()) {
    rows.push(['累计战绩', stats.wins + ' 胜 ' + stats.losses + ' 负 ' + stats.draws + ' 和 · 连胜 ' + stats.streak]);
  }
  x.textAlign = 'left';
  rows.forEach(([k, v], i) => {
    const y = 548 + i * 54;
    x.fillStyle = '#958a7a';
    x.font = '22px ' + sans;
    x.fillText(k, 120, y);
    x.fillStyle = '#2b2724';
    x.font = '600 23px ' + sans;
    x.textAlign = 'right';
    x.fillText(v, W - 120, y);
    x.textAlign = 'left';
  });

  const discs = [
    { cx: 250, label: '?', fill: '#e2d8c4', color: '#9a8d7a', ring: '#b7a98e' },
    { cx: 375, label: '帅', fill: '#a02c24', color: '#fff', ring: '#7e241d' },
    { cx: 500, label: '将', fill: '#2b2724', color: '#f3ead8', ring: '#17130f' }
  ];
  x.textAlign = 'center';
  for (const d of discs) {
    x.beginPath();
    x.arc(d.cx, 880, 34, 0, Math.PI * 2);
    x.fillStyle = d.fill;
    x.fill();
    x.strokeStyle = d.ring;
    x.lineWidth = 3;
    x.stroke();
    x.fillStyle = d.color;
    x.font = '700 36px ' + serif;
    x.fillText(d.label, d.cx, 894);
  }

  x.fillStyle = '#9a8e7c';
  x.font = '20px ' + sans;
  x.fillText('ink-rui.github.io/blind-xiangqi-mp', W / 2, 950);

  cv.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = '盲下象棋-战绩.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('战绩图已生成');
  });
}

function moveLogText() {
  const head = '对局记录：' + SHUFFLE_NAME[cfg.shuffle] + ' · ' + RULE_NAME[cfg.rule] + ' · ' + PLAY_NAME[cfg.play]
    + '\n括号内为(列,行)，列从左到右、行从红方底线往上，均从 1 起算；翻=落子后翻开，吃=吃掉棋子，将=将军。\n';
  const lines = moveLog.map((m) => {
    const side = m.side === 'red' ? '红' : '黑';
    const from = '(' + (m.from.c + 1) + ',' + (m.from.r + 1) + ')';
    const to = '(' + (m.to.c + 1) + ',' + (m.to.r + 1) + ')';
    return m.no + '. ' + side + ' ' + m.piece + ' ' + from + '→' + to
      + (m.reveal ? ' 翻' : '') + (m.capture ? ' 吃' + m.capture : '') + (m.check ? ' 将' : '');
  });
  return head + '\n' + lines.join('\n');
}

function showMoveLog() {
  if (!g) return;
  if (isOnline()) { toast('联机对局的棋谱暂未开放'); return; }
  if (!moveLog.length) { toast('还没有着法记录'); return; }
  const text = moveLogText();
  openModal({
    title: '棋谱',
    body: text,
    okText: '复制棋谱',
    cancelText: '关闭',
    onOk() {
      closeModal();
      const done = () => toast('棋谱已复制');
      const fail = () => toast('复制失败，请手动选择文本');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fail);
      } else {
        fail();
      }
    },
    onCancel() { closeModal(); }
  });
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
  if (review) exitReview();
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

/** 把联机失败分成「网络到不了服务」与「配置/房间问题」，给出可操作提示 */
function netErrorInfo(err) {
  const raw = (err && err.message) || String(err || '');
  const host = String(SUPABASE_URL || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || '联机服务';
  if (/Failed to fetch|Load failed|NetworkError|fetch failed|Network request failed|timed out|net::ERR/i.test(raw)) {
    return {
      title: '连不上联机服务',
      body: '请求没能到达 ' + host + '，通常是当前网络或代理把它拦住了。\n'
        + '1. 换手机流量、关闭代理或 VPN 后重试；\n'
        + '2. 浏览器直接打开 https://' + host + '/rest/v1/rooms?select=code&limit=1，能返回 [] 说明网络通畅；\n'
        + '3. 若长期被拦截，可换自定义域名或自建后端（见 README「联机后端」）。'
    };
  }
  if (/401|403|apikey|JWT|permission denied/i.test(raw)) {
    return {
      title: '联机配置无效',
      body: '联机服务拒绝了请求，常见原因是 anon key 失效或 rooms 表的 RLS 策略不对。\n'
        + '请检查 assets/config.js 与 supabase/schema.sql 中的配置。'
    };
  }
  if (/PGRST205|does not exist|relation|schema cache/i.test(raw)) {
    return {
      title: '联机表未就绪',
      body: '服务端找不到 rooms 表或字段。\n请按 supabase/schema.sql 建表，并补齐 host_seen / guest_seen 列后重试。'
    };
  }
  return {
    title: '联机请求失败',
    body: '原始错误：' + raw + '\n请稍后重试；若反复出现，可打开浏览器控制台查看请求状态。'
  };
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
  stopPresence();
  online = null;
  updatePresence(null);
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

function stopPresence() {
  if (online && online.seenTimer) {
    clearInterval(online.seenTimer);
    online.seenTimer = 0;
  }
}

/** 对手在线时间：红方看 guest_seen，黑方看 host_seen */
function opponentSeen(room) {
  if (!online) return null;
  const key = online.color === 'red' ? 'guest_seen' : 'host_seen';
  return room[key] || null;
}

function updatePresence(room) {
  const chip = $('#presenceChip');
  if (!chip) return;
  if (!online) {
    chip.classList.add('hidden');
    return;
  }
  if (online.offline) {
    chip.textContent = '连接中断，重连中…';
    chip.title = '点击查看联机诊断';
    chip.classList.remove('hidden', 'muted');
    chip.classList.add('warn');
    return;
  }
  chip.title = '';
  chip.classList.remove('warn');
  if (online.presenceOff) {
    chip.classList.add('hidden');
    return;
  }
  if (room) online.oppSeen = opponentSeen(room);
  const seen = online.oppSeen;
  if (!seen) {
    chip.textContent = '等待对手上线';
    chip.classList.remove('muted');
    chip.classList.remove('hidden');
    return;
  }
  const sec = Math.max(0, Math.round((Date.now() - new Date(seen).getTime()) / 1000));
  if (sec < 40) chip.textContent = '对手在线';
  else if (sec < 120) chip.textContent = '对手 ' + sec + ' 秒前在线';
  else chip.textContent = '对手可能已离开';
  chip.classList.toggle('muted', sec >= 120);
  chip.classList.remove('hidden');
}

function startPresence() {
  stopPresence();
  if (!online) return;
  const ping = async () => {
    if (!online || online.presenceOff) return;
    try {
      await touchRoom(online.code, online.color);
    } catch (err) {
      // 只有表里缺列时才永久关闭在线状态；网络抖动等下一次心跳再试
      if (online && /PGRST204|column|400/.test(err.message || '')) {
        online.presenceOff = true;
        updatePresence(null);
      }
    }
  };
  ping();
  online.seenTimer = setInterval(ping, 20000);
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
    if (!room) {
      stopPolling();
      stopPresence();
      online = null;
      updatePresence(null);
      openModal({
        title: '房间已失效',
        body: '这个房间已被清理或不存在。\n可以让对手重新建房，或回到设置新建一局。',
        okText: '返回设置',
        cancelText: '',
        onOk() { closeModal(); toSetup(); }
      });
      return;
    }
    online.offline = false;
    online.fail = 0;
    if (room.version > online.version) applyRemote(room);
    else online.oppSeen = opponentSeen(room);
    updatePresence(room);
  } catch (err) {
    if (!online) return;
    online.lastErr = err;
    online.fail = (online.fail || 0) + 1;
    if (online.fail >= 3) {
      online.offline = true;
      updatePresence(null);
    } else if (online.fail === 2) {
      toast('网络有点慢，正在重试…');
    }
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
  online.oppSeen = opponentSeen(room);
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
      toast(netErrorInfo(e2).title + '，局面尚未同步', 'check');
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
    seenTimer: 0,
    pulling: false,
    localBusy: false,
    pending: null,
    fail: 0,
    offline: false,
    presenceOff: false,
    oppSeen: null
  };
  saveRoom(room.code, color);
  statsRecorded = false;
  resetFrames();
  startClock();
  $('#setupView').classList.add('hidden');
  $('#gameView').classList.remove('hidden');
  setHeader('game');
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
  startPresence();
  updatePresence(room);
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
  statsRecorded = false;
  resetFrames();
  startClock();
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
    const info = netErrorInfo(err);
    openModal({
      title: info.title,
      body: info.body,
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
    const info = netErrorInfo(err);
    openModal({
      title: info.title,
      body: info.body,
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

/* ---------------- 添加到主屏幕 ---------------- */

const INSTALL_KEY = 'blind-xiangqi-install-tip';

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || navigator.standalone === true;
}

function setupInstallTip() {
  const tip = $('#installTip');
  if (!tip || isStandalone()) return;
  try { if (localStorage.getItem(INSTALL_KEY) === 'off') return; } catch (e) { /* ignore */ }
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  if (!ios && !/Android/.test(ua)) return;
  $('#installHow').textContent = ios
    ? '用 Safari「分享 → 添加到主屏幕」，像 App 一样打开'
    : '浏览器菜单「添加到主屏幕」，断网也能玩';
  tip.classList.remove('hidden');
  $('#installClose').addEventListener('click', () => {
    tip.classList.add('hidden');
    try { localStorage.setItem(INSTALL_KEY, 'off'); } catch (e) { /* ignore */ }
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (e) { /* 用户取消 */ }
    installPrompt = null;
    $('#installBtn').classList.add('hidden');
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = $('#installBtn');
  if (btn) btn.classList.remove('hidden');
});

/* ---------------- 交互绑定 ---------------- */

/** 点空白处时按最近的交叉点吸附，扩大棋子的有效点击范围 */
function nearestPiece(e) {
  const rect = $('#board').getBoundingClientRect();
  if (!rect.width) return null;
  const x = ((e.clientX - rect.left) / rect.width) * 960;
  const y = ((e.clientY - rect.top) / rect.height) * 1080;
  const c = Math.round((x - 80) / 100);
  const r = Math.round((y - 90) / 100);
  if (r < 0 || r > 9 || c < 0 || c > 8) return null;
  const dx = Math.abs(x - (80 + 100 * c));
  const dy = Math.abs(y - (90 + 100 * r));
  if (Math.hypot(dx, dy) > 62) return null;
  return pieceAt(g, { r, c });
}

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
  const p = el ? g.pieces.find((q) => q.id === el.dataset.id) : nearestPiece(e);
  if (!p || !p.pos) return;

  if (cfg.play === 'ai' && g.turn === 'black') { toast('陪练思考中…'); return; }

  if (!operable(g, p, g.turn)) {
    if (p.revealed) toast('这是' + (p.color === 'red' ? '红' : '黑') + '方明子，由对方操作');
    else toast('该暗子在' + (halfOwner(p.pos) === 'red' ? '红' : '黑') + '方半盘，由对方操作');
    return;
  }

  selectedId = selectedId === p.id ? null : p.id;
  vibrate(8);
  sfx('select');
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
  $('#dailyBtn').addEventListener('click', () => {
    cfg = { play: 'ai', shuffle: 'A1', rule: 'check', level: 'normal', daily: todayKey() };
    sel = { ...cfg };
    beginGame();
  });
  $('#board').addEventListener('click', onBoardClick);
  window.addEventListener('online', () => {
    if (!online) return;
    online.fail = 0;
    online.offline = false;
    updatePresence(null);
    pullRoom();
  });
  document.addEventListener('visibilitychange', () => {
    if (!online || document.visibilityState !== 'visible') return;
    online.fail = 0;
    updatePresence(null);
    pullRoom();
  });
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
  $('#presenceChip').addEventListener('click', () => {
    if (!online || !online.offline) return;
    const info = netErrorInfo(online.lastErr || new Error('Failed to fetch'));
    openModal({ title: '联机诊断', body: info.body, okText: '知道了', cancelText: '' });
  });
  $('#cancelRoomBtn').addEventListener('click', toSetup);
  $('#helpBtn').addEventListener('click', () => {
    openModal({ title: '玩法速览', body: HELP_TEXT, okText: '知道了', cancelText: '' });
  });
  $('#helpBtnGame').addEventListener('click', () => {
    openModal({ title: '玩法速览', body: HELP_TEXT, okText: '知道了', cancelText: '' });
  });
  $('#soundBtn').addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('blind-xiangqi-sound', soundOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
    syncSoundBtn();
    sfx('select');
  });
  $('#shareBtn').addEventListener('click', saveShareCard);
  $('#replayBtn').addEventListener('click', startReview);
  $('#revPrev').addEventListener('click', () => { stopReplay(); showFrame(review ? review.idx - 1 : 0); });
  $('#revNext').addEventListener('click', () => { stopReplay(); showFrame(review ? review.idx + 1 : 0); });
  $('#revPlay').addEventListener('click', toggleReplay);
  $('#revExit').addEventListener('click', exitReview);
  $('#logBtn').addEventListener('click', showMoveLog);
  $('#logBtnEnd').addEventListener('click', showMoveLog);
  $('#vibBtn').addEventListener('click', () => {
    vibOn = !vibOn;
    try { localStorage.setItem('blind-xiangqi-vib', vibOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
    syncVibBtn();
    vibrate(12);
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
    else if (e.key === 'Escape' && review) exitReview();
  });
  window.addEventListener('resize', fitBoard);
}

buildGrid();
renderOpts();
renderStats();
setupInstallTip();
syncVibBtn();
syncSoundBtn();
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

// 离线缓存：仅在 http(s) 下注册，file:// 打开时跳过
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => { /* 注册失败不影响在线游玩 */ });
  });
}
