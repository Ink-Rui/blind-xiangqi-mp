/**
 * 本地战绩统计（纯函数，便于 node:test 直接测试）
 * 只统计 AI 与联机对局；双人同屏不区分个人胜负，不计入。
 */

export const STATS_KEY = 'blind-xiangqi-stats';
export const RECENT_LIMIT = 5;

export function emptyStats() {
  return { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, best: 0, recent: [] };
}

function count(v) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** 容错：外部数据缺字段、类型错误时退回默认值 */
export function normalizeStats(raw) {
  const out = emptyStats();
  if (!raw || typeof raw !== 'object') return out;
  out.games = count(raw.games);
  out.wins = count(raw.wins);
  out.losses = count(raw.losses);
  out.draws = count(raw.draws);
  out.streak = count(raw.streak);
  out.best = Math.max(count(raw.best), out.streak);
  if (Array.isArray(raw.recent)) {
    out.recent = raw.recent
      .filter((r) => r && typeof r === 'object' && ['win', 'loss', 'draw'].includes(r.result))
      .slice(0, RECENT_LIMIT)
      .map((r) => ({
        at: count(r.at),
        mode: r.mode === 'online' ? 'online' : 'ai',
        result: r.result,
        moves: count(r.moves),
        ms: count(r.ms)
      }));
  }
  return out;
}

/** 追加一局结果，返回新对象（不修改入参） */
export function applyResult(stats, entry) {
  const base = normalizeStats(stats);
  const next = { ...base, recent: base.recent.slice() };
  next.games += 1;
  if (entry.result === 'win') {
    next.wins += 1;
    next.streak = base.streak + 1;
    next.best = Math.max(base.best, next.streak);
  } else if (entry.result === 'loss') {
    next.losses += 1;
    next.streak = 0;
  } else {
    next.draws += 1;
    next.streak = 0;
  }
  next.recent.unshift({
    at: count(entry.at),
    mode: entry.mode === 'online' ? 'online' : 'ai',
    result: entry.result,
    moves: count(entry.moves),
    ms: count(entry.ms)
  });
  next.recent = next.recent.slice(0, RECENT_LIMIT);
  return next;
}

/** 毫秒 → m:ss / h:mm:ss */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
}

export function winRate(stats) {
  const s = normalizeStats(stats);
  return s.games ? Math.round((s.wins / s.games) * 100) : 0;
}

export function loadStats(storage) {
  try {
    const raw = storage.getItem(STATS_KEY);
    return normalizeStats(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return emptyStats();
  }
}

export function saveStats(storage, stats) {
  try {
    storage.setItem(STATS_KEY, JSON.stringify(normalizeStats(stats)));
    return true;
  } catch (e) {
    return false;
  }
}
