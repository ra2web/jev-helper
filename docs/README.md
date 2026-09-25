# WERHD 玩家 API 参考

本目录保存 `ra2web.github.io` 发布的公开玩家 API 文档与基础示例；完整 TypeScript 声明位于项目根目录。

- [API 文档](player-console-api.md)：战场查询、生产与单位命令、部署、射程、组合行动和本地摄像机。
- [完整类型声明](../werhd-player-api.d.ts)：`PlayerConsolePublicApi`、查询结果、命令类型、公开枚举和 `Window.werhd`。
- [基础玩家脚本](examples/werhd-user-script.mjs)：文档中链接的独立接入示例。
- [希望游戏开放的接口](game-api-requests.md)：扩展这边整理的接口需求草案（生命周期、战役目标与提示、事件、命令回执、观察数据），供与作者沟通。

这三份文件按上游原始路径与内容保存，不参与扩展打包。运行时 `window.werhd` 仍由游戏提供，扩展的策略和传输实现继续维护在 `src/`。

## 使用类型

例如在 `src/` 下编写 TypeScript 模块时：

```ts
import type { PlayerConsolePublicApi } from '../werhd-player-api';

function readCredits(api: PlayerConsolePublicApi): number {
  return api.me().credits;
}

// 对局开始后才存在，离开对局后为 undefined。
if (window.werhd) readCredits(window.werhd);
```

文档中的 `/docs/...` 和 `/werhd-player-api.d.ts` 是游戏站点路径，不表示浏览器可以直接访问本机仓库。基础示例导入时会自动挂载自己的 `onTick` 回调，供单独学习或手动调试使用，不要与扩展托管同时运行。

## 同步来源

- 来源仓库：[ra2web/ra2web.github.io](https://github.com/ra2web/ra2web.github.io)
- 来源提交：[`7f6858a`](https://github.com/ra2web/ra2web.github.io/commit/7f6858ac8c1d1b7e6c9c5d84dcc1e9af1df3a06c)
- 同步日期：2026-09-23
- 同步时已核对本地源文件、来源提交及线上同路径文件，三者内容一致。
- 校验值采用 SHA-256，保留在下表，便于后续识别 API 契约变化。

| 文件（相对仓库根目录） | SHA-256 |
| --- | --- |
| `werhd-player-api.d.ts` | `f12092d8b07f90762969c5ff255615cda56249138fe7ad428fbf01d3d4b3d86a` |
| `docs/player-console-api.md` | `43ec1de588eb587a40876fd371a77b3eab361b5ac3c4760665ce3df646ebf0b7` |
| `docs/examples/werhd-user-script.mjs` | `d05d282a0ac585cdbdb5a271d2c0a762ea8784e69c6c9deb3c25df6333decfe6` |

这是一份固定版本快照，不会自动追踪线上变化。后续同步时，从来源仓库同一提交复制这三份文件，保留原始内容，并更新本页的提交、日期和校验值。API 实现由游戏工程维护；此项目使用声明与文档对接公开接口。
