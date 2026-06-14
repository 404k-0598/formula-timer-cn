# 方程式实时计时

一个全中文的 F1 实时计时与遥测看板。页面优先读取本项目的 F1 Live Timing 代理；代理不可用时回退到 [OpenF1](https://openf1.org/) 公共 API。

## 数据边界

- 目标会话如果正在进行，页面通过 `server/live-proxy.js` 连接 F1 官方 Live Timing SignalR 流。
- 代理会输出 `/api/live` 快照和 `/api/events` SSE 流，前端默认读取 `https://formula-timer-cn-live.onrender.com`。
- 如果下一场比赛尚未开始，页面会标记为“等待开赛”，并展示最近一场真实会话的数据作为参考。
- OpenF1 在直播会话期间可能限制公共访问；此时页面会显示 F1 Live Timing 代理数据。

## 本地运行

```bash
npm install
npm run dev
```

本地代理：

```bash
npm run dev:proxy
VITE_LIVE_API_URL=http://127.0.0.1:8787 npm run dev
```

Render 部署：

```bash
npm start
```

仓库包含 `render.yaml`，可在 Render Blueprint 中直接部署 `formula-timer-cn-live`。

## 验证

```bash
npm run lint
npm run build
```
