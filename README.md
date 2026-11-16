# 盲下象棋 · 打开即玩

> 标准象棋盘 · 开局暗置洗牌 · 走完翻开 · 一半棋艺一半运气

**在线对弈：[https://ink-rui.github.io/blind-xiangqi-mp/](https://ink-rui.github.io/blind-xiangqi-mp/)**

浏览器直接打开就能玩，无需安装、无需登录。手机与桌面都适配，支持双人同屏、三档 AI 陪练和异地联机对战。

## 玩法

- 棋盘、走子规则与标准中国象棋一致
- 开局按所选模式洗牌，棋子背面朝上；走到哪一格才翻开哪一格
- 暗子按它所在位置的「位置型棋种」走法移动，翻开后按真实身份行棋
- 轮到你时，可操作己方半盘的暗子与己方颜色的明子
- 暗子谁都可以吃；误吃己方将帅按吃将判负，双人同屏可协商悔一步
- 三种洗牌模式（A1 半盘内洗 / A2 跨河全混 / B 全盘混洗）、两种胜负规则（将军 / 吃将即胜）
- 悔棋、认输、重开；120 半回合无吃子或三次重复局面判和
- 联机：一方建房把链接发给对手，双方实时同步；联机不提供悔棋，误吃己方将帅直接判负

## 目录结构

```
docs/                 # 网页版（GitHub Pages 静态托管，无构建依赖）
  index.html
  assets/style.css
  assets/app.js       # 交互与对局流程
  assets/engine.js    # 由 miniprogram/core/engine.ts 编译而来
  assets/net.js       # 联机网络层（纯 fetch 调 Supabase PostgREST）
  assets/config.js    # Supabase 地址与 anon key（留空则联机不可用）
supabase/schema.sql   # 联机房间表 + RLS 策略
miniprogram/          # 微信小程序（原生 + TypeScript）
  core/engine.ts      # 棋规引擎：洗牌、走子合法性、终局判定（两端共用）
  core/net.ts         # 云开发联机封装
  pages/              # 首页与对局页
cloudfunctions/room/  # 联机云函数（create/join/sync/move/ask/answer/resign/close）
```

## 开启联机（Supabase 免费层）

联机不写后端代码，直接用 Supabase 的 PostgREST 存房间状态，客户端每 1.5 秒同步一次，默认额度足够朋友间对弈。

1. 在 [supabase.com](https://supabase.com) 建一个免费项目
2. 打开 **SQL Editor**，粘贴执行仓库里的 [`supabase/schema.sql`](./supabase/schema.sql)
3. 打开 **Settings → API**，复制 `Project URL` 和 `anon public` key
4. 把这两个值填进 `docs/assets/config.js`：

```js
export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

5. 重新部署 `docs/` 即可。两项留空时，页面仍可玩双人同屏与人机，仅「联机对战」提示未配置。

说明：

- `anon` key 是公开密钥，放在前端安全；权限由 `schema.sql` 里的 RLS 策略控制，同一时间只有拿到 6 位房间码的人能读写该房间。
- 房间整局状态以 JSONB 存在 `rooms.state`，`version` 做乐观锁，双方同时写入时以服务端最新状态为准。
- 前端能读到暗子的真实身份，属于「防作弊不严格」的设计，适合朋友间对弈。需要严格防作弊得把规则引擎搬到服务端。
- 房间不会自动删除，可参考 `schema.sql` 末尾的 pg_cron 语句定期清理。

## 本地运行网页版

```bash
python -m http.server 8000 --directory docs
# 打开 http://localhost:8000
```

`app.js` 使用 ES Module，需要通过 HTTP 访问；直接双击 `index.html`（file://）会被浏览器的模块跨域策略拦下。

本地要试联机，两个浏览器窗口（或一个无痕窗口）打开同一地址，一个建房、一个用房间码加入即可。

## 构建与检查

```bash
npm install
npm run build:web     # 重新编译网页版引擎 docs/assets/engine.js
npm run build:engine  # 重新编译云函数引擎 cloudfunctions/room/engine.js
npm run typecheck
```

## 微信小程序版

仓库里的 `miniprogram/` 是同一套规则引擎驱动的小程序实现，包含好友联机（微信云开发）。

本地运行：

1. 用[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)导入本目录
2. 在 `project.config.json` 里把 `appid` 换成自己的小程序 AppID
3. 开通云开发，把 `miniprogram/core/net.ts` 里的 `CLOUD_ENV` 换成你的云环境 ID
4. 云开发控制台新建集合 `rooms`，权限选择「所有用户不可读写」
5. 右键 `cloudfunctions/room` → 上传并部署

注意：涉及棋牌对弈的小程序需要「游戏」类目，而该类目要求企业主体与游戏版号。个人主体无法正式发布，因此本项目以网页版为主要形态，小程序仅作体验版使用。

## License

[MIT](./LICENSE)
