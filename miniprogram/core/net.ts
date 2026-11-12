/** 联机网络层：统一封装云函数调用与返回结构 */

/** 云开发环境 ID，与 app.ts 保持一致 */
export const CLOUD_ENV = 'blindchess2026-d2gupfwk44585c867';

export interface RoomAsk {
  type: 'undo' | 'pass' | 'miseat';
  by: 'red' | 'black';
  decider: 'red' | 'black';
  ts?: number;
  info?: { attackerId?: string; kingId?: string; kingChar?: string };
}

export interface RoomState {
  cfg: { shuffle: string; rule: string; play: string; level: string };
  turn: 'red' | 'black';
  moveNum: number;
  noCap: number;
  over: boolean;
  winner: 'red' | 'black' | null;
  reason: string;
  pieces: any[];
  lastMove: { from: { r: number; c: number }; to: { r: number; c: number } } | null;
}

export interface RoomRes {
  ok: boolean;
  msg?: string;
  role?: 'red' | 'black' | null;
  code?: string;
  status?: 'waiting' | 'playing' | 'over';
  version?: number;
  lastAction?: string;
  state?: RoomState;
  ask?: RoomAsk | null;
  events?: { text: string; cls?: string }[];
  oppOnline?: boolean;
}

export function cloudReady(): boolean {
  return typeof wx !== 'undefined' && !!wx.cloud && typeof wx.cloud.callFunction === 'function';
}

/** 调用 room 云函数；网络异常也以 {ok:false,msg} 返回，调用方只需处理一种形态 */
export function callRoom(action: string, data?: Record<string, any>): Promise<RoomRes> {
  return new Promise<RoomRes>((resolve) => {
    if (!cloudReady()) {
      resolve({ ok: false, msg: '当前微信版本不支持联机，请升级微信后再试' });
      return;
    }
    wx.cloud.callFunction({
      name: 'room',
      data: Object.assign({ action }, data || {}),
      success: (r: any) => {
        const res = r && r.result;
        if (res && typeof res === 'object') resolve(res as RoomRes);
        else resolve({ ok: false, msg: '服务器返回异常，请重试' });
      },
      fail: (e: any) => {
        const m = String((e && (e.errMsg || e.message)) || '');
        resolve({ ok: false, msg: /timeout/i.test(m) ? '网络超时，请重试' : '联机服务暂不可用，请检查网络后重试' });
      }
    });
  });
}
