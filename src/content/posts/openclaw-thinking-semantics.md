---
title: "OpenClaw 的 thinking 设计：一次配置语义的追踪与产品思考"
published: 2026-03-06
description: "从 GPT-5.4 的 reasoning 能力聊起，顺着 OpenClaw 的 thinking 配置一路追到了真实请求体——中间经历的每一层翻译，都比想象中多。"
tags: ["OpenClaw", "Claude", "OpenAI", "AI Agent", "Reasoning", "工程实践", "产品思考"]
category: "AI 思考"
image: ""
---

> 一个 `thinkingDefault` 配置项，在不同模型上，经过框架的多层翻译，最终落到了三种不同的行为。

## 起因

今天 OpenAI [发布了 GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)。我和我的 OpenClaw 助手在聊它和 Claude 4.6 的能力差异——benchmark、定价、各自的生态位。

GPT-5.4 有个有意思的地方：它的 reasoning 处理方式跟之前的 GPT 系列不太一样。官方提到 GPT-5.4 Thinking 会在回答前先给出思考计划，而且支持用户在推理过程中打断和调整方向[^1]。这和 Claude 4.6 的 [adaptive thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking) 走的是不同的路线——后者更侧重让模型自主判断何时需要深度思考、何时快速回答。

两种不同的 thinking 设计，在 [OpenClaw](https://github.com/openclaw/openclaw) 里最终是怎么被统一处理的？聊着聊着，这个好奇自然就冒出来了。

四天前（3 月 2 日），我刚把 OpenClaw 从 2026.2.26 升级到了 [2026.3.1](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)。这个版本正式把 Claude 4.6 的默认 thinking level 设成了 `adaptive`[^2]。升级的时候，根据 OpenClaw 新版本的支持和 Anthropic 官方的推荐，我把之前全局覆盖的 `thinkingDefault: "high"` 改成了 `adaptive`。当时没想太多——官方推荐的，框架也跟上了，按推荐配就是了。

Anthropic 的文档推荐 adaptive，OpenClaw 的 [thinking 文档](https://docs.openclaw.ai/tools/thinking) 说已经适配了。从配置角度看，一切到位。

## 按一般理解

配完 `adaptive`，按一般理解，事情到这里就结束了。

OpenClaw 声明支持 Claude 4.6 的 adaptive thinking，那发给 Anthropic 的请求应该就是 `thinking.type = adaptive`。effort 没有额外配置，自然由 Claude 按官方默认值处理。

看起来没什么好操心的。

但 OpenClaw 的架构我还算熟悉。它不是一个简单的 API 转发层——你会注意到所有模型用的是同一套 thinking 配置：`off/minimal/low/medium/high/xhigh/adaptive`。Claude 和 GPT 的 reasoning 机制完全不同，却共用一个旋钮。这说明框架一定在中间做了某种翻译。

而这种翻译是静默的。没有日志告诉你"我帮你把 adaptive 翻译成了 xxx"。你感知不到中间发生了什么。

## 追下去看

跟 AI 打交道久了，有一个习惯会变得越来越本能：**中间结论不验证到底，很可能就是幻觉。**

Anthropic 在 [Claude's Character](https://www.anthropic.com/research/claude-character) 文档里承认过，模型面对不确定信息时倾向于给出看起来合理但未经验证的回答。OpenAI 的 [GPT-4 Technical Report](https://arxiv.org/abs/2303.08774) 也把 hallucination 列为核心局限。Huang 等人在 [A Survey on Hallucination in Large Language Models](https://arxiv.org/abs/2311.05232) 里系统梳理过这个问题。不只是模型会幻觉——人读代码、读文档，也会基于片段信息构建出"看起来对"的理解。

所以我们直接去看真实请求体。

OpenClaw 支持通过环境变量 `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` 打开 Anthropic 的 payload 日志。开了之后重启网关，跑几轮对话，然后去读日志文件。

实际验证的结果是——对于 Claude 4.6，当 `thinkingDefault` 设成 `adaptive` 时，发出去的请求体长这样：

```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

`thinking.type` 确实是 `adaptive`。但 `effort` 被显式设成了 `medium`。

这跟前面"自然走 Claude 官方默认值"的理解不一样。Anthropic 的文档写的是：*"At the default effort level (high), Claude almost always thinks."*[^3] 如果不传 effort，Claude 的默认行为是 `high`。但 OpenClaw 传了——而且传的是 `medium`。

关键是，**OpenClaw 的文档里完全没有提到这层映射。** 你找不到任何地方写着"adaptive 会被翻译成 effort=medium"。如果不去抓 payload，不去看源码，这个差异完全不可见。

回到代码里，逻辑很清楚。Pi agent（OpenClaw 内置的 Agentic 核心，负责模型调度和请求组装）有一个 `mapThinkingLevel()` 函数：

```javascript
// 源码位置：src/agents/pi-embedded-runner/utils.ts
function mapThinkingLevel(level) {
  if (!level) return "off";
  if (level === "adaptive") return "medium";
  return level;
}
```

`adaptive` 被映射成了 `medium`，这个值再作为 effort 传给 Anthropic API。

## high 和 xhigh

`adaptive` 的实际行为明确了，接下来自然要看另外两个档位。

`high` 在 OpenClaw 之前版本里的语义比较直白——开启思考，能力拉满。到了 Claude 4.6 引入 adaptive 之后，旧的 fixed budget 已经不是推荐路径了。那 `high` 在新版本里最终变成什么？

`xhigh` 更有意思。这个档位在 OpenAI 的体系里是有独立语义的——比 `high` 更强的 reasoning 级别。但 Claude 的 adaptive thinking 里没有对应的概念。它代表的是一个在当前 provider 不存在原生语义的配置值，框架必须做某种兼容处理。

一起测了。还是用 payload log，结果很干脆：

- `high` → `thinking.type=adaptive` + `output_config.effort=high`
- `xhigh` → `thinking.type=adaptive` + `output_config.effort=high`

在 Claude 4.6 上，`high` 和 `xhigh` 落到了同一个请求。`xhigh` 被静默降级到了 `high`。

完整的映射：

- `adaptive` → `adaptive + medium`
- `high` → `adaptive + high`
- `xhigh` → `adaptive + high`（静默降级）

## 回到 GPT-5.4

看完 Claude 的行为，自然要回来看今天的主角。GPT-5.4 在全局 `xhigh` 配置下能正常使用吗？

切过去，OpenClaw 给了个提示：

> Thinking level set to high (xhigh not supported for xxx-provider/gpt-5.4)

降成了 `high`。

但同一个 provider 下的 `gpt-5.3-codex-spark`，`xhigh` 是正常的。同一个 provider，两个模型，一个支持一个不支持。

翻了代码，原因是 OpenClaw 的 `xhigh` 支持不是按 provider 判断的，而是维护了一份模型家族白名单：

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

GPT-5.4 今天刚发布，还没有被加进去。

所以同一个 `xhigh` 配置，三个模型，三种结果：

- Claude 4.6 → `adaptive + high`
- GPT-5.4 → 降级为 `high`
- `gpt-5.3-codex-spark` → 真正的 `xhigh`

下一个 OpenClaw 版本大概率会把 GPT-5.4 加进白名单——节奏上就是这样。Claude 后续版本可能会扩展 thinking 的类型和粒度。甚至整个 thinking 抽象本身，都可能在某次大版本里被重新设计。

## 这层翻译想解决什么

追到这里，技术事实已经清楚了。但让我觉得更值得琢磨的是：为什么 OpenClaw 要做这层看不见的翻译？

不同的模型 provider 有完全不同的 reasoning 接口——Anthropic 是 `thinking.type` + `output_config.effort`，OpenAI 是 `reasoning_effort`，有些模型只支持开/关，有些压根不支持 thinking。如果把这些差异全部暴露给用户，每换一个模型就要重新学一套参数，每升一次级就可能要改配置。

OpenClaw 选了另一条路：一个统一的旋钮 `thinkingDefault`，覆盖所有模型，框架在中间负责翻译。

用户不需要知道 Anthropic 叫 `effort`、OpenAI 叫 `reasoning_effort`。不需要知道什么是 adaptive thinking、什么是 budget_tokens。只需要知道"high 比 medium 思考更深"。切模型不用改配置，不支持的档位自动降级而不是报错。

一个不了解 AI 技术细节的产品经理，和一个深入理解 Anthropic API 的工程师，面对的是同一个旋钮。

这是一种 **AI 平权**。让不理解底层差异的人，也能用好这些能力。

代价就是我们今天追踪的这些——当你需要精确控制时，这层翻译变成了信息壁垒。你以为设的是 `xhigh`，实际可能是 `high`，甚至是 `medium`。不抓 payload 不看代码，完全感知不到。

好的框架应该让大多数人省心，同时为需要的人保留穿透的能力。OpenClaw 前者做到了，后者也没有堵死——payload log 可以开，源码可以看——只是不太显眼。

## 更大的问题

往更大的方向想，这种"统一抽象 + 智能降级"的设计，也许不只是一个框架的技术选择。

在模型能力差异巨大的今天——Claude 有 adaptive thinking，GPT 有 reasoning effort，Gemini 有自己的一套——怎么在不同 provider 之间为用户提供一致的体验，是整个 AI 基础设施层面都在面对的问题。

OpenClaw 的做法是一种方向：**用意图层替代参数层，让框架承担翻译的成本。** 用户表达的是"我想要更深的思考"，不是"请把 `output_config.effort` 设成 `high`"。框架把意图翻译成各个 provider 能理解的具体参数。

这种设计的核心矛盾也很清楚：**抽象做得越好，大多数人越不需要关心细节；但也让需要关心细节的人越容易被蒙蔽。** 这不是一个可以被"解决"的矛盾——更像是一个需要被持续平衡的张力。

今天的追踪没有给出这个张力的最优解。但至少让我更清楚地看到了这层抽象的形状：它在哪里帮了忙，又在哪里挡了路。

---

[^1]: [Introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/) — *"GPT-5.4 Thinking can now provide an upfront plan of its thinking, so you can adjust course mid-response while it's working."*
[^2]: [OpenClaw 2026.3.1 Changelog](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md) — *"Agents/Thinking defaults: set adaptive as the default thinking level for Anthropic Claude 4.6 models."*
[^3]: [Anthropic Adaptive Thinking](https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking) — *"At the default effort level (high), Claude almost always thinks."*

---

**张昊辰 (Astralor) & 霄晗 (🌸) · 2026.03.06**
