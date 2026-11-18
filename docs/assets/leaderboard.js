/**
 * 每日一局排行榜（纯函数，便于 node:test 直接测试）
 * 服务端只做存储，排序口径与「更好成绩」判断都在这里定义。
 */

export const NAME_KEY = 'blind-xiangqi-name';
export const CLIENT_KEY = 'blind-xiangqi-client';
export const DEFAULT_NAME = '无名盲侠';
export const NAME_MAX = 12;

/** 昵称清洗：去控制字符与 HTML 敏感字符，压缩空白，限长；空串回退默认昵称 */
export function normalizeName(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/[<>"'&]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return text || DEFAULT_NAME;
}

export function loadName(storage) {
  try {
    return normalizeName(storage.getItem(NAME_KEY));
  } catch (e) {
    return DEFAULT_NAME;
  }
}

export function saveName(storage, name) {
  const next = normalizeName(name);
  try { storage.setItem(NAME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
  return next;
}

/** 浏览器本地身份：同一天多次提交只保留更好的一行 */
export function loadClientId(storage) {
  try {
    const saved = storage.getItem(CLIENT_KEY);
    if (saved && /^[A-Za-z0-9-]{8,64}$/.test(saved)) return saved;
  } catch (e) { /* 继续生成 */ }
  let id = '';
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    id = globalThis.crypto.randomUUID();
  } else {
    id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  try { storage.setItem(CLIENT_KEY, id); } catch (e) { /* ignore */ }
  return id;
}

export const RESULT_LABEL = { win: '胜', draw: '和', loss: '负' };

/** 胜 3 分、和 1 分、负 0 分 */
export function scoreOf(result) {
  return result === 'win' ? 3 : result === 'draw' ? 1 : 0;
}

/**
 * 单值排序分：服务端只按它倒序。
 * 胜：手数少、用时短更高；和/负：撑得越久越高。
 */
export function rankScore(entry) {
  const score = Number.isFinite(entry.score) ? entry.score : scoreOf(entry.result);
  const moves = Math.min(999, Math.max(0, Number.isFinite(entry.moves) ? Math.floor(entry.moves) : 0));
  const secs = Math.min(999, Math.max(0, Number.isFinite(entry.ms) ? Math.round(entry.ms / 1000) : 0));
  const fast = (999 - moves) * 1000 + (999 - secs);
  return score * 1000000 + (score === 3 ? fast : 999999 - fast);
}

/** 组装提交行；手数与用时会做下限保护 */
export function makeEntry(result, moves, ms) {
  const kind = RESULT_LABEL[result] ? result : 'loss';
  const entry = {
    result: kind,
    score: scoreOf(kind),
    moves: Number.isFinite(moves) && moves > 0 ? Math.floor(moves) : 0,
    ms: Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
  };
  entry.rank_score = rankScore(entry);
  return entry;
}

/** 排序口径：统一用 rank_score（胜和负 → 快慢 / 坚持时长） */
export function compareEntries(a, b) {
  const rankA = Number.isFinite(a.rank_score) ? a.rank_score : rankScore(a);
  const rankB = Number.isFinite(b.rank_score) ? b.rank_score : rankScore(b);
  if (rankA !== rankB) return rankB - rankA;
  const createdA = Date.parse(a.created_at || '') || 0;
  const createdB = Date.parse(b.created_at || '') || 0;
  return createdA - createdB;
}

/** next 是否严格优于 prev（用于决定要不要覆盖自己当天的成绩） */
export function betterEntry(next, prev) {
  if (!prev) return true;
  const rankA = rankScore(next);
  const rankB = Number.isFinite(prev.rank_score) ? prev.rank_score : rankScore(prev);
  return rankA > rankB;
}

export function sortEntries(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort(compareEntries);
}
