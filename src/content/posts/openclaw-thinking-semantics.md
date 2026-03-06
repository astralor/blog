---
title: "OpenClaw 的 thinking 设计：一次配置语义的追踪与产品思考"
published: 2026-03-06
description: "从 GPT-5.4 的 reasoning 能力聊起，顺着 OpenClaw 的 thinking 配置一路追到了 Anthropic 的真实请求体——中间经历的每一层翻译，都比想象中多。"
tags: ["OpenClaw", "Claude", "OpenAI", "AI Agent", "Reasoning", "工程实践", "产品思考"]
category: "AI 思考"
image: ""
---

> 一个 `thinkingDefault` 配置项，在不同模型上，通过框架的多层翻译，最终落到了三种不同的行为。而这种设计背后，藏着一个值得琢磨的产品选择。

## 起因：GPT-5.4 的 reasoning

今天 OpenAI [发布了 GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)。我和我的 OpenClaw 助手在聊它和 Claude 4.6 的能力差异——benchmark、定价、生态位。

GPT-5.4 有个引起注意的地方：它在 reasoning 上的处理方式跟之前的 GPT 系列不太一样。官方描述里提到，GPT-5.4 Thinking 会在回答前先给出思考计划，而且支持在推理过程中被用户打断和调整方向[^1]。这和 Claude 4.6 的 [adaptive thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking) 走的是不同的路线——后者更侧重让模型自主决定何时需要深度思考、何时可以快速回答。

两种不同的 thinking 设计，在 [OpenClaw](https://github.com/openclaw/openclaw) 里最终是怎么被统一处理的？

这不是一个刻意提出的问题，更像是聊着聊着自然冒出来的好奇。因为就在四天前（3 月 2 日），我刚把 OpenClaw 从 2026.2.26 升级到 [2026.3.1](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)，这个版本把 Claude 4.6 的默认 thinking level 设成了 `adaptive`[^2]。升级时我顺手移除了之前全局覆盖的 `thinkingDefault: "high"`，让配置回到 Claude 4.6 官方推荐的最佳实践。

Anthropic 的文档推荐 adaptive，OpenClaw 的 [thinking 文档](https://docs.openclaw.ai/tools/thinking) 也明确说已经适配了这个模式。从配置角度看，一切都已经就位。

## 直觉上的理解

如果你用过 OpenClaw 或者类似的 Agent 框架，大概会觉得事情到这里就结束了：

- `thinkingDefault` 设成 `adaptive`
- OpenClaw 说支持 Claude 4.6 的 adaptive
- 那发给 Anthropic 的请求就是 `thinking.type = adaptive`
- effort 没有额外配置，自然走 Claude 的官方默认值

很合理的推理。

不过，OpenClaw 的架构我还算熟悉。它不是一个简单的 API 转发层——所有模型用的是同一套统一的 thinking 配置（`off/minimal/low/medium/high/xhigh/adaptive`），这意味着框架一定在中间做了某种兼容翻译。而且这种翻译是静默的——没有报错，没有告警，你感知不到中间发生了什么。

所以真正的问题是：这层翻译具体做了什么？

## 追到底

跟 AI 打交道久了，有一个经验会变得越来越本能：**中间结论如果不验证到底，极有可能是幻觉。**

Anthropic 在 [Claude's Character](https://www.anthropic.com/research/claude-character) 文档里承认过，模型在面对不确定信息时会倾向于给出看起来合理但未经验证的回答。OpenAI 的 [GPT-4 Technical Report](https://arxiv.org/abs/2303.08774) 也把 hallucination 列为核心局限。Huang 等人在 [A Survey on Hallucination in Large Language Models](https://arxiv.org/abs/2311.05232) 里更系统地梳理过这个问题。不只是模型会幻觉——人读代码、读文档，也会基于片段信息构建出"看起来对"的理解。

所以我们打开了 Anthropic 的 payload log（环境变量 `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1`），重启网关，直接去看真实请求体。

对于 Claude 4.6，当 `thinkingDefault` 设成 `adaptive` 时，实际发出去的是：

```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

`thinking.type` 确实是 `adaptive`。但 `effort` 被显式设成了 `medium`。

这跟直觉上的理解不一样。Anthropic 的文档写的是：*"At the default effort level (high), Claude almost always thinks."*[^3] 也就是说，如果不传 effort，Claude 的默认行为是 `high`。但 OpenClaw 并没有"不传"——它显式传了 `medium`。

回到代码里看，逻辑很清楚。Pi agent（OpenClaw 内置的 Agentic 核心，负责模型调度和请求组装）有一个 `mapThinkingLevel()` 函数：

```javascript
// 源码位置：src/agents/pi-embedded-runner/utils.ts
function mapThinkingLevel(level) {
  if (!level) return "off";
  if (level === "adaptive") return "medium";
  return level;
}
```

`adaptive` 被映射成了 `medium`，然后这个值作为 effort 传给了 Anthropic 的 API。

## high 和 xhigh 呢

既然 `adaptive` 的行为明确了，接下来想看的是：`high` 在当前版本里会怎么处理？

在 OpenClaw 2026.3.1 之前，`high` 的语义比较直白——开启思考能力，拉到最高。但 Claude 4.6 引入了 adaptive 接口之后，旧的 fixed budget 方式已经不再是推荐路径。那 OpenClaw 会把 `high` 翻译成什么？

还是用 payload log 看：

- `thinkingDefault = high` → `thinking.type=adaptive` + `output_config.effort=high`
- `thinkingDefault = xhigh` → `thinking.type=adaptive` + `output_config.effort=high`

`high` 和 `xhigh` 在 Claude 4.6 上落到了同一个请求。

这里 `xhigh` 值得单独说一下。这个档位在 OpenAI 的体系里是有独立语义的——比 `high` 更高的 reasoning 级别。但在 Claude 的 adaptive thinking 里，没有对应的原生概念。测它在 Claude 上的表现，本质上是在看框架遇到"目标 provider 不存在这个语义"时会怎么降级。

结果是：静默降到最高可用档。

在今天这个版本下，Claude 4.6 的完整映射：

- `adaptive` → `adaptive + medium`
- `high` → `adaptive + high`
- `xhigh` → `adaptive + high`（静默降级）

## 回到 GPT-5.4

看完 Claude，自然要回来看今天的主角。GPT-5.4 在全局 `xhigh` 配置下能正常使用吗？

切过去，OpenClaw 给了个提示：

> Thinking level set to high (xhigh not supported for xxx-provider/gpt-5.4)

被降成了 `high`。但同一个 provider 下的 `gpt-5.3-codex-spark`，`xhigh` 却正常。

为什么？不是按 provider 判断的，而是按模型家族白名单：

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

GPT-5.4 今天刚发布，还没来得及被加入白名单。

所以同一个 `xhigh` 配置，在三个模型上的实际行为：

- Claude 4.6 → `adaptive + high`
- GPT-5.4 → 降级为 `high`
- `gpt-5.3-codex-spark` → 真正的 `xhigh`

下一个 OpenClaw 版本大概率会把 GPT-5.4 加进去——白名单跟进新模型发布，节奏上就是这样。Claude 后续版本也可能会扩展 thinking 的类型和粒度。甚至整个 thinking 抽象本身，都可能在某次大版本里被重新设计。

## 这层翻译想解决什么

到这里为止是追踪。接下来想聊的是：为什么 OpenClaw 要做这层看不见的翻译？

不同的模型 provider 有完全不同的 reasoning 接口——Anthropic 是 `thinking.type` + `output_config.effort`，OpenAI 是 `reasoning_effort`，有些模型只支持开/关，有些压根不支持 thinking。如果把这些差异全部暴露给用户，每换一个模型就要重新学一套参数，每升一次级就可能要改配置。

OpenClaw 选了另一条路：用一个统一的 `thinkingDefault`（`off/minimal/low/medium/high/xhigh/adaptive`）覆盖所有模型，框架负责翻译。

用户不需要知道 Anthropic 叫 `effort`、OpenAI 叫 `reasoning_effort`。不需要知道什么是 adaptive thinking、什么是 budget_tokens。只需要知道"high 比 medium 思考更深"。切模型的时候不用改配置，不支持的档位自动降级而不是报错。

这让我想到一个词：**能力普惠**。

一个不了解 AI 技术细节的产品经理，和一个深入理解 Anthropic API 的工程师，面对的是同一个旋钮。绝大部分场景下，这个旋钮够用了。框架把 provider 差异的复杂度吃掉了，用户只需要表达意图。

代价当然有——就是我们今天追踪的这些。当你需要精确控制时，这层翻译就变成了一道信息壁垒。你以为设的是 `xhigh`，实际可能是 `high`，甚至是 `medium`。不抓 payload 不看代码，完全感知不到。

好的框架应该让大多数人省心，同时为需要的人保留穿透的能力。从这次的经验看，OpenClaw 前者做到了，后者也没有堵死（payload log 可以抓，源码可以看），只是不太显眼。

往更大的方向想，这种"统一抽象 + 智能降级"的模式，也许不只是 OpenClaw 的技术选择。在模型能力差异巨大的今天，怎么在不同 provider 之间为用户提供一致的体验，是整个 AI 基础设施层面都要面对的问题。OpenClaw 的做法是一种可能的方向：**用意图层替代参数层，让框架承担翻译的成本。**

## 方法比结论重要

这篇文章里的映射关系，大概率会在下一次 OpenClaw 更新后失效。

今天真正值得留下的，是以后遇到类似问题时的验证路径：

1. 看当前配置值
2. 看框架的 thinking / capability 代码
3. 看 allowlist 和 downgrade 逻辑
4. 抓真实 payload 做终审

在快速演化的 Agent 框架里，版本本身就是语义的一部分。与其记住某个配置项今天的映射结果，不如记住怎么重新验证它。

---

[^1]: [Introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/) — *"GPT-5.4 Thinking can now provide an upfront plan of its thinking, so you can adjust course mid-response while it's working."*
[^2]: [OpenClaw 2026.3.1 Changelog](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md) — *"Agents/Thinking defaults: set adaptive as the default thinking level for Anthropic Claude 4.6 models."*
[^3]: [Anthropic Adaptive Thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking) — *"At the default effort level (high), Claude almost always thinks."*

---

**张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.06**
