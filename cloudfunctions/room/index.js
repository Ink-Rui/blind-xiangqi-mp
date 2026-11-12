/**
 * 盲下象棋 · 联机房间云函数
 * 客户端只提交「从哪走到哪」，由服务端用同一套引擎校验并推进棋局，保证双方状态一致。
 * 集合：rooms（_id 为 6 位房间码）
 */
const cloud = require('wx-server-sdk');
const E = require('./engine');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const rooms = db.collection('rooms');

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 去掉易混淆的 0/O/1/I
const MAX_SNAPS = 8;
const OFFLINE_MS = 12000;
const ASK_TTL_MS = 60000;

const other = (s) => (s === 'red' ? 'black' : 'red');
const sideName = (s) => (s === 'red' ? '红方' : '黑方');
const pieceName = (p) => (p.color === 'red' ? '帅' : '将');

function err(msg) {
  const e = new Error(msg);
  e.friendly = true;
  throw e;
}

function normCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== 6) err('房间码应为 6 位');
  return code;
}

function randCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function sanitizeCfg(raw) {
  const c = raw || {};
  return {
    shuffle: ['A1', 'A2', 'B'].indexOf(c.shuffle) >= 0 ? c.shuffle : 'A1',
    rule: ['check', 'kill'].indexOf(c.rule) >= 0 ? c.rule : 'check',
    play: 'online',
    level: 'normal'
  };
}

/** 新环境第一次使用时自动建表（集合已存在时不做事） */
async function ensureRooms() {
  if (typeof db.createCollection !== 'function') return;
  try { await db.createCollection('rooms'); } catch (e) { /* 已存在或暂不支持：交给后续读写报错 */ }
}

async function getRoom(code) {
  const r = await rooms.doc(code).get().catch(() => null);
  if (!r || !r.data) err('房间不存在或已过期');
  return r.data;
}

/** 带版本号的写入：版本不一致说明另一端已抢先提交，直接判为冲突 */
async function save(room, patch) {
  const ver = room.version;
  const data = Object.assign({}, patch, { version: ver + 1, updatedAt: Date.now() });
  const r = await rooms.where({ _id: room._id, version: ver }).update({ data });
  if (!r.stats || r.stats.updated !== 1) err('操作冲突，请稍后重试');
  Object.assign(room, data);
  return room;
}

/** 事件用于客户端 toast；v 为产生该事件后的房间版本 */
function withEvent(room, text, cls) {
  const list = (room.events || []).concat([{ v: room.version + 1, text, cls: cls || '' }]);
  return list.slice(-20);
}

function seatRole(room, openid) {
  if (room.seats.red === openid) return 'red';
  if (room.seats.black === openid) return 'black';
  return null;
}

/** 下发给客户端的棋局：不含历史/重复局面表，客户端只用于渲染与合法走法提示 */
function pub(st) {
  return {
    cfg: st.cfg, turn: st.turn, moveNum: st.moveNum, noCap: st.noCap,
    over: st.over, winner: st.winner, reason: st.reason,
    pieces: st.pieces, lastMove: st.lastMove
  };
}

function endGame(g, winner, reason) {
  g.over = true;
  g.winner = winner;
  g.reason = reason;
}

function snapshot(room, role) {
  const oppSeen = room.seen[other(role)] || 0;
  return {
    ok: true,
    role,
    code: room._id,
    status: room.status,
    version: room.version,
    lastAction: room.lastAction,
    state: pub(room.state),
    ask: room.ask,
    events: [],
    oppOnline: Date.now() - oppSeen < OFFLINE_MS
  };
}

/* ================= 动作 ================= */

async function cmdCreate(ev, openid) {
  const cfg = sanitizeCfg(ev.cfg);
  // 直接尝试写入房间文档：撞号换一个码；集合不存在则建表后用同一码重试
  for (let i = 0; i < 6; i++) {
    const code = randCode();
    const role = Math.random() < 0.5 ? 'red' : 'black';
    const now = Date.now();
    const room = {
      _id: code,
      cfg,
      state: E.newGameState(cfg),
      snaps: [],
      seats: { red: null, black: null },
      seen: { red: 0, black: 0 },
      status: 'waiting',
      ask: null,
      version: 1,
      lastAction: 'create',
      events: [{ v: 1, text: '房间已创建，等待好友加入', cls: '' }],
      createdAt: now,
      updatedAt: now
    };
    room.seats[role] = openid;
    room.seen[role] = now;

    try {
      await rooms.add({ data: room });
      return { ok: true, code, role, status: 'waiting', version: 1 };
    } catch (e) {
      const msg = String((e && (e.errMsg || e.message)) || '');
      const codeNum = String(e && e.errCode);
      if (codeNum === '-502005' || /collection.*(not exist|不存在)|database collection not exists/i.test(msg)) {
        await ensureRooms();
        await rooms.add({ data: room });
        return { ok: true, code, role, status: 'waiting', version: 1 };
      }
      if (codeNum === '-502001' || /duplicate/i.test(msg)) continue;   // 房间码撞号，换一个
      throw e;
    }
  }
  err('房间号生成失败，请稍后重试');
}

async function cmdJoin(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  if (room.status === 'over') err('这局已经结束了');
  let role = seatRole(room, openid);
  if (!role) {
    if (!room.seats.red) role = 'red';
    else if (!room.seats.black) role = 'black';
    else err('房间已满，无法加入');
  }
  const now = Date.now();
  const seats = { red: room.seats.red, black: room.seats.black };
  const seen = { red: room.seen.red || 0, black: room.seen.black || 0 };
  seats[role] = openid;
  seen[role] = now;

  const patch = { seats, seen };
  if (seats.red && seats.black && room.status === 'waiting') {
    patch.status = 'playing';
    patch.lastAction = 'join';
    patch.events = withEvent(room, '双方已就位，' + sideName(role) + '加入对局', '');
  }
  await save(room, patch);
  return snapshot(room, role);
}

async function cmdSync(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  const role = seatRole(room, openid);
  const now = Date.now();
  const patch = {};
  let dirty = false;

  // 心跳 5 秒写一次，避免每次轮询都产生写操作
  if (role && now - (room.seen[role] || 0) > 5000) {
    const seen = { red: room.seen.red || 0, black: room.seen.black || 0 };
    seen[role] = now;
    patch.seen = seen;
    dirty = true;
  }
  // 协商请求超时自动作废
  if (room.ask && now - (room.ask.ts || 0) > ASK_TTL_MS) {
    patch.ask = null;
    patch.events = withEvent(room, '协商请求超时，已自动取消', '');
    dirty = true;
  }
  if (dirty) {
    try { await save(room, patch); } catch (e) { /* 并发写入时以对方数据为准，下次轮询再同步 */ }
  }

  const since = Number(ev.since || 0);
  const events = (room.events || []).filter((e) => e.v > since).map((e) => ({ text: e.text, cls: e.cls || '' }));
  const oppSeen = room.seen[other(role)] || 0;
  return {
    ok: true,
    role,
    code,
    status: room.status,
    version: room.version,
    lastAction: room.lastAction,
    state: pub(room.state),
    ask: room.ask,
    events,
    oppOnline: !!role && now - oppSeen < OFFLINE_MS
  };
}

async function cmdMove(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  const role = seatRole(room, openid);
  if (!role) err('你不在这个房间里');
  if (room.status !== 'playing') err('对局还没开始');
  if (room.state.over) err('对局已结束');
  if (room.ask) err('有协商请求待处理');
  // 不校验 ev.ver：心跳也会推高版本号，客户端版本略旧属正常；
  // 走法本身由服务端用引擎校验，并发写入由 save 的版本 CAS 兜底
  if (room.state.turn !== role) err('还没轮到你走棋');

  const g = room.state;
  const from = { r: Number(ev.from.r), c: Number(ev.from.c) };
  const to = { r: Number(ev.to.r), c: Number(ev.to.c) };
  const p = E.pieceAt(g, from);
  if (!p) err('这一格没有棋子');
  if (!E.operable(g, p, role)) err('只能操作自己的棋子');
  if (!E.legalTargets(g, p).some((t) => t.r === to.r && t.c === to.c)) err('该走法不合法');

  const wasDark = !p.revealed;
  const moverSide = p.revealed ? p.color : E.halfOwner(p.pos);
  const snap = {
    pieces: E.clonePieces(g), turn: g.turn, noCap: g.noCap,
    moveNum: g.moveNum, lastMove: g.lastMove,
    flippedId: wasDark ? p.id : null
  };
  const target = E.pieceAt(g, to);
  const fromPos = { r: p.pos.r, c: p.pos.c };
  if (target) { target.captured = true; target.pos = null; g.noCap = 0; } else g.noCap++;
  p.pos = { r: to.r, c: to.c };
  g.lastMove = { from: fromPos, to: { r: to.r, c: to.c } };
  if (wasDark) p.revealed = true;

  const patch = {
    state: g,                                              // 棋局推进必须落库，否则下次读取还是旧局面
    snaps: (room.snaps || []).concat([snap]).slice(-MAX_SNAPS),
    lastAction: 'move'
  };

  // 吃将
  if (target && target.type === 'K') {
    if (target.color === moverSide) {
      // 误吃己方将帅：由赢方（对方）决定悔一步还是判负
      patch.ask = {
        type: 'miseat', by: moverSide, decider: other(moverSide), ts: Date.now(),
        info: { attackerId: p.id, kingId: target.id, kingChar: pieceName(target) }
      };
      patch.events = withEvent(room, sideName(moverSide) + '误吃己方将帅，由' + sideName(other(moverSide)) + '决定', '');
      await save(room, patch);
      return snapshot(room, role);
    }
    endGame(g, moverSide, sideName(moverSide) + '吃掉对方' + pieceName(target));
    patch.status = 'over';
    patch.events = withEvent(room, sideName(moverSide) + '获胜', '');
    await save(room, patch);
    return snapshot(room, role);
  }

  // 重复局面与长将
  const h = E.hashState(g);
  g.repMap[h] = (g.repMap[h] || 0) + 1;
  const gaveCheck = g.cfg.rule === 'check' && E.inCheck(g, E.opp(moverSide)) ? moverSide : null;
  g.history.push({ hash: h, checkBy: gaveCheck });
  let ended = false;

  if (g.repMap[h] >= 3) {
    const idx = g.history.map((q) => q.hash).lastIndexOf(h, g.history.length - 2);
    const seg = g.history.slice(Math.max(idx, 0));
    const givers = [];
    for (const q of seg) if (q.checkBy && givers.indexOf(q.checkBy) < 0) givers.push(q.checkBy);
    if (givers.length === 1) {
      endGame(g, other(givers[0]), sideName(givers[0]) + '长将（重复局面判负）');
    } else {
      endGame(g, null, '三次重复局面，判和');
    }
    ended = true;
  }
  if (!ended && g.noCap >= 120) {
    endGame(g, null, '120 半回合无吃子，判和');
    ended = true;
  }
  if (!ended) {
    g.turn = other(g.turn);
    g.moveNum++;
    if (!E.hasLegal(g, g.turn)) {
      endGame(g, moverSide, sideName(g.turn) + (E.inCheck(g, g.turn) ? '被将死' : '无子可动'));
      ended = true;
    }
  }
  if (ended) {
    patch.status = 'over';
    patch.events = withEvent(room, g.winner ? sideName(g.winner) + '获胜' : '和棋', '');
  }
  await save(room, patch);
  return snapshot(room, role);
}

async function cmdAsk(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  const role = seatRole(room, openid);
  if (!role) err('你不在这个房间里');
  if (room.status !== 'playing' || room.state.over) err('对局未在进行中');
  if (room.ask) err('已有待处理的协商请求');

  const type = ev.type === 'pass' ? 'pass' : 'undo';
  if (type === 'undo') {
    if (role !== other(room.state.turn)) err('现在不是你请求悔棋的时机');
    if (!(room.snaps || []).length) err('还没有可悔的着法');
  } else if (role !== room.state.turn) {
    err('现在不是你行棋');
  }
  await save(room, {
    ask: { type, by: role, decider: other(role), ts: Date.now() },
    events: withEvent(room, sideName(role) + (type === 'undo' ? '请求悔棋' : '请求让一手'), '')
  });
  return snapshot(room, role);
}

/** 从快照恢复：翻开过的棋子保持翻开（信息不回滚）
 *  popHistory：误吃己方将帅的走子未计入 history，恢复时不能多弹一条 */
function restore(g, snap, popHistory) {
  const pieces = snap.pieces.map((q) => Object.assign({}, q, { pos: q.pos ? { r: q.pos.r, c: q.pos.c } : null }));
  if (snap.flippedId) {
    const fp = pieces.find((q) => q.id === snap.flippedId);
    if (fp) fp.revealed = true;
  }
  g.pieces = pieces;
  g.turn = snap.turn;
  g.noCap = snap.noCap;
  g.moveNum = snap.moveNum;
  g.lastMove = snap.lastMove ? { from: { r: snap.lastMove.from.r, c: snap.lastMove.from.c }, to: { r: snap.lastMove.to.r, c: snap.lastMove.to.c } } : null;
  if (popHistory) {
    g.history.pop();
    g.repMap = {};
    for (const q of g.history) g.repMap[q.hash] = (g.repMap[q.hash] || 0) + 1;
  }
  return pieces;
}

async function cmdAnswer(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  const role = seatRole(room, openid);
  if (!role) err('你不在这个房间里');
  const ask = room.ask;
  if (!ask) err('没有待处理的协商请求');
  if (ask.decider !== role) err('这个请求不是由你来决定');
  if (room.state.over) err('对局已结束');

  const accept = !!ev.accept;
  const g = room.state;
  const patch = { ask: null, state: g };
  const snaps = (room.snaps || []).slice();

  if (ask.type === 'miseat') {
    if (accept) {
      const snap = snaps.pop();
      if (!snap) err('悔棋快照已失效');
      const pieces = restore(g, snap, false);
      const at = pieces.find((q) => q.id === (ask.info && ask.info.attackerId));
      if (at) at.revealed = true;
      const kg = pieces.find((q) => q.id === (ask.info && ask.info.kingId));
      if (kg) kg.revealed = true;
      patch.snaps = snaps;
      patch.lastAction = 'undo';
      patch.events = withEvent(room, '已悔一步，' + sideName(g.turn) + '重新行棋', '');
    } else {
      endGame(g, other(ask.by), sideName(ask.by) + '误吃己方将帅，赢方不同意悔棋，判负');
      patch.status = 'over';
      patch.lastAction = 'end';
      patch.events = withEvent(room, sideName(other(ask.by)) + '获胜', '');
    }
  } else if (ask.type === 'undo') {
    if (accept) {
      const snap = snaps.pop();
      if (!snap) err('没有可悔的着法');
      restore(g, snap, true);
      patch.snaps = snaps;
      patch.lastAction = 'undo';
      patch.events = withEvent(room, '悔棋成功，' + sideName(g.turn) + '重新行棋', '');
    } else {
      patch.lastAction = 'undo-refused';
      patch.events = withEvent(room, sideName(ask.decider) + '拒绝悔棋', '');
    }
  } else if (ask.type === 'pass') {
    if (accept) {
      const fromSide = g.turn;
      g.turn = other(g.turn);
      g.moveNum++;
      patch.lastAction = 'pass';
      let text = sideName(fromSide) + '让一手，' + sideName(g.turn) + '行棋';
      if (!E.hasLegal(g, g.turn)) {
        endGame(g, fromSide, sideName(g.turn) + '无子可动');
        patch.status = 'over';
        text = sideName(g.turn) + '无子可动，' + sideName(fromSide) + '获胜';
      }
      patch.events = withEvent(room, text, '');
    } else {
      patch.lastAction = 'pass-refused';
      patch.events = withEvent(room, sideName(ask.decider) + '拒绝让一手', '');
    }
  }

  await save(room, patch);
  return snapshot(room, role);
}

async function cmdResign(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  const role = seatRole(room, openid);
  if (!role) err('你不在这个房间里');
  if (room.state.over) return snapshot(room, role);

  const g = room.state;
  endGame(g, other(role), sideName(role) + '认输');
  await save(room, {
    state: g,
    ask: null,
    status: 'over',
    lastAction: 'end',
    events: withEvent(room, sideName(role) + '认输，' + sideName(other(role)) + '获胜', '')
  });
  return snapshot(room, role);
}

/** 主动退出：等待中直接销毁房间，对局中视为认输 */
async function cmdClose(ev, openid) {
  const code = normCode(ev.code);
  const room = await getRoom(code);
  const role = seatRole(room, openid);
  if (!role) return { ok: true };
  if (room.status === 'waiting') {
    await rooms.doc(code).remove().catch(() => {});
    return { ok: true };
  }
  if (room.state.over) return snapshot(room, role);
  const g = room.state;
  endGame(g, other(role), sideName(role) + '退出房间');
  await save(room, {
    state: g,
    ask: null,
    status: 'over',
    lastAction: 'end',
    events: withEvent(room, sideName(role) + '退出房间，' + sideName(other(role)) + '获胜', '')
  });
  return snapshot(room, role);
}

const handlers = {
  create: cmdCreate,
  join: cmdJoin,
  sync: cmdSync,
  move: cmdMove,
  ask: cmdAsk,
  answer: cmdAnswer,
  resign: cmdResign,
  close: cmdClose
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '请在小程序内使用' };
  const action = String((event && event.action) || '');
  const fn = handlers[action];
  if (!fn) return { ok: false, msg: '未知操作' };
  try {
    return await fn(event, OPENID);
  } catch (e) {
    if (e && e.friendly) return { ok: false, msg: e.message };
    // 非预期异常：把原始信息带回一小段，方便排查（好友间的小程序，不涉及敏感数据）
    const detail = String((e && (e.errMsg || e.message)) || e || '').slice(0, 120);
    console.error('[room] uncaught', action, detail, e && e.stack);
    return { ok: false, msg: '服务异常：' + detail };
  }
};
