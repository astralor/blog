---
title: "OpenClaw 的 thinking 设计：一次配置语义的追踪与产品思考"
published: 2026-03-06
description: "从 GPT-5.4 的讨论开始，一路追到 OpenClaw 的 reasoning 语义层——发现大部分人对 Agent 框架里 thinking 配置的理解，可能从一开始就是错的。"
tags: ["OpenClaw", "Claude", "OpenAI", "AI Agent", "Reasoning", "工程实践", "产品思考"]
category: "AI 思考"
image: ""
---

> 从聊 GPT-5.4 开始，最后追到了 Anthropic 的真实请求体里。中间经历的每一层，都在悄悄改写"thinking"这个词的含义。

先说明一件事：**这篇文章不是一份永久有效的配置指南。**

它基于 2026 年 3 月 6 日当天的 [OpenClaw 2026.3.2](https://github.com/openclaw/openclaw)、当时内置的 Agentic 核心（Pi agent）以及对应的 provider 适配逻辑做观察。OpenClaw、本地 runtime、provider SDK 和模型能力都在持续演化，文中的结论很可能会在未来某个版本失效。

但也正因为如此，这次排查反而让我更确定一件事：**在 Agent 系统里，配置项本身往往不是事实，真实发出去的 payload 才是事实。**

## 从 GPT-5.4 开始

今天 GPT-5.4 发布，我和我的 OpenClaw 助手在 Discord thread 里聊它和 Claude 4.6 的能力差异——benchmark、定价、生态位，以及一个特别引起注意的点：GPT-5.4 在 reasoning 上的表现和之前的 GPT 系列有些不一样，它对 thinking 的处理方式跟 Claude 的 adaptive thinking 走了不同的路线。

这就引出了一个自然的问题：**在 OpenClaw 里，这两种不同的 thinking 模式，最终是怎么被统一处理的？**

前几天升级 OpenClaw 时，我刚把全局 `thinkingDefault: "high"` 去掉，改成让 Claude 4.6 回到新版默认的 `adaptive`。这个动作当时看起来很顺理成章——Anthropic 在 Claude 4.6 上引入了新的 [adaptive thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking)，官方文档把它作为推荐方式。OpenClaw 的 [thinking 文档](https://docs.openclaw.ai/tools/thinking) 也提到，Claude 4.6 这条链路已经适配了 adaptive。既然框架支持了，配置也切过去了，那系统应该已经跑在官方推荐路径上了吧？

大部分人大概都会这么想。

## 一个很常见的直觉陷阱

如果你用过这类 Agent 框架，大概会很自然地做出下面这个推理：

- `thinkingDefault: "adaptive"`
- OpenClaw 说支持 Claude 4.6 adaptive
- 那发给 Anthropic 的请求应该就是 `thinking.type = adaptive`
- effort 没有额外配置，那自然走 Claude 的官方默认值
- 没什么需要担心的

这条推理听起来非常合理。问题在于，它默认了一个前提：**配置层语义和最终请求层语义是等价的。**

而基于我对 OpenClaw 架构的了解，这个前提并不一定成立。

OpenClaw 不是一个简单的 API 转发层。在配置和最终请求之间，至少隔着好几层处理逻辑——而这些中间层是否会对 thinking 做额外的智能判断，从文档上看不出来。这种失效是静默的——没有报错，没有告警，系统正常运行，只是你以为的行为和实际行为之间，可能已经产生了偏差。

在后续的追踪中，我们逐步确认了中间的完整链路：

- OpenClaw 自己的 thinking 抽象（`off/minimal/low/medium/high/xhigh/adaptive`）
- Pi agent 的 `mapThinkingLevel()` 函数，对 thinking level 做二次映射
- 不同 provider 的能力判断和 allowlist 检查
- 最终实际发给 provider API 的 payload 组装

这几层里只要有一层做了智能判断，直觉就可能失效。

## 不看到事实，就不会停下来

和 AI 一起工作久了，有一个经验会变得越来越深刻：**模型的判断是基于已有认知的，如果不追根到底去验证，极大可能是幻觉。**

这不是偶发现象。Anthropic 自己在 [Claude's Character](https://www.anthropic.com/research/claude-character) 文档里也承认，模型在面对不确定信息时会倾向于给出看起来合理但实际未经验证的回答。OpenAI 的 [GPT-4 Technical Report](https://arxiv.org/abs/2303.08774) 里也明确把 hallucination 列为核心局限之一。学术界对这个问题的研究更是持续深入——Huang 等人在 [A Survey on Hallucination in Large Language Models](https://arxiv.org/abs/2311.05232) 中系统性地梳理了 LLM 幻觉的成因和缓解策略。

所以我的习惯是：**在涉及系统行为的判断上，不看到事实不会停下来。**

这次也一样。我对 `thinkingDefault: "adaptive"` 到底最终发了什么给 Anthropic，没有"想当然"的判断——而是决定直接去看。

打开了 Anthropic payload log（环境变量 `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1`），重启网关，直接去读真实请求体。

对于 Claude 4.6，当 `thinkingDefault` 设成 `adaptive` 时，实际发出去的是：

```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

OpenClaw 确实走了 Anthropic 的新接口格式，`thinking.type` 是 `adaptive`。但 `effort` 被显式设成了 `medium`——而不是大部分人以为的"没有传递，走 Claude 官方默认值"。

Anthropic 官方文档里写的是：*"At the default effort level (high), Claude almost always thinks。"* 也就是说，如果不传 effort，Claude 的默认行为是 `high`。但 OpenClaw 在当前版本里显式选择了 `medium`。

回到代码里看，原因很清楚。Pi agent 的 `mapThinkingLevel()` 函数里有这样一段逻辑：

```javascript
// 源码位置：src/agents/pi-embedded-runner/utils.ts
function mapThinkingLevel(level) {
  if (!level) return "off";
  if (level === "adaptive") return "medium";
  return level;
}
```

`adaptive` 被映射成了 `medium`，然后这个 `medium` 作为 effort 传给了 Anthropic。这不是 bug，而是 OpenClaw 的设计选择——但如果你不看代码或者不抓 payload，这个差异是完全不可见的。

## 继续往下：high 和 xhigh

既然 `adaptive` 的实际行为已经明确了，接下来自然要看其他档位。

`high` 在 OpenClaw 之前版本的语义里，对应的是传统的"开启思考，思考能力拉满"。那在 Claude 4.6 的新 adaptive 接口下，`high` 会变成什么？

抓 payload 确认：

- `thinkingDefault = high` → `thinking.type=adaptive` + `output_config.effort=high`
- `thinkingDefault = xhigh` → 同样是 `thinking.type=adaptive` + `output_config.effort=high`

对 Claude 4.6，`high` 和 `xhigh` 最终落到了同一个请求。

这里测 `xhigh` 有个特别的考量：`xhigh` 这个档位在 OpenAI 生态里是有独立语义的，是一个比 `high` 更高的 reasoning 档位。但在 Claude 的体系里，并没有对应的原生语义。测试它在 Claude 4.6 上会变成什么，本身就是在验证框架对"语义不存在"情况的降级逻辑。

在今天这个版本组合下，Claude 4.6 的实际行为可以归纳为：

- `adaptive` → `adaptive + medium`
- `high` → `adaptive + high`
- `xhigh` → `adaptive + high`（降级到和 high 相同）

## 回到今天的主角：GPT-5.4

看完 Claude 的行为，自然要回去看今天讨论的起点——GPT-5.4。在全局配了 `xhigh` 的情况下，它能正常使用吗？

切过去后，OpenClaw 给了一个很直接的提示：

> Thinking level set to high (xhigh not supported for xxx-provider/gpt-5.4)

`xhigh` 被自动降级成了 `high`。

但有意思的是，同一个 provider 下的 `gpt-5.3-codex-spark`，`xhigh` 却是正常支持的。

两个模型挂在同一个 provider 下面，为什么一个支持、一个不支持？

答案在 OpenClaw 的代码里。对 `xhigh` 的支持不是按 provider 来判断的，而是按**模型家族白名单**来判断的：

```javascript
// 源码位置：src/thinking.ts
const XHIGH_MODEL_REFS = [
  "openai/gpt-5.2",
  "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-5.2-codex",
  "openai-codex/gpt-5.1-codex",
  "github-copilot/gpt-5.2-codex",
  "github-copilot/gpt-5.2",
];
```

白名单里有 `gpt-5.2` 和几条 Codex 相关模型，但**没有 `gpt-5.4`**——这是一个刚发布的模型，还没来得及被加入。

所以就出现了一个很典型的多层语义现象：

- 对 Claude 4.6，`xhigh` 落到 `adaptive + high`
- 对 GPT-5.4，`xhigh` 被降级成 `high`
- 对 `gpt-5.3-codex-spark`，因为命中 Codex 家族特判，真正享受到了 `xhigh`

同一个配置项，在不同模型上，通过框架的多层判断，最终落到了三种不同的行为。

可以预见，下一个 OpenClaw 版本大概率会把 `gpt-5.4` 加入 `xhigh` allowlist——这只是白名单跟进新模型发布的节奏问题。未来 Claude 的新版本也可能会引入更多的思考类型和 effort 层级。甚至某一天，整个 thinking 抽象都可能被重新设计。

## 为什么大部分人会在这里产生误解

这件事值得写下来，不是因为它多复杂，而是因为**大部分人在这个地方的理解很可能是错的**。

OpenClaw 的文档已经写了 thinking 配置的存在和用法，但关于"配置值到底怎么映射到各个 provider 的真实请求"这一层，说得相当含糊。你能看到 `adaptive` 是 Claude 4.6 的推荐值，能看到 `xhigh` 是某些模型专属，但你看不到：

- `adaptive` 的默认 effort 到底被设成了什么
- `high` 在 Claude 上最终走的是 fixed budget 还是 adaptive + effort
- `xhigh` 对不在白名单里的模型具体怎么降级
- 整个映射过程中间经历了哪些层

这不是文档"写错了"。框架的设计意图恰恰是不让用户操心这些细节。但如果你需要精确控制 reasoning 行为——比如在多个模型之间比较成本、延迟、质量——这个抽象层就会变成一道信息壁垒。

你以为的"我把它设成了 xhigh"，实际上是"我表达了一个想要更强思考的意图，而系统在当前模型能力边界内替我找到了最接近的落点"。

## 换个角度看：这种设计其实是一种产品智慧

写到这里，可能会觉得这种多层映射是个"问题"。但换个角度想，它其实是一个深思熟虑的产品决策。

OpenClaw 面对的现实是：不同的模型 provider 有完全不同的 reasoning 接口。Anthropic 有 `thinking.type` + `output_config.effort`，OpenAI 有 `reasoning_effort`，有些模型只支持开/关，有些根本不支持 thinking。如果把这些差异全部暴露给用户，配置会变成一场噩梦——每换一个模型，你可能就要重新学一套参数。

OpenClaw 选择的是一层统一抽象：`off/minimal/low/medium/high/xhigh/adaptive`。不管底下是 Claude、GPT、Gemini 还是别的什么，你只需要表达"我要更强的思考"，框架替你完成翻译。

这本质上是一种**能力普惠**的设计哲学：

- **用户无需进行配置迁移**——切模型的时候，不用重新学一套 provider-specific 的参数体系
- **用户无需理解各家 provider 的内部接口**——你不需要知道 Anthropic 叫 `effort`、OpenAI 叫 `reasoning_effort`，统一用 `thinkingDefault` 就够了
- **对不支持的能力，自动兼容降级**——`xhigh` 在不支持的模型上不会报错，而是静默降成 `high`
- **让不理解 AI 的人也能用好**——你不需要知道什么是 adaptive thinking、什么是 budget_tokens，只需要知道"high 比 medium 思考更深"

这种设计让绝大部分用户在绝大部分场景下，完全不需要关心底层的 provider 差异。一个不了解 AI 技术细节的产品经理，和一个深入理解模型架构的工程师，面对的是同一个简单的旋钮。

但代价是：对那些需要精确控制的场景，你必须穿透这层抽象，直接去看真实 payload。这就是为什么"配置是意图，payload 才是事实"这句话重要——它不是在批评框架的设计，而是在指出抽象层的边界。

好的框架应该让大多数人省心，同时为少数人保留穿透的能力。从这次排查来看，OpenClaw 两者都做到了——只是后者不太显眼。

这也引出了一个更大的思考：在 AI Agent 系统快速演化的今天，这种"统一抽象 + 智能降级"的设计模式，可能不只是一个框架的技术选择，而是整个 AI 基础设施层面都需要面对的设计哲学——**如何在能力差异巨大的模型之间，为用户提供一致的体验？** 不同的框架会给出不同的答案，但 OpenClaw 的选择至少证明了一种可行的方向：用意图层替代参数层，让框架承担翻译的责任。

## 今天得到的不是结论，而是一套方法

我不想把这篇文章写成"OpenClaw thinking 的最终答案"。

因为只要 OpenClaw 更新一个版本，或者 Pi agent 更新一层适配，或者 provider SDK 调整一次参数命名，这里的很多细节都可能重新洗牌。

今天真正值得记住的，不是某一张映射表，而是以后遇到类似问题时，应该怎么重新推导：

1. 先看当前配置值
2. 再看框架的 thinking / capability 代码
3. 再看 allowlist 或 downgrade 逻辑
4. 最后一定抓真实 payload 做终审

如果必须把这次排查压成一句话，那大概就是：

**在 Agent 系统里，配置是意图，payload 才是事实。**

而且今天的事实，也只是今天这个版本组合下的事实。

**在快速演化的 Agent 框架里，版本本身就是语义的一部分。**

所以与其记住某个配置项的映射结果，不如记住怎么重新验证它。

---

**张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.06**
