# 盲下象棋 · 微信小程序

> 标准象棋盘 · 开局暗置洗牌 · 走完翻开 · 一半棋艺一半运气

一款「盲下」玩法的中国象棋小程序：开局时双方棋子随机洗牌并以背面朝上暗置，双方都不完全知道自己的棋子是什么，走到哪一格才翻开哪一格，靠记忆与推理对局。

原生小程序 + TypeScript，联机部分基于微信云开发（云函数 + 云数据库）。

## 玩法

- 棋盘、走子规则与标准中国象棋一致
- 开局按所选模式洗牌，棋子暗置，走到即翻开
- 走完一子后翻开确认身份，误吃/被吃都按真实棋子结算
- 支持三种洗牌模式、两种胜负规则、三种对局形式

## 功能特性

**对局**

- 同屏双人：一台手机，两人轮流走
- 人机陪练：三档 AI 难度
- 好友联机：创建房间生成 6 位房间码，好友输入房间码加入
- 悔棋、让一手、误吃协商（需对方同意）
- 终局判定：将死、困毙、认输、协商和棋

**联机（云开发）**

- 云端为唯一权威：所有走子由云函数校验，客户端只做展示
- `version` 乐观锁（CAS）防止并发覆盖
- 客户端轮询同步，错过多步时直接对齐状态，不补播动画
- 断线重连：指数退避重试（1s→2s→4s→6s），显示对手在线状态
- 房间清理：建房时顺手清理过期房间（已结束超 1 小时、等人超 3 小时、双方掉线超 30 分钟）
- 数据库权限设为「所有用户不可读写」，前端只能通过云函数访问

## 目录结构

```
miniprogram/
  app.ts / app.json / app.wxss
  core/
    engine.ts        # 棋规引擎：洗牌、走子合法性、终局判定
    net.ts           # 云开发调用封装（callRoom）
  pages/
    index/           # 首页：洗牌模式 / 胜负规则 / 对局形式选择
    game/            # 对局页：棋盘渲染、同屏、AI、联机全套逻辑
cloudfunctions/
  room/
    index.js         # 云函数：create/join/sync/move/ask/answer/resign/close
    engine.js        # 由 core/engine.ts 编译而来（云端校验用）
    package.json
```

## 本地运行

1. 用[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)导入本目录
2. 在 `project.config.json` 里把 `appid` 换成你自己的小程序 AppID
3. 开通云开发，把 `miniprogram/core/net.ts` 里的 `CLOUD_ENV` 换成你的云环境 ID
4. 云开发控制台新建集合 `rooms`，权限选择**「所有用户不可读写」**
5. 右键 `cloudfunctions/room` → 上传并部署（云端安装依赖），超时时间建议设为 10 秒

### 编译云端引擎

云函数里的 `engine.js` 是 `miniprogram/core/engine.ts` 的 CommonJS 编译产物，改完引擎后需要重新生成：

```bash
npm install
npm run build:engine
```

### 类型检查

```bash
npm run typecheck
```

## 关于发布

本项目使用**个人主体**小程序账号开发。按微信现行规则，涉及棋牌对弈的小程序需要「游戏」类目，而该类目要求企业主体与游戏版号，因此目前仅以体验版形式供家人朋友使用，未提交正式审核。

如果要正式上线，需要改为企业主体并取得版号，或调整产品定位（去掉对弈玩法，改为纯棋谱/残局练习类工具）。

## License

[MIT](./LICENSE)
