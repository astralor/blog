---
title: "当配置不等于行为：一次 OpenClaw thinking 语义排查"
published: 2026-03-06
description: "本来只是想讨论 GPT-5.4 的能力，最后却一路追到了 OpenClaw、Pi agent 与 provider 适配层之间的 reasoning 语义错位。"
tags: ["OpenClaw", "Claude 4.6", "GPT-5.4", "AI Agent", "Reasoning", "工程实践"]
category: "AI 思考"
image: ""
---

> 我原本只是想聊聊 GPT-5.4。结果聊着聊着，发现自己对 OpenClaw 里 thinking 配置的理解，可能一开始就错了。

先说明一件事：**这篇文章不是一份永久有效的配置指南。**

它基于 2026 年 3 月 6 日当天的 [OpenClaw 2026.3.2](https://github.com/openclaw/openclaw)、当时内置的 Agentic 核心（Pi agent）以及对应的 provider 适配逻辑做观察。OpenClaw、本地 runtime、provider SDK 和模型能力都在持续演化，所以文中的结论很可能会在未来某个版本失效。

但也正因为如此，这次排查反而让我更确定：**在 Agent 系统里，配置项本身往往不是事实，真实发出去的 payload 才是事实。**

## 从 GPT-5.4 开始，却没有停在 GPT-5.4

今天最开始的讨论，其实和 OpenClaw 没什么关系。

GPT-5.4 刚发布，我们在 Discord thread 里聊它和 Claude 4.6 的能力差异，顺手又聊到了 OpenClaw 里默认的 thinking 配置。因为前几天升级 OpenClaw 时，我刚把全局 `thinkingDefault: "high"` 去掉，改成让 Claude 4.6 回到新版默认的 `adaptive`。

这个动作当时看起来很顺理成章。

Anthropic 在 Claude 4.6 上引入了新的 [adaptive thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking)，官方文档也明确把它作为推荐方式。OpenClaw 的 [thinking 文档](https://docs.openclaw.ai/tools/thinking) 里也提到，Claude 4.6 这条链路已经适配了 adaptive。既然框架支持了，配置也切过去了，直觉上就会认为：**现在系统已经跑在官方推荐路径上。**

但真正有意思的地方，往往就藏在这种“看起来很顺理成章”的地方。

## 最容易犯的误解：配置写了什么，模型就收到了什么

如果你平时也在用这类 Agent 框架，大概会很自然地做出下面这个推理：

- `thinkingDefault: "adaptive"`
- OpenClaw 说支持 Claude 4.6 adaptive
- 那发给 Anthropic 的请求，应该就是 `thinking.type = adaptive`
- 既然 Anthropic 官方推荐 adaptive，那这大概率就是最佳实践

这条推理听起来非常合理。问题在于，它默认了一个前提：**配置层语义和最终请求层语义是等价的。**

而在 OpenClaw 这种系统里，这个前提并不总成立。

中间至少隔着几层：

- OpenClaw 自己的 thinking 抽象
- 不同 provider 的能力判断
- Pi agent 对模型能力的二次适配
- 最终实际发给 provider API 的 payload 组装

这几层里只要有一层做了智能判断，直觉就可能失效。

## 我是怎么一步步追下去的

一开始，我做的也是大多数人会做的事：先看源码。

很快就看到了一个很容易把人带偏的地方——OpenClaw 的打包代码里，确实有 `adaptive -> medium` 的映射。这让我一度误以为：所谓 adaptive，最终可能只是被框架内部降级成了一个固定的 medium thinking 档位。

如果只停在这一步，这篇文章大概就会写成另一种样子：一个框架没有真正透传 provider 新能力的典型案例。

但这次我多走了一步。

我临时打开了 Anthropic payload log，重启网关，直接去看真实请求体里到底写了什么。结果和我最初的源码直觉并不完全一致。

对于 Claude 4.6，当 `thinkingDefault` 设成 `adaptive` 时，实际发出去的是：

```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

这一下，问题的性质就变了。

它不是“adaptive 根本没生效”，而是：**OpenClaw 最终确实走了 Anthropic 的新接口格式，但默认 effort 是 medium，而不是我当时想象中的高档位。**

于是我又顺着这个思路继续测了两档。

- `thinkingDefault = high`
- `thinkingDefault = xhigh`

这一次不猜，直接抓真实 payload。

结果非常干脆：

对于 Claude 4.6，`high` 和 `xhigh` 最终都会发成：

```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "high" }
}
```

也就是说，在 **今天这个版本组合** 下，Claude 4.6 的实际行为更接近下面这张映射表：

- `adaptive` -> `adaptive + medium`
- `high` -> `adaptive + high`
- `xhigh` -> `adaptive + high`

至少对 Claude 4.6 而言，`xhigh` 并不会比 `high` 更高。

## 真正的复杂性，不在 Anthropic，而在框架的多层判断

事情如果到这里就结束，其实还只是一次普通的 provider 适配排查。

但讨论后来又绕回了 GPT-5.4。

因为我发现，当把模型切到 `gptclub-openai/gpt-5.4` 时，OpenClaw 会给出一个很有意思的提示：

> Thinking level set to high (xhigh not supported for gptclub-openai/gpt-5.4)

可与此同时，切到 `gptclub-openai/gpt-5.3-codex-spark` 时，`xhigh` 却是支持的。

如果只看 provider 名字，这件事会显得很怪：

- 都是 `gptclub-openai/...`
- 为什么一个支持 `xhigh`，一个不支持？

继续往下看代码，才发现 OpenClaw 对 `xhigh` 的支持不是按“你接的是哪家代理”来判断的，而是按**模型家族白名单**来判断的。当前硬编码的 allowlist 里，有 `gpt-5.2` 和几条 Codex 相关模型，但**没有 `gpt-5.4`**。

于是就出现了一个很典型的多层语义现象：

- 对 Claude 4.6，`xhigh` 实际落到 `adaptive + high`
- 对 GPT-5.4，`xhigh` 被降级成 `high`
- 对 `gpt-5.3-codex-spark`，因为命中 Codex 家族特判，可以真正享受到 `xhigh`

这时候你会发现，问题已经不再是“某个配置值该怎么选”。

真正的问题是：**在一个多 provider、多模型、带有框架级智能判断的 Agent 系统里，单个配置项已经不足以直接描述最终行为了。**

## 为什么这件事值得写下来

如果只是为了把某个配置调对，这次排查其实没必要写成一篇文章。

但我觉得它很值得记录，因为它暴露了一个更普遍的问题：我们很容易把“配置语义”当成“系统行为”，尤其是在这类抽象做得很好的框架里。

框架越好用，越容易让人忘记中间还隔着多少层。

你看到的是一个统一的 `thinkingDefault`。但在系统内部，它可能要经历：

- thinking level 规范化
- 模型能力判断
- provider allowlist 检查
- runtime 适配
- provider-specific payload 组装

最后你以为的“我把它设成了 xhigh”，很可能只是“我表达了一个想要更强思考的意图，而系统在当前模型能力边界内替我找到了最接近的落点”。

这个差别，在普通聊天场景里也许无所谓。但在 Agent 系统里，尤其是当你开始在多个模型之间切换、比较成本、比较延迟、比较质量时，它就非常重要。

因为你不是在调一句提示词，而是在调一条完整执行链路里的一个控制旋钮。

## 今天得到的不是结论，而是一套方法

我不太想把这篇文章写成“OpenClaw thinking 的最终答案”。

因为只要 OpenClaw 更新一个版本，或者 Pi agent 更新一层适配，或者 provider SDK 调整一次参数命名，这里的很多细节都可能重新洗牌。

今天真正值得记住的，不是某一张映射表，而是以后遇到类似问题时，应该怎么重新推导：

1. 先看当前配置值
2. 再看框架的 thinking / capability 代码
3. 再看 allowlist 或 downgrade 逻辑
4. 最后一定抓真实 payload 做终审

如果必须把这次排查压成一句话，那大概就是：

**在 Agent 系统里，配置是意图，payload 才是事实。**

而且今天的事实，也只是今天这个版本组合下的事实。

也许下一个版本里，`gpt-5.4` 就会被加入 `xhigh` allowlist；也许再下一版里，Claude 4.6 的 `xhigh` 会有单独语义；也许某一天，整个 thinking 抽象都会被重新设计。

这并不让今天的排查失去意义。恰恰相反——它提醒了我一件更重要的事：

**在快速演化的 Agent 框架里，版本本身就是语义的一部分。**

所以与其记住某个配置项，不如记住怎么重新验证它。

---

**张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.06**
