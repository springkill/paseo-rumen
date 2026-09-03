# Paseo Rumen

> **agent 替你写的代码 = 你的知识债。**
> 传统工具优化「代码产出速度」，Rumen 优化「单位代码产出对应的人类知识增量」。

Rumen 是一个纯 Paseo 插件形态的本地知识层。它观察 Paseo 已经在管的 workspace 和 agent，
识别项目用了哪些技术，把「agent 改了、而你没读」的部分变成**可见的知识债**，
并给你一条把债还掉的路径。

**没有独立客户端，没有独立 daemon。** 后端跑在 Paseo 的插件子进程里，状态存在：

```text
$PASEO_HOME/plugin-data/paseo-rumen/state.json     # PASEO_HOME 默认 ~/.paseo
```

---

## 一等公民是三样东西

不是代码。代码只是产生证据（evidence）的原料。

| 实体 | 说明 | 作用域 |
|---|---|---|
| `TechEntity` | 技术栈实体（Redis、Spring Boot、Tokio…） | **全局唯一** |
| `KnowledgeNode` | 知识点，挂在 TechEntity 下，节点间有 DAG 前置关系 | **全局唯一** |
| `Mastery` | 掌握度，`(user, knowledge_node) → 0..100` | **全局，不带 project** |
| `Evidence` | 掌握度的唯一来源 | 带 project（只作为出处） |

### 掌握度不挂项目

```
✗ Mastery(user, project, knowledge_node)    ← 需要"同步"，永远会不一致
✓ Mastery(user, knowledge_node)             ← 共享是恒等式，不是功能
```

A 项目里学会 Redis 过期策略，在 B 项目里打开就是已掌握 —— 不需要任何同步代码，
因为它们读的本来就是同一行。

### 掌握度 / 置信度 / 知识债是三个量

混成一个数就什么也说不清。UI 能说「掌握度 20%，但有 5 处知识债」，
而不是含混地给个负数。

```
mastery = 100 · (1 − exp(−S / 2))     S = Σ evidence · weight · decay
```

| Evidence | 权重 | 谁产生 |
|---|---|---|
| `agent_wrote_unreviewed` | **0.0** | agent 改了证据锚点所在的文件 |
| `wiki_read` | 0.3 | 你点了「标记已读」 |
| `agent_wrote_reviewed` | 0.4 | **你展开读完 agent 写的代码并标记「我读懂了」** |
| `human_wrote` | 1.0 | 归因为人写、且符号精确命中的 commit |
| `debugged` | 1.2 | 同上，且是 fix 类 commit |
| `quiz_passed` | 1.5 | 通过检验题 |

⭐ `agent_wrote_unreviewed` 是 **0，不是负数**。agent 写了 500 行 Redis 代码而你没读，
你的掌握度应该是**没变** —— 你没有因此忘掉原本会的东西。它真正的影响是
**记一笔知识债**（单独计数）和**拉低置信度**。

---

## 核心闭环

```
agent 改文件 → 记一笔知识债，掌握度不动
     ↓
「还债」页展开读代码（只读本地文件，一个字不外发）
     ↓
标记「我读懂了」→ agent_wrote_reviewed → 掌握度上涨
```

**不展开就不给标记。** 标记的是「我读懂了」，不是「我知道有这回事」——
一个点两下就能清空的债务列表，等于没有债务列表。

---

## 功能

- **六个一级入口**：现在 / 技术栈 / 学习 / 还债 / 提交 / 设置
- **确定性技术栈识别**（L1 依赖清单 / L2 基础设施配置 / L3 代码信号），
  每条结果带 `file:line` 证据锚点，可展开「凭什么说我用了 Kafka」
- **Package → TechEntity 归并**：`ioredis` / `redis-py` / `spring-data-redis` 都是 `tech:redis`；
  未命中的包进**待归类池**，不各自成一个技术栈
- **L4 agent 归类**：批量把待归类的依赖并到概念层，学到的 alias 落库，下次确定性命中
- **Wiki + 知识点 DAG 生成**：走你在 Paseo 里配好的 provider，带来源锚定；
  Shared 层按 `(技术, 主版本, 语言)` 缓存，**跨项目零成本复用**
- **检验题**：public 项目用真实代码出题，private 降级为概念题（并明说降级原因）
- **两层 commit 归因**：确定性 trailer + 观测修正，每条判定留可审计的 signals
- **状态桶 + L0 快路径**：只有「引入了项目里没见过的依赖」才有资格打断你
- **中英双语**，完整性由类型检查保证
- **脱敏 JSONL 导出**：不含路径、项目名、代码片段

---

## 隐私

| 级别 | 允许出本机的内容 |
|---|---|
| `public` | 代码片段可作为 prompt 上下文；可抓上游文档 |
| `private`（默认） | **仅**技术栈名、依赖名、抽象化的问题描述 |
| `airgapped` | 无。完全不调 agent，只有确定性检测 |

- `.env` / `.env.*` **一个字都不读**
- 非 public 项目组装 prompt 时走**强制过滤**（`assertNoProjectLeak`）：
  检出绝对路径或代码正文就抛错，宁可这次生成失败。有单测守着
- 观测只存文件路径，不存 prompt、输出、patch、old/new string 或 shell 命令
- 导出把项目身份哈希掉

### 一条真实盲区

**走 shell 的改动看不见。** agent 通过 `sed -i`、`cat > file`、重定向做的改动记不到，
这类只能退回 commit 分析。文件工具（Edit/Write）覆盖了绝大多数真实场景，
但这个盲区确实存在，不该假装没有。

**观测只在 Paseo 开着的时候进行。** 关掉期间的改动最终会落进 commit，被 commit 分析兜住。

---

## 界面语言 ≠ 内容语言

两件事，机制完全不同，混起来必然做错：

| | 界面语言 | 内容语言 |
|---|---|---|
| 是什么 | 标签、按钮、错误消息 | wiki 正文、知识点标题、检验题题面 |
| 谁产生 | 写死在 catalog 里 | agent 生成 |
| 怎么切 | 查表，**零成本** | 每种语言各生成一遍，**要花钱** |
| 存在哪 | `i18n.shared.ts` | 存储里的 `lang` 维度 |

**推论：界面是中文而某篇 Wiki 只有英文，是预期行为，不是 bug。**

判定优先级（服务端唯一裁决）：

```
RUMEN_LANG > 设置页上的选择 > 客户端语言 > 宿主机 LC_ALL/LC_MESSAGES/LANG > en
```

用户的显式选择压过环境推断 —— `LANG` 是环境在*告诉*我们这台机器习惯什么语言，
那是推断；设置页上点出来的是*决定*。客户端语言排在宿主机之前，
因为 Paseo 可以从手机或浏览器访问，看界面的人和跑 daemon 的机器不是同一个。

**掌握度挂在跨语言的 `groupId` 上**，换语言重新生成内容不会丢学习记录。

---

## 开发

```bash
npm install
npm run typecheck
npm test

paseo plugin install /absolute/path/to/paseo-rumen
paseo plugin reload paseo-rumen      # 改完源码只 reload，不重启 Paseo
paseo plugin logs paseo-rumen
```

不修改 Paseo 源码。

### 状态迁移

v1 → v2 会**丢弃 v1 的技术栈和知识点数据**，只保留项目身份与隐私级别，
并把原文件另存为 `state.json.v1-<timestamp>`。

原因：v1 让每个未命中的包各自成一个 TechEntity，实测一个 workspace 扫出
**2293 个「技术栈」、6945 个知识点、7.8MB 状态文件**；挂在这些伪知识点上的证据
指向的东西根本不存在。迁移过来等于把坏数据带进新 schema。迁移后重扫即可。

---

<details>
<summary><b>English</b></summary>

## Paseo Rumen

> **Code your agent wrote for you is knowledge debt.**
> Other tools optimize code output per unit time. Rumen optimizes human understanding
> per unit of code output.

A local-first knowledge layer implemented entirely as a Paseo plugin — no standalone
client, no standalone daemon. It watches the workspaces and agents Paseo already manages,
detects the technologies a project uses, turns unreviewed agent changes into visible
knowledge debt, and gives you a path to pay that debt down.

### The core loop

```
agent edits a file  →  knowledge debt recorded, mastery unchanged
      ↓
open "Review", expand and read the code (read locally, nothing leaves the machine)
      ↓
mark "I understood this"  →  agent_wrote_reviewed evidence  →  mastery rises
```

You cannot mark something reviewed without expanding it. The mark means *you understood
it*, not *you noticed it* — a debt list you can clear with two clicks is not a debt list.

### Three separate quantities

Mastery, confidence, and knowledge debt are **three numbers**, never merged into one.
The UI can say "mastery 20%, but 5 items of knowledge debt"; a single signed number
could not.

`agent_wrote_unreviewed` carries weight **0.0, not negative** — an agent writing 500 lines
of Redis you never read leaves your Redis mastery *unchanged*. Its real effects are a debt
entry and lowered confidence.

### Mastery is not scoped to a project

`Mastery(user, knowledge_node)` — not `(user, project, knowledge_node)`. Learning Redis
expiry in project A means it is already learned when you open project B. Sharing is an
identity, not a feature.

### Privacy

`public` allows code snippets as prompt context. `private` (the default) sends **only**
technology and dependency names. `airgapped` calls no agent at all. `.env` files are never
read. For non-public projects, prompt assembly runs a hard filter that throws on absolute
paths or code bodies — covered by tests.

Known blind spot: changes made through the shell (`sed -i`, redirects) are invisible to
observation and fall back to commit analysis. Observation also only runs while Paseo is open.

### Interface language ≠ content language

The interface catalog is bilingual (zh/en) and costs nothing to switch. Generated content
carries a `lang` dimension and costs one agent run per language. **An English Wiki under a
Chinese interface is expected behaviour, not a bug.** Mastery hangs on a cross-language
`groupId`, so switching languages never loses your learning record.

Resolution order: `RUMEN_LANG` > saved setting > client locale > host `LC_ALL`/`LC_MESSAGES`/`LANG` > `en`.

</details>
