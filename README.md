# 方程式实时计时

一个全中文的 F1 实时计时与遥测看板，使用 [OpenF1](https://openf1.org/) 公共 API 拉取真实会话数据。

## 数据边界

- 目标会话如果正在进行，页面按 20 秒轮询 OpenF1 的实时数据。
- 如果下一场比赛尚未开始，页面会标记为“等待开赛”，并展示最近一场真实会话的数据作为参考。
- Formula Timer 的页面和官方 F1 live timing 接口不是本项目的数据源；本项目不复制私有 UI、内容或未授权接口。

## 本地运行

```bash
npm install
npm run dev
```

## 验证

```bash
npm run lint
npm run build
```
