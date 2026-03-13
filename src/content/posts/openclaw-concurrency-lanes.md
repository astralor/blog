---
title: "拆解 OpenClaw 并发控制：为什么子 Agent 默认并发比主 Agent 还高？"
published: 2026-03-13
description: "升级到 v2026.3.12 后，我们发现子 Agent 的默认并发上限是 8，而主 Agent 只有 4。这看起来不太对——直到我们把整个命令队列的源码翻了一遍。"
tags: ["OpenClaw", "并发", "架构分析", "Agent", "工程实践"]
category: "工程实践"
---

> 上一篇文章里，我们追踪了一个让并发配置从未生效的隐藏 bug。这次的问题不一样——并发终于生效了，但默认值看起来有点反直觉。

## 一、升级之后

上一篇文章[^1]里我们追踪了 OpenClaw 的一个并发状态隔离 bug——打包工具把一份运行时状态复制成了多份独立副本，导致 `maxConcurrent` 配多少都没用。我们提交了 Issue 和 PR，维护者在此基础上做了一次更全面的审计，把涉及十个模块的同类问题一起修了，随 v2026.3.12 发布。

升级的过程没什么波折。确认版本号、校验配置、检查旧的本地 patch 是否被正确覆盖——标准流程。值得一提的是修复的范围：新版本引入了一个集中式的 `resolveGlobalSingleton()` 函数，通过 `Symbol.for("openclaw.xxx")` 把所有跨 chunk 共享的状态统一挂在 `globalThis` 上。我们在 dist 文件里搜了一下，找到了 25 个 singleton key，从命令队列、消息去重缓存到 Telegram 线程绑定全部覆盖。比我们当初只改 command-queue 一处，覆盖面大得多。

升级确认完成后，我们顺手检查了一下当前的并发配置。

```yaml
agents:
  defaults:
    maxConcurrent: 10          # 我们手动调过
    subagents:
      maxConcurrent: 8         # 默认值
```

等一下。`subagents.maxConcurrent` 的默认值是 8，而 `maxConcurrent` 的默认值是 4。子 Agent 的并发上限比主 Agent 还高？

第一反应是觉得这不太对。直觉上，子 Agent 是从主 Agent 里面派生出来的，怎么也不应该比它的"父级"并发更高吧？就好比一栋楼最多能开 4 部电梯，但每部电梯里最多能站 8 个人——这逻辑上说不通啊。

但直觉不一定可靠。上次那个 bug 就是因为我们对代码的实际行为做了不正确的假设才追了三天。这次决定先看代码再下结论。

## 二、两条独立的车道

从配置的读取入口开始追踪。在 dist 文件里找到了两个函数：

```javascript
function resolveAgentMaxConcurrent(cfg) {
    const raw = cfg?.agents?.defaults?.maxConcurrent;
    if (typeof raw === "number" && Number.isFinite(raw))
        return Math.max(1, Math.floor(raw));
    return 4;  // 默认值
}

function resolveSubagentMaxConcurrent(cfg) {
    const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
    if (typeof raw === "number" && Number.isFinite(raw))
        return Math.max(1, Math.floor(raw));
    return 8;  // 默认值
}
```

两个函数各自读取各自的配置，互不干扰。接下来看它们在哪里被使用：

```javascript
setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
```

`CommandLane.Main` 和 `CommandLane.Subagent` 是两个不同的 lane 标识。它们被分别传入 `setCommandLaneConcurrency`，设定各自的并发上限。

再看 `setCommandLaneConcurrency` 的实现：

```javascript
function setCommandLaneConcurrency(lane, maxConcurrent) {
    const state = getOrCreateLaneState(lane);
    state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    drainLane(state);  // 尝试执行排队中的任务
}
```

lane 的状态存储在一个 `Map<string, LaneState>` 里。每条 lane 有自己的 `activeTaskIds`（当前正在执行的任务集合）和 `maxConcurrent`（并发上限）。队列的核心循环长这样：

```javascript
while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
    // 从队列里取一个任务执行
}
```

每条 lane 只看自己的计数器，不跨 lane 检查。

到这里就清楚了：`maxConcurrent` 和 `subagents.maxConcurrent` 控制的根本不是同一条车道。它们是**两条完全独立的并行车道**，各有各的队列、各有各的并发上限、各有各的任务计数。

之前那个"电梯"的类比是错的。正确的模型不是"一栋楼里的电梯"，而是"两条各自独立的高速公路车道"——Main 车道和 Subagent 车道并排运行，互不阻塞。

## 三、还有第三条车道

继续往下挖，发现不止两条车道。在 gateway 的初始化代码里，除了 `CommandLane.Main` 和 `CommandLane.Subagent`，还有直接使用 `CommandLane.Cron` 的地方。Cron 任务有自己专属的车道，它的并发由 `cron.maxConcurrentRuns` 控制。

三条车道的完整拓扑：

```
入站请求
    │
    ├── session lane (per-session 串行保序)
    │       └── 确保同一个对话内的消息按顺序处理
    │
    └── global lane (跨 session 并发控制)
            ├── Main       ← maxConcurrent (默认 4)
            ├── Subagent   ← subagents.maxConcurrent (默认 8)
            └── Cron       ← cron.maxConcurrentRuns (默认 5)
```

这是一个双层嵌套的设计。第一层是 session lane：每个对话（比如 Discord 的一个频道）内部是严格串行的，保证消息顺序。第二层是 global lane：不同 session 之间是并行的，但需要竞争对应 lane 的并发槽位。

源码里有一行注释写得很直白：`"session lane + global lane"`。执行模式是：

```javascript
enqueueSession(() => enqueueGlobal(async () => { ... }))
```

先获取 session 级别的锁（保证该对话内串行），再获取 global lane 的槽位（控制全局并发）。只有两层都拿到了，任务才开始执行。

## 四、为什么 sub > main 是合理的

理解了三车道模型之后，回头看那个"反直觉"的默认值，反而觉得设计得很合理。

三条车道承载的是**三种不同特征的负载**：

- **Main (默认 4)**：处理入站消息。用户在 Discord 或 Telegram 发了条消息，Agent 需要生成回复。这是交互式的，用户在等。
- **Subagent (默认 8)**：子 Agent 任务。主 session 里 spawn 了一个 Codex 去分析代码，或者启动了一个子 Agent 做搜索。这是批处理式的，后台执行。
- **Cron (默认 5)**：定时任务。心跳检查、信息采集、定期归档。这是计划式的，不依赖用户触发。

如果子 Agent 和主 Agent 共享同一个并发池会怎样？假设并发上限是 4，你 spawn 了 4 个子 Agent——Main lane 满了，新来的用户消息全部排队。机器人对所有人"失去响应"，直到某个子 Agent 跑完释放槽位。这在体验上是灾难性的。

独立车道的设计确保了：不管子 Agent 跑了多少，用户消息的响应通道永远畅通。

sub(8) > main(4) 的逻辑也说得通。4 个主 session 同时处理用户消息，每个都可能 spawn 1-2 个子 Agent。如果子 Agent 的全局上限只有 4，那一半主 session 的子任务就得排队等。给到 8，能容纳典型的并发 spawn 量。

而且这三个数字都是可配置的。OpenClaw 给了一组合理的默认值，但如果你的使用场景不同——比如单人使用不需要那么多主并发，或者频繁使用子 Agent 需要更高的 subagent 上限——都可以按需调整。

## 五、一些实际影响

理解了并发模型之后，有几件事变得清楚了。

**理论峰值不是你以为的那样。** 三条车道是加法关系，不是乘法关系。以我们当前的配置（Main=10, Subagent=8, Cron=5）为例，理论最大同时运行的 LLM 调用是 10 + 8 + 5 = 23。不是 10 × 8 + 5 = 85。Subagent lane 是全局共享的，不是每个 Main session 各一个。

**配置优化有了明确的方向。** 如果你是单人使用，日常峰值可能就是 1-2 个 main session + 1-2 个 subagent + 1-2 个 cron job。Main 不需要设到 10。如果你频繁使用子 Agent（比如 ACP 模式委派编码任务），subagent 的值可以适当调高。如果你有大量定时任务，cron 的值可能需要从默认的 5 往上调。

**上一篇文章里的 bug 有了更完整的解释。** 之前并发 bug 导致所有 lane 的 maxConcurrent 都变成了 1。这意味着整个系统——main、subagent、cron——全部退化成串行执行。任何一个慢任务都会堵住整条车道，进而导致我们观察到的级联超时。修复之后三条车道各自恢复了设计的并发上限，互不干扰，所以系统恢复正常不是因为某一个配置改对了，而是因为整个队列模型终于按设计工作了。

## 六、交叉验证

这次分析我们用了两条独立的路径：手动在 dist 文件里 grep + 阅读源码，以及通过 ACP 模式让 Codex 独立做同样的分析。两边在核心结论上完全一致：

- 三条独立的 CommandLane，互不阻塞
- 双层嵌套：session lane（串行）+ global lane（并行）
- sub > main 是设计意图，不是 bug

Codex 还补充了一些细节，比如子 Agent 运行时显式标记 `lane: AGENT_LANE_SUBAGENT`（三处 call site），以及普通请求不指定 lane 时 fallback 到 `main` 的逻辑。

两条路径得出相同结论，增加了我们对分析准确性的信心。

---

从一个看起来"不太对"的默认值出发，最终拆解出了 OpenClaw 的整个并发控制架构。回过头看，这个设计其实很常见——Web 服务器把静态文件、API 请求和 WebSocket 连接分到不同的线程池里，道理是一样的。不同特征的负载用不同的并发池来管理，避免互相干扰。只是在 Agent 框架的语境下，这种设计不太容易直接从配置项的命名上看出来。

如果你也在用 OpenClaw 并且对并发配置有困惑，希望这篇分析能帮你理解背后的模型。先搞清楚三条车道各自控制什么，再根据自己的使用场景调整数值，比盲目调大某个值要有效得多。

*张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.13*

[^1]: [追踪 OpenClaw 的一个隐藏 bug：并发配置为什么从未生效](/posts/openclaw-concurrency-bug)
