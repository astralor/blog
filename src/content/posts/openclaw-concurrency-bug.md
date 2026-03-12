---
title: "追踪 OpenClaw 的一个隐藏 bug：并发配置为什么从未生效"
published: 2026-03-12
description: "多个 Agent 明明配了并发，却永远在互相等待。我们花了三天追踪这个 OpenClaw 的隐藏 bug，最终发现构建工具把一份运行时状态复制成了十份独立的副本。"
tags: ["OpenClaw", "并发", "Code-Splitting", "Bug 追踪", "开源贡献", "工程实践"]
category: "工程实践"
image: "./images/openclaw-concurrency-hero.png"
---

> 在 OpenClaw 上跑多个 Agent 的时候，我们发现了一件奇怪的事：不管并发配置怎么调，所有请求永远在排队。

## 一、并发失效，请求在排队

我们在 OpenClaw 上跑了好几个 Agent，主要分布在 Discord 的不同频道上。最早注意到问题是在 Discord 里——我们经常看到多个 Agent 明明应该可以同时工作，但实际上总是在互相等待，一个 Agent 回复完了另一个才开始动。一开始我们以为这可能是 Discord 这边的什么限制，就先继续观察，想多收集一些信息再判断。

后来我们观察到，不光是 Discord 内部的多个 Agent 互相等待，跨平台也是一样的。比如 Telegram 上正在跟霄晗（我们的 AI 助手）聊事情的时候，Discord 上另一个 Agent 就一直转圈，直到 Telegram 这边对话彻底结束了才开始处理。这就不太可能是单个平台的问题了。我们的 `agents.defaults.maxConcurrent` 配的是 10，理论上最多可以有 10 个任务同时跑，不同频道、不同 Agent 的请求完全没有理由互相等待。

当天我们做了一个临时的 patch 来尝试缓解串行问题，但掌握的信息还不够多，根因还不清楚，所以继续观察。结果第二天出了更大的问题——cron 开始大面积崩溃，我们一度还以为是前一天的 patch 引发的。先是天气播报连续超时，300 秒的 timeout 到了，LLM 请求还挂着，session 里一条消息都没有。然后余额监控也超时了，线程归档也超时了。我们试着换了个 provider，结果反而更糟：三个任务几乎同时触发，只有最轻量的版本检查跑完了，剩下的全挂在那里。重启 gateway 能恢复一部分任务，但天气播报怎么都起不来，反复重建、反复超时。

这时候日志里有一行引起了注意：

```
lane wait exceeded: lane=main waitedMs=66810 queueAhead=0
```

`queueAhead=0` 说明前面没有排队的任务，但实际等了 66 秒。不是因为队列太长导致等待，是 lane 本身被什么东西堵住了。而我们确认过 `maxConcurrent` 的配置读取是没有问题的，值确实是 10。配置是对的，但系统的行为完全不像配了 10 的样子。

## 二、追踪过程

在动手挖代码之前，我们先去 GitHub Issues 搜了一下，把已关闭和未关闭的都翻了。

确实有人遇到过。Issue #16055[^1] 报的是 "Message Processing Bottleneck"，已经被标成 stale 了，六条评论里好几个人描述了一模一样的症状——maxConcurrent 设到 100 都没用，Telegram 和 LINE 的消息互相阻塞。还有个更早的 #1159[^2]，有人请求加并发支持，因为长期没人回应被关了。Reddit 上也有人吐槽过，帖子标题就叫 "concurrency=1 is killing momentum"。

但这些讨论基本都停留在猜测 provider 限流或者网络问题的层面，有人给了个 workaround 说多建几个 Telegram group 来分散请求。根因没有人找到过，也没有可用的解决方案。看来只能我们自己往下挖了。

既然配置读取确认没问题，那大概率是执行层面的事。我们在 gateway 主进程的 `reply-*.js` 里注入了一组诊断日志，打印 lane 创建时的实际参数，想看看运行时到底拿到了什么值。重启之后日志显示 `lane=main maxConcurrent=10`——这边是对的。

奇怪的是，Telegram 消息进来的时候，这段日志压根没触发。我们又看了几条请求，确实都没有走到 `reply-*.js` 这个文件。

这个发现改变了排查的方向。既然 TG 消息不走 reply，那它走哪里？翻了一下 dist 目录里的其他文件，找到了 `pi-embedded-*.js`，这是 OpenClaw 实际处理消息的 worker 模块，里面有一套独立的 `drainLane` 实现。我们在这个文件里加了另一组 `[DIAG-PI]` 标记的日志，重启后发 了条 TG 消息——果然走的是这里。

接着去看 pi-embedded 里 `getLaneState()` 的实现，发现事情比想象的简单也比想象的严重：它创建 lane 的时候 `maxConcurrent` 直接写死了 1，而且整个模块没有暴露 `setCommandLaneConcurrency` 这个函数。也就是说 gateway 启动时通过 `setCommandLaneConcurrency()` 设进去的 10，根本就没有办法传到这里来。

但这件事本身说不通——源码里 `command-queue.ts` 只有一份，`setCommandLaneConcurrency` 和 `getLaneState` 明明写在同一个文件里，为什么到了 dist 目录里就变成了两套互不相干的实现？

带着这个疑问，我们用 `rg` 在 dist 目录里搜了一下 `let nextTaskId = 1;` 这个特征字符串（每份 command-queue 的副本都会有这一行），结果出来了十个匹配。OpenClaw 的打包工具 tsdown[^3] 在处理多入口构建的时候，把 `command-queue.ts` 连同它的模块级状态一起复制到了十个独立的 chunk 里。每个 chunk 都有自己的 `const lanes = new Map()`、自己的 `nextTaskId`、自己的 `gatewayDraining` 标志，彼此完全隔离。

看到这个结果的时候，之前所有的疑问都解释得通了：`setCommandLaneConcurrency()` 在启动时把 maxConcurrent 设进了 reply chunk 的那份 Map，但 Telegram 和 Discord 的消息处理走的是 pi-embedded chunk 里的另一份 Map，那份 Map 从来没有被设过任何值，maxConcurrent 永远是默认的 1。

![一份源码经过打包工具分裂成多个独立副本，配置信号只到达了其中一个](./images/openclaw-state-isolation.png)

## 三、临时修复

理解了状态隔离的问题之后，cron 超时的根因也可以解释了。cron job 超时的时候，timeout handler 在某个 chunk 里拒绝了任务的 Promise，但负责清理 lane slot 的 `completeTask()` 运行在另一个 chunk 的 Map 上，那份 Map 里根本没有这个任务的记录，所以什么都没清掉。这个 slot 就永久占用了。而 `cron.maxConcurrentRuns` 默认是 1，意味着只要有一个 slot 被卡死，后面所有的 cron job 都会排队等待一个永远不会释放的位置。级联锁死，唯一的恢复方式就是重启 gateway。

这也解释了为什么天气播报删掉重建就能恢复——新 job 走了新的 session lane，绕开了被卡死的旧 slot。但那个旧 slot 其实还在那里，只是没人再去访问它了。

![cron slot 被永久占用后的级联锁死：后续任务全部排队等待一个永远不会释放的位置](./images/openclaw-cron-deadlock.png)

搞清楚根因之后，我们先恢复自己的实例。在 dist 目录里定位到四个实际被加载的 chunk 文件，用 `sed` 把写死的 `maxConcurrent: 1` 替换成配置文件里设定的 10。同时把 `cron.maxConcurrentRuns` 从默认的 1 调到 5——slot 泄漏在根因修复前仍然可能发生，但需要连续五次超时才会完全锁死 cron，比原来一次就死锁的情况留出了足够的缓冲。

重启之后验证了效果：之前 300 秒超时的天气播报 43 秒就完成了——不是模型变快了，是请求终于不用排队等那个被卡死的 slot 了。这个 dist patch 每次 OpenClaw 升级会被覆盖，不是长久之计，但足以撑到正式修复发布。

## 四、我们的 PR

有意思的是，OpenClaw 的代码库里其实已经解决过完全一样的问题，只是没有覆盖到 `command-queue.ts`。

`src/hooks/internal-hooks.ts` 的注释写得很清楚[^4]：把状态挂到 `globalThis` 上，用 `Symbol.for()` 做 key，这样无论打包器复制出多少份模块，运行时引用的都是进程里唯一的那份数据。`src/context-engine/registry.ts` 也用了同样的模式。

参照这个已有的做法，我们改写了 `command-queue.ts` 的状态管理。开发过程中用 Claude 做代码编写，再交给 Codex 做独立评审——两边在一个关键细节上达成了一致：`gatewayDraining` 和 `nextTaskId` 是原始值类型，不能从状态对象里解构出来赋给局部变量，每次都得通过 `getCommandQueueState()` 函数去读。16 个单元测试全部通过，然后我们通过 OpenClaw 走了完整的提交流程：fork、推分支、按 CONTRIBUTING.md 填 PR 模板、CI 全绿，提交了 Issue #41901 和 PR #41903。

## 五、维护者做了更全面的审计

提交之后两天，OpenClaw 维护者 Vincent Koc 在 Issue 下面回复了。他没有直接合并我们的 PR，而是基于这个发现对整个代码库做了一次全面审计。结果 `command-queue.ts` 只是其中一个——同样的模块级状态隔离问题存在于消息队列、消息去重缓存、入站去重、嵌入式运行状态、Slack 线程缓存，以及 Telegram 的线程绑定、草稿分配和发送记录里[^5]，总共涉及 10 个源文件的修改。

这也解释了社区里一直有人在报的跨频道消息重复投递问题[^6][^7]。之前有人提过一个 dedupe cache 的修复[^8]，但修完之后 bug 还是存在——因为 dedupe cache 本身也被 code-splitting 复制成了多份独立副本，不同 chunk 之间的缓存互相看不到对方。

Vincent 把所有的修复打包到了一个更全面的 PR 里，引用了我们的 Issue 和 PR 作为上下文。从范围上看，我们修了一个模块，他修了十个。我们主动关闭了自己的 PR，让位给这个更完整的修复。

## 六、下个版本

这批修复预计会随 OpenClaw 的下一个版本发布。到时候 `agents.defaults.maxConcurrent` 的配置会真正生效，cron 超时不会再导致永久的 slot 占用，跨频道消息重复投递的问题也会改善。

如果你现在正在用 OpenClaw 并且遇到了并发请求串行、cron 莫名超时、或者同一条消息被重复投递的问题，根因很可能就是这个。临时的 workaround 是在 dist 目录里 patch maxConcurrent 的值，但每次升级都要重新操作，等下个版本出来就不用了。

从最初注意到两个频道的消息互相等待，到最终推动了一次覆盖十个模块的修复，前后大概三天。一开始只是觉得并发配置没生效，追着追着发现影响面远比想象的大。这大概也是开源的好处——一个用户的发现和一次小修复，可以推动维护者做一次更彻底的审计和改进。

*张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.12*

[^1]: [GitHub Issue #16055 — Message Processing Bottleneck](https://github.com/openclaw/openclaw/issues/16055)
[^2]: [GitHub Issue #1159 — Feature Request: Parallel Session Processing](https://github.com/openclaw/openclaw/issues/1159)
[^3]: tsdown 是基于 Rolldown（Rust 实现的 Rollup 兼容引擎）的 TypeScript 打包工具，由 VoidZero 团队维护。详见 [tsdown.dev](https://tsdown.dev)。
[^4]: OpenClaw 源码 `src/hooks/internal-hooks.ts`，2026.3.9 版本。
[^5]: [GitHub PR #43683 — fix(runtime): duplicate messages, share singleton state across bundled chunks](https://github.com/openclaw/openclaw/pull/43683)
[^6]: [GitHub Issue #25192 — iMessage duplicate message delivery](https://github.com/openclaw/openclaw/issues/25192)
[^7]: [GitHub Issue #33150 — Signal duplicate message delivery](https://github.com/openclaw/openclaw/issues/33150)
[^8]: [GitHub PR #33168 — fix(queue): dedupe queued message IDs across drain restarts](https://github.com/openclaw/openclaw/pull/33168)
