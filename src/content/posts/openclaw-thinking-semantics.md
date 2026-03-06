---
title: "OpenClaw 的 thinking 设计：一次配置语义的追踪与产品思考"
published: 2026-03-06
description: "从 GPT-5.4 的 reasoning 能力聊起，顺着 OpenClaw 的 thinking 配置一路追到了真实请求体——中间经历的每一层翻译，都比想象中多。"
tags: ["OpenClaw", "Claude", "OpenAI", "AI Agent", "Reasoning", "工程实践", "产品思考"]
category: "AI 思考"
image: "./images/thinking-semantics-hero.png"
---

> 一个 `thinkingDefault` 配置项，在不同模型上，经过框架的多层翻译，最终落到了三种不同的行为。

## 起因

今天 OpenAI 发布了 GPT-5.4[^1]。我和我的 OpenClaw 助手在聊它和 Claude 4.6 的能力差异——benchmark、定价、各自的生态位。

GPT-5.4 有个引起注意的地方：它的 reasoning 处理方式跟之前的 GPT 系列不太一样。官方描述里提到，GPT-5.4 Thinking 会在回答前先给出思考计划，而且支持用户在推理过程中打断和调整方向。这和 Claude 4.6 的 adaptive thinking[^2] 走的是不同的路线——后者更侧重让模型自主判断何时需要深度思考、何时可以快速回答。

两种不同的 thinking 设计，在 OpenClaw[^3] 里最终是怎么被统一处理的？聊着聊着，这个好奇自然就冒出来了。

四天前（3 月 2 日），我刚把 OpenClaw 从 2026.2.26 升级到了 2026.3.1[^4]。这个版本正式把 Claude 4.6 的默认 thinking level 设成了 `adaptive`。升级的时候，根据 OpenClaw 新版本的支持和 Anthropic 官方的推荐，我把之前全局覆盖的 `thinkingDefault: "high"` 改成了 `adaptive`。当时没想太多——官方推荐的，框架也跟上了，按推荐配就是了。

Anthropic 的文档推荐 adaptive，OpenClaw 的 thinking 文档[^5]说已经适配了。从配置角度看，一切到位。

## 按一般理解

配完 `adaptive`，按一般理解，事情到这里就结束了。

OpenClaw 声明支持 Claude 4.6 的 adaptive thinking，那发给 Anthropic 的请求应该就是 `thinking.type = adaptive`。effort 没有额外配置，自然由 Claude 按官方默认值处理。看起来没什么好操心的。

不过 OpenClaw 的架构我还算熟悉。它不是一个简单的 API 转发层——你会注意到所有模型用的是同一套 thinking 配置：`off/minimal/low/medium/high/xhigh/adaptive`。Claude 和 GPT 的 reasoning 机制完全不同，却共用一个旋钮，这说明 OpenClaw 一定在中间做了某种兼容翻译。

而这种翻译是静默的。没有日志告诉你"adaptive 被翻译成了什么"，系统正常运行，你完全感知不到中间发生了什么。

## 去看真实请求体

跟 AI 打交道久了，有一个习惯会变得越来越本能：中间结论如果不验证到底，很可能就是幻觉。不只是模型会这样——Anthropic 在 Claude's Character 文档[^6]里承认过模型面对不确定信息时的这种倾向，OpenAI 的 GPT-4 Technical Report[^7] 也把 hallucination 列为核心局限，Huang 等人对 LLM 幻觉问题做过系统性的梳理[^8]。人读代码、读文档的时候，也会基于片段信息构建出"看起来对"的理解。

所以我们决定直接去看真实的请求体。OpenClaw 支持通过环境变量 `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` 打开 Anthropic 的 payload 日志，开启之后重启网关，跑几轮对话，然后去读日志文件就能看到框架实际发给 Anthropic 的完整请求。

![配置信号穿过多层翻译，出来时已经不是原来的颜色](./images/thinking-translation-gap.png)

验证的结果跟预期不太一样。对于 Claude 4.6，当 `thinkingDefault` 设成 `adaptive` 时，实际发出去的请求体是这样的：

```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

`thinking.type` 确实是 `adaptive`，这一点没问题。但 `effort` 被 OpenClaw 显式设成了 `medium`——而不是交给 Claude 按官方默认值处理。

Anthropic 的文档里写得很清楚：*"At the default effort level (high), Claude almost always thinks."*[^2] 也就是说，如果不传 effort 参数，Claude 的默认行为是按 `high` 来走的。但 OpenClaw 没有选择"不传"，它主动传了一个 `medium`。

更关键的是，**OpenClaw 自己的文档里完全没有提到这层映射。** 你找不到任何地方写着"adaptive 会被翻译成 effort=medium"。不去抓 payload、不去看源码，这个差异完全不可见。

回到代码里看，逻辑其实很清楚。Pi agent——OpenClaw 内置的 Agentic 核心，负责模型调度和请求组装——有一个 `mapThinkingLevel()` 函数：

```javascript
// 源码位置：src/agents/pi-embedded-runner/utils.ts
function mapThinkingLevel(level) {
  if (!level) return "off";
  if (level === "adaptive") return "medium";
  return level;
}
```

`adaptive` 在这里被映射成了 `medium`，然后这个值作为 effort 传给 Anthropic 的 API。框架做了一个明确的设计选择，只是没有在文档层面向用户说明。

## 继续看 high 和 xhigh

`adaptive` 的实际行为明确之后，接下来自然要看另外两个档位。

`high` 在之前的版本里，是 Claude 模型思维能力最大化的配置。但 Claude 4.6 引入 adaptive thinking 之后，旧的 fixed budget 方式已经不再是 Anthropic 推荐的路径了。那在 OpenClaw 当前版本里，`high` 最终会被翻译成什么样的请求？

`xhigh` 则代表了另一种情况。这个档位在 OpenAI 的体系里有独立的语义——比 `high` 更强的 reasoning 级别。但在 Claude 的 adaptive thinking 里，并没有对应的原生概念。它本质上是一个目标 provider 不存在原生语义的配置值，框架必须做某种兼容处理。

我们用同样的方法验证了这两个档位，payload log 的结果是：

- 当 `thinkingDefault` 设为 `high` 时，请求体变成了 `thinking.type=adaptive` + `output_config.effort=high`
- 当 `thinkingDefault` 设为 `xhigh` 时，请求体同样是 `thinking.type=adaptive` + `output_config.effort=high`

也就是说，在当前版本的 Claude 4.6 上，`high` 和 `xhigh` 最终落到了完全相同的请求体——`xhigh` 被静默降级到了跟 `high` 一样的行为。

把三个档位放在一起看，OpenClaw 在 Claude 4.6 上的完整翻译链路是这样的：

- `adaptive` → `adaptive + medium`（OpenClaw 主动降低了 effort）
- `high` → `adaptive + high`（走 Anthropic 的最高可用档位）
- `xhigh` → `adaptive + high`（因为 Claude 没有 xhigh 对应的语义，静默降级）

## 回到 GPT-5.4

看完 Claude 这边的行为之后，自然要回来看看今天讨论的起点——GPT-5.4。在全局配置了 `xhigh` 的情况下，GPT-5.4 能正常使用这个档位吗？

把模型切到 GPT-5.4 之后，OpenClaw 在系统消息里给出了一个提示：

> Thinking level set to high (xhigh not supported for xxx-provider/gpt-5.4)

`xhigh` 被自动降级成了 `high`。但有意思的是，同一个 provider 下面的 `gpt-5.3-codex-spark`，`xhigh` 却是正常支持的。同一个 provider、两个模型，一个可以用 `xhigh`、一个不行。

进一步看代码，发现 OpenClaw 对 `xhigh` 的支持判断并不是按 provider 来的，而是内部维护了一份模型家族的白名单：

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

GPT-5.4 今天刚发布，还没有被加入这份白名单，所以框架不认它支持 `xhigh`。

把三个模型放在一起看，同一个 `xhigh` 配置的实际命运完全不同：

- 在 Claude 4.6 上，`xhigh` 落到了 `adaptive + high`——因为 Claude 体系里没有 xhigh 的原生语义
- 在 GPT-5.4 上，`xhigh` 被降级成了 `high`——因为白名单还没有跟上新模型的发布节奏
- 在 `gpt-5.3-codex-spark` 上，`xhigh` 真正生效了——因为它在白名单里

下一个 OpenClaw 版本大概率会把 GPT-5.4 加进白名单，这只是跟进新模型发布的节奏问题。Claude 后续版本也可能会扩展 thinking 的类型和粒度。甚至整个 thinking 抽象本身，都可能在某次大版本里被重新设计。

## 这层翻译想解决什么

![多个复杂的 Provider API 面板，通过统一翻译层，汇聚成一个简单的旋钮](./images/thinking-ai-equality.png)

追到这里，技术层面的事实已经清楚了。但让我觉得更值得琢磨的是背后的设计意图：为什么 OpenClaw 要做这层看不见的翻译？

不同的模型 provider 有着完全不同的 reasoning 接口——Anthropic 用的是 `thinking.type` + `output_config.effort`，OpenAI 用的是 `reasoning_effort`，有些模型只支持思考的开和关，有些压根不支持 thinking。如果把这些差异全部暴露给用户，每换一个模型就要重新学一套参数体系，每升一次级就可能要回去改配置。

OpenClaw 选了另一条路：用一个统一的 `thinkingDefault` 旋钮覆盖所有模型，框架在中间负责完成翻译。用户不需要知道 Anthropic 管它叫 `effort`、OpenAI 管它叫 `reasoning_effort`，不需要知道什么是 adaptive thinking、什么是 budget_tokens。只需要知道"high 比 medium 思考更深"就够了。切模型的时候不用改配置，碰到不支持的档位自动降级而不是报错中断。

一个不了解 AI 技术细节的产品经理，和一个深入理解 Anthropic API 的工程师，面对的是同一个旋钮。这是一种 **AI 平权**——让不理解底层差异的人，也能用好这些能力。

代价就是我们今天追踪的这些。当你需要精确控制 reasoning 行为的时候——比如在多个模型之间比较成本、延迟和质量——这层翻译就变成了一道信息壁垒。你以为设的是 `xhigh`，实际到达模型的可能是 `high`，甚至是 `medium`。不抓 payload、不看代码，完全感知不到这个差距。

好的框架应该让大多数人省心，同时为需要的人保留穿透的能力。从这次的经验来看，OpenClaw 前者做到了，后者也没有完全堵死——payload log 可以开，源码可以看——只是这条路不太显眼。

## 更大的问题

往更大的方向想，这种"统一抽象 + 智能降级"的设计模式，也许不只是一个框架的技术选择。

在模型能力差异巨大的今天——Claude 有 adaptive thinking，GPT 有 reasoning effort，Gemini 有自己的一套——怎么在不同 provider 之间为用户提供一致的体验，是整个 AI 基础设施层面都在面对的问题。OpenClaw 的做法代表了一种方向：**用意图层替代参数层，让框架承担翻译的成本。** 用户表达的是"我想要更深的思考"，而不是"请把 `output_config.effort` 设成 `high`"。框架负责把这个意图翻译成各个 provider 能理解的具体参数。

这种设计的核心矛盾也很清楚：抽象做得越好，大多数人越不需要关心细节；但同时也让需要关心细节的人越容易被蒙蔽。这不是一个可以被一劳永逸"解决"的矛盾，更像是一个需要在产品演化过程中被持续平衡的张力。

今天这次追踪没有给出这个张力的最优解，但至少让我更清楚地看到了这层抽象的轮廓——它在哪里帮了忙，又在哪里挡了路。

---

[^1]: OpenAI. [Introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/). 2026.
[^2]: Anthropic. [Extended thinking: Adaptive thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking). 2026.
[^3]: [OpenClaw](https://github.com/openclaw/openclaw) — 开源 AI Agent 框架.
[^4]: OpenClaw. [Changelog 2026.3.1](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md) — *"Agents/Thinking defaults: set adaptive as the default thinking level for Anthropic Claude 4.6 models."*
[^5]: OpenClaw. [Thinking Documentation](https://docs.openclaw.ai/tools/thinking). 2026.
[^6]: Anthropic. [Claude's Character](https://www.anthropic.com/research/claude-character). 2024.
[^7]: OpenAI. [GPT-4 Technical Report](https://arxiv.org/abs/2303.08774). arXiv:2303.08774, 2023.
[^8]: Huang, L., Yu, W., et al. [A Survey on Hallucination in Large Language Models](https://arxiv.org/abs/2311.05232). arXiv:2311.05232, 2023.

---

**张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.06**
