/** 云开发环境 ID（联机对战使用），与 core/net.ts 保持一致 */
const CLOUD_ENV = 'blindchess2026-d2gupfwk44585c867';

App({
  onLaunch() {
    // 联机对战依赖云开发：初始化失败时单机玩法仍可正常使用
    if (wx.cloud) {
      try {
        wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
      } catch (e) { /* 未开通云开发或基础库过低时忽略 */ }
    }
  }
});
