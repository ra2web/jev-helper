# 希望游戏开放的接口（给 werhd 作者）

状态：2026-09-25 草案。依据 jev-helper 0.5.2–0.7.5 的代码和 25 局实战报告整理。

jev-helper 是一个 Chrome 扩展，用 `window.werhd` 给王二火大 / ra2web 做 AI 托管，打遭遇战，也打战役关卡。现在的接口够它「看这一拍、下命令」，但有三件事做不到：

1. **不知道发生了什么**：没有事件，只能每 150 毫秒拍一次快照，再用血量差、物体消失、距离、名字去猜。
2. **不知道命令结果**：命令没有回执，只能看单位是否闲着，靠重发、超时、固定等待去猜。
3. **不知道对局本身**：战役目标、目标变化、屏幕提示、胜负原因、下一关都拿不到。

下面先给最想要的十项，再按类别展开。每条都附上实战里的真实问题。

---

## 一、最想要的十项（P0）

| # | 接口 | 解决什么 | 实战证据 |
| --- | --- | --- | --- |
| 1 | **离局也常驻的入口 + 版本号 + 对局阶段 + `battleId`** | 分清大厅、加载、简报、进行中、暂停、结算；判断换局 | 25 局里 14 局结果只能记成「对局结束」，3 局记成「换局」 |
| 2 | **`gameEnd` 事件 / `outcome()`：结果 + 原因 + 相关目标** | 识别胜利，知道为什么输 | 25 局识别出的胜利是 **0**；占下作战实验室 11 秒后判负，原因未知 |
| 3 | **`missionInfo()`：模式、关卡 id、名称、简报原文、阵营、难度** | 知道在打哪一关、任务说了什么 | 目标只能靠玩家手填，再用关键词去猜 |
| 4 | **`objectives()` + 目标变化事件** | 知道当前目标、状态、类型、关联物体、时限 | 五角大楼其实是四块「Wash Pent A–D」；「占领」曾被当成「保护」；占领后目标可能变了，扩展不知道 |
| 5 | **屏幕消息事件：EVA 语音、字幕、任务文本（原文 + 字符串键）** | 看到玩家看到的提示 | 「基地受攻击」只能靠距离推算，误报过连续约 6400 拍 |
| 6 | **倒计时 `timers()` + 事件** | 知道有没有时限、还剩多少 | 曾把实验室消失误判成时间限制 |
| 7 | **统一事件流：受伤（含攻击者）、摧毁（含死因）、归属变化、援军、受攻击** | 算清损失和击杀，知道谁在打自己、工程师死在哪 | 16 个工程师白送，报告里没有一条死因；剧情援军被算成「自己造的」 |
| 8 | **命令回执：接受 / 拒绝原因 / 完成 / 失败，带命令 id** | 不再盲目重发 | 一栋进不去的民房重进 497 次；一个占领目标重发 89 次 |
| 9 | **单位当前命令与状态（仅己方）** | 知道单位在路上、在打谁、被堵住还是到了 | 同一目标下令 135 次；所有「只给新兵 / 闲兵补令」的逻辑都在补这个缺 |
| 10 | **可达性 `pathTo` / `reachable` + 桥的状态和修桥小屋对应** | 知道走不走得到、卡在哪座断桥 | 「45920 拍没进展，大概是断桥」，修桥被选了 49 次；13 份报告都靠这样猜 |

另有两项开放成本很低、收益很大：

- **`rules()` 补上 ini 里本来就有的功能标记**：`capturable`、`insignificant`（装饰物）、`techBuilding`、`displayName`。旗子、路灯、管子曾被当成攻击或占领目标，现在还靠英文名正则挡。
- **放置建筑的结果、批量合法格和推荐位置**：现在每次最多查 500 次 `canPlace`，`place` 成功没有也不知道。

---

## 二、公平原则（建议写进接口文档）

**只开放玩家本来就能在屏幕、EVA 语音、雷达、侧栏看到或听到的信息，而且在它出现在屏幕上的那一刻才给。**

可以开放：

- 简报、目标面板、屏幕文本、EVA、字幕、倒计时、结算数据；
- 自己的单位、收入、队列、命令；
- 可见格上发生的事；
- 规则数据（鼠标悬停就能看到的那些）；
- 超武倒计时（原版对所有人显示）。

不应开放：

- 迷雾中或未探索区域的物体、血量、桥状态（只给最后看到的残影）；
- 敌方的钱、电、队列、科技进度、命令、目的地、路径；
- 看不见的攻击者的精确位置（最多给来弹方向）；
- 触发器内容、未来剧情、隐藏胜负条件、出生点；
- 未探索区域的完整寻路路径（只给能不能到、多远）。

可以按模式区分：战役的对手是电脑，没有公平问题，可以多给（目标类型、必须保住的物体、未揭示的目标区域）；多人对战严格只给屏幕上看得到的。用 `match().mode` 区分即可。

---

## 三、通用设计建议

1. **常驻入口**：`window.werhd` 离局就被摘掉，扩展在大厅、简报、结算界面什么都看不到。建议另设一个常驻对象（下文暂称 `werhdClient`），至少提供 `version`、`capabilities()`、`state()`、`on()`。
2. **事件用「可回看的有序队列」，而不只是推送**：`onTick` 只能挂一个回调、超过约 8ms 会被关掉，而扩展要异步去问模型，很容易漏事件。

   ```ts
   werhd.events.since(seq?: number, limit?: number): { seq: number; events: GameEvent[] }  // 环形缓冲，比如最近 2000 条
   werhd.on(kind: GameEvent['type'] | '*', handler): () => void                              // 多订阅者，返回取消函数
   ```

3. **版本号和能力清单**：`werhdClient.version = "1.3.0"`，`capabilities()` 返回 `{ lifecycle, outcome, campaign, events: [...], receipts, ... }`，方便扩展判断能用什么。
4. **结构化错误**：离局后的报错带 `code: 'NOT_IN_BATTLE'`。现在靠正则匹配英文报错文字，有 3 处。
5. **频率说明**：写明每拍 / 每秒最多几条命令、超出是丢弃还是排队、从下令到生效差几拍、对同一单位重复下同一命令会不会重新寻路或打断攻击冷却。扩展现在自己加了 18 / 20 / 45 / 150 拍各种间隔，都是在猜。

---

## 四、生命周期与自动推进

### 4.1 对局状态机（P0）

- **现在**：看 `window.werhd` 在不在；每 1 秒比较对象是否换了（`page.mjs:65-66`）；匹配英文报错（`werhd-jev-player.mjs:1942` 等）。离局、下一关、重开、读档都被归成「换局」。
- **草案**：

  ```ts
  werhdClient.state(): { phase: 'menu'|'lobby'|'loading'|'briefing'|'playing'|'paused'|'ended'|'score'; battleId: string; since: number }
  // 事件
  { type: 'stateChange', from, to, battleId, tick }
  { type: 'battleStart', battleId, match }                     // match 见 4.3
  { type: 'battleDispose', battleId, reason: 'ended'|'quit'|'restart'|'load'|'next_mission'|'unload' }
  ```

- 要求：`gameEnd` 必须在 `werhd` 被摘掉之前发出。

### 4.2 胜负与原因（P0）

- **现在**：战败看 `me().defeated`；胜利靠「所有对手都倒下」去猜，战役里永远不成立（中立和背景势力不会倒）。实战 25 局识别出胜利 0 次。五角大楼那两局很可能都赢了，一局记成「换局」，一局记成「对局结束」。
- **草案**：

  ```ts
  werhd.outcome(): null | {
    result: 'victory'|'defeat'|'draw'|'resigned'|'disconnected'|'aborted';
    reason: 'all_enemies_destroyed'|'objective_completed'|'objective_failed'|'protected_lost'|'base_destroyed'|'timer_expired'|'resign'|'scripted'|string;
    tick: number; time: number;
    objectiveId?: string; objectIds?: number[];   // 导致结局的目标 / 物体
    lastMessages?: MessageEvent[];                // 结束前最后几条屏幕消息
    stats?: PlayerStats[];                        // 与结算界面一致
  }
  // 同样的内容放进 { type: 'gameEnd', ... } 事件
  ```

### 4.3 对局类型与关卡（P0）

- **现在**：25 份报告的网页标题都是「王二火大-联机对战平台」，网址都是首页；战役里自己的阵营 `country` 是 `"Player"`。
- **草案**：

  ```ts
  werhd.match(): {
    mode: 'skirmish'|'campaign'|'custom_mission'|'online'|'replay';
    mapName: string; mapId?: string;
    missionId?: string; campaign?: 'allied'|'soviet'|'yuri'; missionIndex?: number;
    difficulty?: 'easy'|'normal'|'hard';
    side: 'allied'|'soviet'|'yuri'; country: string;
    gameSpeed: number; startCredits?: number;
  }
  ```

### 4.4 战役推进：下一关、重开、继续（P0）

- **现在**：做不到。每关都要玩家手动点进去，再重新开托管。
- **草案**：`werhdClient.campaign.next()`、`restart()`、`continue()`、`skipBriefing()`，只在 `phase` 为 `ended` 或 `score` 时生效，返回 `boolean`，走与玩家点按钮相同的界面路径。
- 不开放的话，扩展只能模拟点击画面，既脆弱，也可能越过作者的红线。

### 4.5 游戏速度与暂停（P1）

- **现在**：实测游戏内时间比真实时间快约 4 倍，扩展不知道当前速度；暂停或切到后台 30–60 秒就被当成「游戏卡死」，直接停止托管（有一局就是这样停的）。
- **草案**：`werhd.speed(): { setting, ticksPerSecond, secondsPerTick }`、`werhd.paused(): { paused, reason?: 'menu'|'hidden'|'host'|'desync' }`、`pause` 事件；单机时可选开放 `setSpeed(n)`、`pauseGame(on)`。文档写明 `time()` 是游戏内时间还是真实时间。

### 4.6 其他（P1 / P2）

- **页面刷新 / 卸载**（P1）：离开页面时同步发 `battleDispose{reason:'unload'}`；`werhdClient.lastBattle()` 返回上一局的 `battleId`、`outcome`、`match`。现在一刷新，这一局就没有记录。
- **存读档**（P2）：`saves.list() / save(slot) / load(slot)`，读档后换新 `battleId`。可以做「失败自动读档重试」。
- **`onTick` 被关掉时发事件**（P2）：`{ type: 'tickHandlerDisabled', reason: 'timeout'|'error' }`。现在只打一条控制台警告，扩展不知道自己被关了。
- **身份**（P2）：`me()` 补 `slot`、`team`、`isHost`；`playerDefeated` 事件。

---

## 五、战役目标与屏幕提示

RA2 原版没有结构化的「目标对象」：目标是触发器弹出的一句文字，完成、失败、切换也都靠触发器。所以**最低要求是把屏幕上显示过的每条文本连同字符串键一起给出**。如果王二火大做了自己的目标面板，就直接开放面板数据。

### 5.1 `missionInfo()`（P0）

```ts
werhd.missionInfo(): undefined | {
  mode: 'campaign'|'skirmish'|'multiplayer'|'custom';
  missionId?: string; mapName: string;
  side?: 'allied'|'soviet'|'yuri'; country?: string; difficulty?: 'easy'|'normal'|'hard';
  briefing?: { key?: string; text: string; lang: string; textEn?: string };   // 简报界面的原文
}
```

有了关卡 id，扩展就能给每关维护一份目标表，不再从一句话里猜。

### 5.2 `objectives()` 与目标变化（P0）

- **现在**：玩家手填「本局目标」，扩展用手写的中英对照表和正则匹配建筑（`werhd-jev-objective.mjs`）；靠「可见格上建筑不见了」判断完成；完全不知道目标会变。
- **真实案例**：「使用工程师占领盟军作战实验室」这关，0.7.4 占领成功后游戏立刻送了援军和建筑（剧情触发），实验室 6 秒后从我方消失，11 秒后判负。扩展一直以为「目标已完成」，还在去打发电厂。
- **草案**：

  ```ts
  interface Objective {
    id: string; text: string; key?: string; textEn?: string;
    status: 'pending'|'done'|'failed'|'hidden';
    primary: boolean;
    kind?: 'destroy'|'capture'|'protect'|'escort'|'survive'|'reach'|'evacuate'|'build'|'other';
    targets?: Array<{ objectId: number; visible: boolean }>;   // 只给已揭示 / 可见的
    area?: { waypoint?: string; center?: {x:number;y:number}; radius?: number };   // 只给已在地图 / 雷达上标出的
    mustSurvive?: number[];                                   // 失去即判负的物体（屏幕上已告知时）
    deadline?: { timerId: string; endsAtTick: number };
    shownAtTick: number; changedAtTick?: number;
  }
  werhd.objectives(): Objective[]
  { type: 'objective', change: 'added'|'status'|'text'|'removed', objective: Objective, previous?: Partial<Objective> }
  ```

- 如果引擎给不了 `kind` 和 `targets`，只给「文本 + 状态」也有用，扩展可以按关卡 id 查表。

### 5.3 屏幕消息（P0）

```ts
{ type: 'message', channel: 'eva'|'text'|'subtitle'|'chat'|'system';
  key?: string;                  // 字符串键 / 语音事件名，例如 EVA_BaseUnderAttack
  text: string; lang: string; textEn?: string;
  speaker?: string; durationMs?: number;
  at?: { x: number; y: number }; // 伴随的雷达闪点位置
  relatedObjectIds?: number[] }
werhd.messages.recent(limit?: number): MessageEvent[]
```

有了「基地受到攻击 + 位置」，就能替换扩展里按距离推算的逻辑。那次长时间误报的起因，就是扩展把 70 格外占领的科技机场也当成了「基地」。

### 5.4 倒计时（P0）

```ts
werhd.timers(): Array<{ id: string; label?: string; labelKey?: string; remainingTicks: number; remainingSeconds: number; running: boolean }>
{ type: 'timer', change: 'start'|'stop'|'extend'|'shorten'|'expire'|'label', timer, deltaTicks?: number }
```

### 5.5 援军、所有权变化、剧情移除（P1）

```ts
{ type: 'reinforcements', objectIds: number[], names: string[], via: 'ground'|'paradrop'|'naval'|'chrono'|'script', entry?: {x:number;y:number} }
{ type: 'ownerChanged', id: number, from: Rel, to: Rel, cause: 'engineer'|'script'|'mind_control'|'defection'|'other', byObjectId?: number }
{ type: 'removed', id: number, replacedBy?: number[] }      // 剧情替换（例如盟军实验室换成苏军实验室）
```

### 5.6 地图标记（P2）与触发器调试日志（P2，仅单人 + 调试开关）

- `werhd.markers()`：已揭示的路径点、闪烁单位、雷达闪点、揭示区域。
- `werhd.debug.triggerLog()`：`{ tick, trigger, event, actions[] }`，用于复盘，默认关闭。

---

## 六、统一事件流

四、五两节里的事件和下面这些，建议统一走 `events.since(seq)` 和 `on()`：

```ts
type Rel = 'self'|'allied'|'enemy'|'neutral';
type GameEvent = { seq: number; tick: number } & (
  | { type: 'damaged'; targetId: number; targetOwner: Rel; amount: number; hpAfter: number;
      attackerId?: number; attackerName?: string; weapon?: string; attackerVisible: boolean; fromDirection?: number }
  | { type: 'destroyed'; id: number; name: string; owner: Rel; tile: {rx:number;ry:number};
      cause: 'killed'|'sold'|'captured'|'consumed'|'mindControlled'|'enteredBuilding'|'enteredTransport'|'crushed'|'script'|'other';
      killerId?: number; killerName?: string; killerOwner?: Rel }
  | { type: 'underAttack'; scope: 'base'|'unit'|'harvester'|'ally'; objectId: number; x: number; y: number }   // 等价 EVA + 雷达闪点，可限频
  | { type: 'unit.created'; id: number; name: string; factoryId?: number; source: 'produced'|'reinforcement'|'crate'|'script' }
  | { type: 'unit.entered' | 'unit.exited'; id: number; containerId: number; kind: 'garrison'|'transport'|'capture'|'repair_hut'; forced?: boolean }
  | { type: 'promoted'; id: number; level: number }
  | { type: 'bridge'; bridgeId: number; state: 'destroyed'|'repaired'|'damaged' }
  | { type: 'superweapon'; owner: Rel; swType: string; phase: 'ready'|'launched'; x?: number; y?: number }
  | { type: 'radarPing'; x: number; y: number; source: 'ally'|'eva' }
  | ...  // 以及 4、5、7 节的 stateChange / gameEnd / objective / message / timer / reinforcements / ownerChanged / order.* / production.* / building.*
);
```

- 只推两类事件：受害者是己方或盟友，或者发生在我方当时可见的格子上。
- 攻击者当时不可见就不给 id，只给来弹方向。
- **能解决的问题**：
  - 进房子、上运输车的步兵，占领时消耗掉的工程师，被心控的单位，现在都被记成「损失」，战损比和「打法没进展」的判断都建立在这本错账上；
  - 「谁在打我」现在靠「掉血了 + 最近的敌人」去猜；
  - 工程师死在哪、被谁打死，现在完全不知道；
  - 剧情援军现在被当成「自己造的」。

---

## 七、命令回执与控制

### 7.1 命令回执（P0）

- **现在**：`move / attack / attackMove / produce / place / sell / repair` 等都没有返回值，只有 `deploy` / `order` 返回「已入队」。`produce` 名字错了只打控制台警告。
- **草案**：

  ```ts
  // 所有指令返回：
  type Receipt = { id: CommandId; queuedTick: number; executeTick: number } | { rejected: RejectReason };
  type RejectReason = 'not_owner'|'invalid_target'|'target_not_visible'|'cannot_capture'|'cannot_occupy'|'building_full'
    |'transport_full'|'no_path'|'out_of_map'|'cannot_place'|'insufficient_funds'|'prerequisite_missing'|'queue_full'
    |'not_ready'|'low_power'|'deployed'|'rate_limited'|string;
  // 事件
  { type: 'order.accepted'|'order.rejected'; cmd; unitIds; reason?; tick }
  { type: 'order.completed'|'order.failed'|'order.superseded'; cmd; unitId; reason? }
  { type: 'unit.arrived'; unitId; cmd; x; y }
  ```

- **能去掉的猜测**：
  - 占领：闲置 150 拍就重发，重发 3 次放弃，2400 拍超时；
  - 驻守、装载：闲置 120 拍重发，3 次算「被拒」；
  - 修桥：同一座小屋每 1200 拍再试；
  - 炸桥：300 拍桥血不降就放弃。

### 7.2 单位当前命令（P0，仅己方）

```ts
unit.order?: { cmd?: CommandId; type: OrderType; targetId?: number; target?: {x:number;y:number};
  status: 'moving'|'attacking'|'waitingPath'|'blocked'|'entering'|'harvesting'|'returning'|'unloading'|'done';
  queue: Array<{ type: OrderType; targetId?: number; x?: number; y?: number }>; blockedTicks?: number }
unit.lastDamagedTick?: number
```

有了它，「攻击命令锁 450 拍」「每个单位两次命令至少隔 18 拍」「闲置 90 拍重发」「只给新兵 / 闲兵补令」这些逻辑都可以删掉。

### 7.3 「光标判定」：能不能做（P0）

```ts
werhd.availableActions(unitId, targetId): Array<{ type: OrderType; label: 'capture'|'repair_bridge'|'occupy'|'enter'|'infiltrate'|'c4'|... }>
werhd.canEnter(unitId, containerId): { ok: boolean; reason?: 'full'|'not_occupiable'|'enemy_owned'|'wrong_size'|'deployed'|'no_path' }
```

相当于开放鼠标光标的判断。工程师不会再被派去占路灯和管子，也不会再往一栋进不去的民房里进几百次。那栋民房（#1633）在两局里白下了 81 次命令。

### 7.4 建筑放置（P0）

```ts
werhd.canPlaceMany(name, cells: Array<[x,y]>): boolean[]
werhd.placementCandidates(name, { near?, radius?, limit?, avoidBlockingExits? }): Array<{x,y}>
werhd.place(name, x, y): Receipt
{ type: 'building.placed', name, id, x, y } / { type: 'building.placeFailed', name, x, y, reason }
werhd.production.readyItems(): Array<{ queueType; name }>   // 替代写死的 status === 3
```

### 7.5 生产（P0 / P1）

- **P0**：队列项补 `etaTicks`、`blockedBy: 'low_power'|'no_funds'|'paused'`；事件 `production.started / ready / completed{unitId} / cancelled / blocked`。
- **P1**：`production.status(name)` 返回能不能造，不能造的原因为 `'prereq'|'buildLimit'|'queueFull'|'noFactory'|'lowPower'|'noCredits'`，加上缺少的前置、当前数量、上限、价格、建造时间；`produce` 返回实际入队数量。
- **现在的问题**：一次只敢排 1 个；钱曾堆到 5.7 万到 7 万却不造兵，扩展看不出卡在哪。

### 7.6 其他控制（P1）

| 能力 | 草案 | 现在的变通 |
| --- | --- | --- |
| 排队命令 / 路径点 | `order(ids, spec, { queue: true })`；`waypoints(ids, points, { mode, loop })` | 轮询里一步步手动下令 |
| 编队移动 | `formationMove(ids, x, y, { attack, keepSpeed, spacing })` | 部队拉成长队，单兵送死 |
| 跟随 / 护卫 | `follow(ids, leaderId, { distance })`；`guard(ids, targetId)`；`guardArea(ids, x, y, r)`，并写明 Guard / GuardArea 的语义 | 工程师每 60 拍被手动挪到部队后面 4 格 |
| 集结点 | `setRally(factoryId, x, y)` / `rally(factoryId)` | 每 60 拍把堵在工厂出口的战车挪走 |
| 显式修理 / 电力 / 展开 | `setRepair(id, on)`、`setPowered(id, on)`、`setDeployed(ids, on)`（设置，而不是切换） | `repair`、`deploy` 是切换，靠本地记账，有误关风险 |
| 卸载 / 撤出 | `unload(transportId, x?, y?)`、`evacuate(buildingId, unitIds?)` | 无法指定地点、无法只撤一部分 |
| 超级武器 | `superweapons()`：`ready`、`chargeTicksLeft`、`rechargeTicks`；发射回执；`superweapon.fired` 事件 | 从来没用过超武 |
| 批量命令 | `batch(cmds)`，同一拍原子入队 | 各种自定义间隔 |
| 出售 | 回执 + `building.sold{refund}` | 调用后直接当成功 |

编组同步（`group.set/get`、`onGroupChanged`）为 P2，主要方便和真人玩家混合操作。

---

## 八、观察数据

### 8.1 规则功能标记（P0）

`rules()` 补上 ini 里本来就有的字段：

```ts
capturable: boolean; needsEngineer: boolean;
insignificant: boolean; selectable: boolean; invisibleInGame: boolean;   // 装饰物、路灯、旗子
techBuilding: boolean; countsForVictory: boolean;                       // 按规则，不读触发器
produceCashAmount?: number; produceCashDelay?: number;                  // 油井
buildTimeTicks?: number; buildLimit?: number;
displayName?: string;                                                   // 与玩家界面语言一致
```

`unit.ownerKind?: 'self'|'allied'|'enemy'|'neutral'|'civilian'`。现在 `units('enemy')` 也把旗子算成战斗对象，扩展靠英文名正则挡。`displayName` 还能替代扩展里手工维护的中英对照表。

### 8.2 可达性与地形（P0：可达性和桥；P1：其余）

```ts
werhd.map.pathTo(unitId, x, y): { reachable: boolean; lengthTiles?: number; etaTicks?: number;
  waypoints?: XY[];   // 只返回已探索区域的点
  via?: { bridgeIds: number[] } } | undefined
werhd.map.reachable(unitIdOrZone, from, to): boolean
werhd.map.bridges(): Array<{ id; segments: XY[]; state: 'intact'|'damaged'|'destroyed'; hp?; maxHp?; repairHutId? }>   // 只列已探索的
tile.bridge.destroyed / tile.bridge.repairHutId
tile.passable?: { foot; track; wheel; water; amphibious }
werhd.map.snapshot(['landType','z','explored','visible','ore','passable'])   // 批量，替代每 120 拍的全图逐格扫描
werhd.map.explored(x, y): boolean
```

- 现在断桥和「这里本来没桥」分不清，修桥小屋对应哪座桥也不知道。
- 集结点和后撤点可能落在孤岛、水面或悬崖上。

### 8.3 经济（P1）

```ts
me().economy?: { harvestedTotal; spentTotal; refundTotal; otherIncome; incomePerMinute }
unit.harvester?: { load; capacity; state: 'toOre'|'harvesting'|'returning'|'unloading'|'idle'; refineryId? }   // 仅己方
tile.ore?: { kind: 'ore'|'gem'; amount }
werhd.map.oreFields(): Array<{ center; tiles; value; lastSeenTick }>   // 仅已探索
```

现在收入是用「钱的变化 + 自己记的花费」估出来的；找矿只看最近的一格，不看矿量，也不看能不能走到。

### 8.4 其他观察（P1 / P2）

| 数据 | 优先级 | 说明 |
| --- | --- | --- |
| `lastSeen()` 残影 | P1 | 只收录曾经可见的对象，`fate` 只在消失时可见才填。现在分不清「打掉了」和「看不到了」 |
| 超武倒计时（含敌方） | P1 | 原版对所有人显示 |
| 己方统计 `stats()` | P1 | 敌方统计等结算时再给（P2） |
| 真实伤害 `damageVs(a, b)` | P2 | 替代扩展自己的伤害估算公式；两者都可见时才返回 |
| 升级进度 `experience` | P2 | `veteranLevel` 已有 |
| 敌方 `firingAt`（只限正在打我方且自身可见的） | P2 | 慎重 |

---

## 九、如果只能先做一小部分

**最小方案：**

1. `gameEnd`（结果 + 原因）；
2. 屏幕消息事件（带字符串键和原文）；
3. `missionInfo()`（至少给关卡 id）；
4. 命令回执里的拒绝原因。

有了前三项，扩展就能按「关卡 id + 字符串键」维护每关的目标表，知道什么时候赢、为什么输。第四项能消掉实战里最大的几块浪费。

**第二步：**

- 统一事件流（受伤、摧毁、归属变化、援军）；
- 单位当前命令；
- `pathTo`；
- 规则功能标记；
- 常驻入口和状态机；
- 战役的 `next()`。

做到这一步，「整个战役一路自动托管下去」就能实现了。

---

## 附录：扩展现在靠猜的地方（节选）

| 猜什么 | 位置 | 怎么猜 |
| --- | --- | --- |
| 在不在对局里、有没有换局 | `page.mjs:28-36, 65-66` | `werhd` 在不在、对象是否换了、调用是否报错 |
| 对局结束 | `werhd-jev-player.mjs:1942` 等 3 处 | 正则匹配英文报错 |
| 胜利 | `werhd-jev-player.mjs:1904-1913` | 所有非盟友都 `defeated`（实战 0 次成立） |
| 暂停 / 卡死 | `werhd-jev-player.mjs:1880-1886` | 拍数 30 秒不变就停止托管 |
| 目标是哪栋建筑、是否完成 | `werhd-jev-objective.mjs` 全文件 | 中英对照表 + 正则 + 「可见格上不见了」 |
| 基地受攻击 | `werhd-jev-strategy.mjs:61-66` | 18 格内有带武器的敌人 |
| 谁在打我 | `werhd-jev-player.mjs:1190-1203` | 掉血 + 最近的可见敌人 |
| 损失 / 击杀 | `werhd-jev-player.mjs:311-327` | 物体 id 消失 |
| 断桥 | `werhd-jev-special.mjs:173-183` | 同一目标 2700 拍没打掉 |
| 能否占领 / 是否装饰物 | `werhd-jev-catalog.mjs:33-40` | 英文名正则 |
| 命令是否执行 | `werhd-jev-special.mjs:3-6, 412-470` 等 | 闲置时间 + 重发次数 + 超时 |
| 放置是否成功 | `werhd-jev-player.mjs:1116-1144` | 不确认，20 拍后重新选址 |
| 收入 | `werhd-jev-player.mjs:173-196` | 钱的变化 + 自记花费 |

完整调研记录由四个方向分别完成：生命周期与自动推进、战役目标与屏幕提示、命令回执与控制、观察数据。本文是合并去重后的版本。
