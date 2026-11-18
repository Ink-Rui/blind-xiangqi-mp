/**
 * 联机网络层：直接用 fetch 调 Supabase 的 PostgREST 接口，不依赖任何 SDK。
 * 房间整局状态存在 rooms.state（JSONB）里，用 version 做乐观锁，避免双方同时写覆盖。
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const ONLINE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const BASE = String(SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/rooms';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1，避免看错

function headers(extra) {
  return Object.assign({
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function request(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + (text ? ' ' + text.slice(0, 160) : ''));
  return text ? JSON.parse(text) : null;
}

function randomCode(len) {
  const buf = new Uint32Array(len);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 4294967296);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

/** 创建房间，返回整行记录（含 code）；房间码撞车时自动重试 */
export async function createRoom(state) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    try {
      const rows = await request(BASE + '?select=*', {
        method: 'POST',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({ code, state, version: 0, guest_joined: false })
      });
      if (rows && rows[0]) return rows[0];
    } catch (err) {
      if (!/ 409 /.test(' ' + err.message + ' ')) throw err;
    }
  }
  throw new Error('房间码生成失败，请重试');
}

export async function fetchRoom(code) {
  const rows = await request(
    BASE + '?code=eq.' + encodeURIComponent(code) + '&select=*',
    { headers: headers() }
  );
  return rows && rows[0] ? rows[0] : null;
}

/** 加入房间：把 guest_joined 置真；版本不匹配返回 null（说明状态已被别人改过） */
export async function markJoined(code, version) {
  const rows = await request(
    BASE + '?code=eq.' + encodeURIComponent(code) + '&version=eq.' + version + '&select=*',
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=representation' }),
      body: JSON.stringify({ guest_joined: true, version: version + 1, updated_at: new Date().toISOString() })
    }
  );
  return rows && rows[0] ? rows[0] : null;
}

/** 提交新状态；版本被抢先时返回 null，由调用方拉取最新局面 */
export async function pushState(code, version, state) {
  const rows = await request(
    BASE + '?code=eq.' + encodeURIComponent(code) + '&version=eq.' + version + '&select=*',
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=representation' }),
      body: JSON.stringify({ state, version: version + 1, updated_at: new Date().toISOString() })
    }
  );
  return rows && rows[0] ? rows[0] : null;
}

/**
 * 心跳：只更新自己一侧的在线时间，不动 version，避免打断正常同步。
 * 表里没有 host_seen/guest_seen 列时会抛错，由调用方静默关闭在线状态显示。
 */
export async function touchRoom(code, color) {
  const column = color === 'red' ? 'host_seen' : 'guest_seen';
  const rows = await request(
    BASE + '?code=eq.' + encodeURIComponent(code) + '&select=code',
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=representation' }),
      body: JSON.stringify({ [column]: new Date().toISOString() })
    }
  );
  return rows && rows[0] ? rows[0] : null;
}
