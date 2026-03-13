---
title: "拆解 OpenClaw 并发控制：为什么子 Agent 默认并发比主 Agent 还高？"
published: 2026-03-13
description: "升级到 v2026.3.12 后，我们发现子 Agent 的默认并发上限是 8，而主 Agent 只有 4。这看起来不太对——直到我们把整个命令队列的源码翻了一遍。"
tags: ["OpenClaw", "并发", "架构分析", "Agent", "工程实践"]
category: "工程实践"
---

> 上一篇文章里，我们追踪了一个让并发配置从未生效的隐藏 bug。这次的问题不一样——并发终于生效了，但默认值看起来有点反直觉。

## 一、一个反直觉的默认值

上一篇文章[^1]里我们追踪了 OpenClaw 的一个并发状态隔离 bug——打包工具把一份运行时状态复制成了多份独立副本，导致 `maxConcurrent` 配多少都没用。我们提交了 Issue 和 PR，维护者在此基础上做了一次更全面的审计，把涉及十个模块的同类问题一起修了，随 v2026.3.12 发布。

升级确认完成后，我们检查了一下当前的并发配置。

```yaml
agents:
  defaults:
    maxConcurrent: 10          # 我们手动调过，默认是 4
    subagents:
      maxConcurrent: 8         # 默认值
```

子 Agent 的默认并发上限（8）比主 Agent 的默认值（4）还高。直觉上，子 Agent 是从主 Agent 里面派生出来的，怎么也不应该比它的"父级"并发更高。上次那个 bug 就是因为我们对代码的实际行为做了不正确的假设才追了三天，这次决定先看代码再下结论。

追完源码之后发现：**`maxConcurrent` 和 `subagents.maxConcurrent` 根本不是同一个并发池。**

OpenClaw 的命令队列实际上有三条独立的 command lane——Main、Subagent 和 Cron——每条 lane 有自己的队列和并发上限，互不阻塞。`sub > main` 不是 bug，而是一个经过设计的负载隔离策略。

后面的内容就是一步步确认这个模型的过程。

## 二、三条命令车道

先把结论画出来。OpenClaw 的并发控制长这样：

```
User Request
     │
     ▼
Session Lane (per-session serialization)
     │
     ▼
Global Command Lanes
 ┌────────────────┬────────────────┬────────────────┐
 │ Main           │ Subagent       │ Cron           │
 │ default: 4     │ default: 8     │ default: 5     │
 │ user messages  │ background AI  │ scheduled jobs │
 └────────────────┴────────────────┴────────────────┘
```

这是一个双层嵌套的设计。第一层是 **session lane**：每个对话（比如 Discord 的一个频道）内部严格串行，保证消息顺序。第二层是 **global lane**：不同 session 之间并行，但需要竞争对应 lane 的并发槽位。

三条 global lane 各自独立：Main 处理用户入站消息，Subagent 处理后台子 Agent 任务，Cron 处理定时任务。它们之间不共享槽位，不互相阻塞。

下面是代码层面的证据。

## 三、源码追踪

从配置的读取入口开始。在 dist 文件里找到了两个函数，各自独立地读取各自的配置项：

```javascript
function resolveAgentMaxConcurrent(cfg) {
    const raw = cfg?.agents?.defaults?.maxConcurrent;
    if (typeof raw === "number" && Number.isFinite(raw))
        return Math.max(1, Math.floor(raw));
    return 4;
}

function resolveSubagentMaxConcurrent(cfg) {
    const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
    if (typeof raw === "number" && Number.isFinite(raw))
        return Math.max(1, Math.floor(raw));
    return 8;
}
```

它们在 gateway 启动时被分别调用，设定到不同的 `CommandLane` 上：

```javascript
setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
```

`setCommandLaneConcurrency` 的实现很直接——lane 的状态存储在一个 `Map<string, LaneState>` 里，每条 lane 独立维护自己的并发计数：

```javascript
function setCommandLaneConcurrency(lane, maxConcurrent) {
    const state = getOrCreateLaneState(lane);
    state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    drainLane(state);
}
```

队列的核心循环只看当前 lane 的计数器，不跨 lane 检查：

```javascript
while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
    // 从队列里取一个任务执行
}
```

任务的路由也很明确：子 Agent 运行时显式标记 `lane: AGENT_LANE_SUBAGENT`，普通请求不指定 lane 时 fallback 到 `main`，Cron 任务走 `CommandLane.Cron`。源码里有一行注释写得很直白：`"session lane + global lane"`。执行模式是先获取 session 级别的锁，再获取 global lane 的槽位：

```javascript
enqueueSession(() => enqueueGlobal(async () => { ... }))
```

只有两层都拿到了，任务才开始执行。

为了避免自己的分析有偏差，我们还让 Codex 在 ACP 模式下独立追了一遍源码，定位到了相同的函数、相同的 Map 结构、相同的 lane 路由逻辑，结论完全一致。

## 四、为什么这样设计

三条 lane 承载的是三种不同特征的负载：

- **Main**：处理入站消息。用户在 Discord 或 Telegram 发了条消息，Agent 需要生成回复。这是交互式的，用户在等。
- **Subagent**：子 Agent 任务。主 session 里 spawn 了一个 Codex 去分析代码，或者启动了一个子 Agent 做搜索。这是批处理式的，后台执行。
- **Cron**：定时任务。心跳检查、信息采集、定期归档。这是计划式的，不依赖用户触发。

这个设计本质上是在做**负载隔离（workload isolation）**：交互式任务、后台 AI 任务、定时任务分别运行在不同并发池里，避免互相抢占资源。这和 Web 服务器把静态文件、API 请求和 WebSocket 连接分到不同线程池是一样的思路。

如果子 Agent 和主 Agent 共享同一个并发池，会出现一个问题：你 spawn 了几个子 Agent 把池子占满了，新来的用户消息全部排队等待。机器人对所有人"失去响应"，直到某个子 Agent 跑完释放槽位。独立 lane 的设计确保了不管子 Agent 跑了多少，用户消息的响应通道永远畅通。

`sub(8) > main(4)` 的逻辑也因此成立。4 个主 session 同时处理用户消息，每个都可能 spawn 1-2 个子 Agent。全局的子 Agent 上限给到 8，能容纳典型的并发 spawn 量，不会因为槽位不够让一半主 session 的子任务排队。

## 五、实际影响和配置建议

理解了并发模型之后，有几件事变得清楚了。

**理论峰值是加法，不是乘法。** 以我们当前的配置（Main=10, Subagent=8, Cron=5）为例，理论最大同时运行的 LLM 调用是 10 + 8 + 5 = 23。不是 10 × 8 + 5 = 85。Subagent lane 是全局共享的一个池子，不是每个 Main session 各一个。

**配置优化有了明确的方向。** 不同使用场景下，三个值的侧重点不同：

- **单人使用**：Main 不需要太高，2-3 足够。日常峰值可能就是 1-2 个 main session + 1-2 个 subagent + 1-2 个 cron job。
- **多人 / 多频道**：Main 适当调高到 4-6，确保不同用户的消息能并行处理。
- **频繁使用子 Agent**（比如 ACP 模式委派编码任务）：Subagent 可以适当调高。
- **大量定时任务**：Cron 从默认的 5 往上调，避免密集触发时排队过久。

**上一篇文章里的 bug 有了更完整的解释。** 之前并发 bug 导致所有 lane 的 maxConcurrent 都变成了 1。这意味着整个系统——Main、Subagent、Cron——全部退化成串行执行。任何一个慢任务都会堵住整条车道，进而导致我们观察到的级联超时。修复之后三条车道各自恢复了设计的并发上限，所以系统恢复正常不是因为某一个配置改对了，而是因为整个队列模型终于按设计工作了。

---

从一个看起来"不太对"的默认值出发，最终拆解出了 OpenClaw 的整个并发控制架构。如果你也在用 OpenClaw 并且对并发配置有困惑，先搞清楚三条车道各自控制什么，再根据自己的使用场景调整数值，比盲目调大某个值要有效得多。

*张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.13*

[^1]: [追踪 OpenClaw 的一个隐藏 bug：并发配置为什么从未生效](/posts/openclaw-concurrency-bug)
