# 目录结构

```
index.ts              插件注册：RPC handler、surface、面板、命令、时间线
paseo-plugin.json     manifest
│
├── domain/           纯逻辑，无 IO，两端共用（.shared.ts）
│   ├── domain        掌握度、项目身份、两层归因
│   ├── contracts     RPC 契约（zod）—— 前后端的唯一约定
│   ├── i18n          中英文案表
│   ├── techmap       Package → TechEntity 归并
│   ├── privacy       三级隐私 + prompt 强制过滤
│   ├── buckets       状态桶、身份色
│   └── timeline      时间线条目解析
│
├── server/           跑在插件子进程里（.server.ts）
│   ├── service       RPC handler，把下面这些接成产品
│   ├── store         状态持久化 + schema 迁移
│   ├── scanner       技术栈识别 L1~L3（确定性）
│   ├── roots         哪些目录不能当项目扫
│   ├── observe       agent 观测、还债队列、L0 快路径
│   ├── commits       commit 分析与归因
│   ├── classify      L4：agent 归类待定依赖
│   ├── generate      Wiki / 知识点 DAG / 检验题生成
│   ├── agentrun      调 Paseo agent 的封装
│   └── jobs          后台任务登记簿
│
├── ui/               跑在 Paseo 应用里（.client.tsx）
│   ├── ui            组件原语 + 语言 hook
│   ├── views         六个一级入口的内容（两个壳共用）
│   ├── main          全局界面：项目列表 → 详情
│   ├── workspace     workspace 面板壳
│   ├── agent         agent 影响面板
│   ├── review        还债：读 agent 写的代码
│   └── timeline      时间线卡片
│
└── tests/            *.test.ts
```

## ⚠️ 后缀是承重的，目录不是

Paseo 的编译器按**文件名后缀**切分前后端 bundle：

```js
onResolve({ filter: /\.(?:client|server)(?:\.[cm]?[jt]sx?)?$/ }, ...)
```

- `*.server.ts` 只进服务端 bundle，可以用 `node:*`
- `*.client.tsx` 只进客户端 bundle，跑在 Paseo 应用里
- `*.shared.ts` 两端都进 —— **所以它不能 import 任何 `node:*`**

目录名不参与判定，重命名目录是安全的；**改后缀会静默改变模块归属**。

违反边界会在编译期报错：
`client-only module cannot be imported into the plugin server bundle`

## 依赖方向

```
ui/  ─→  domain/        （只经 contracts 与 server 通信）
server/ ─→ domain/
domain/ ─→ 什么都不依赖
```

`ui/` 不许 import `server/`（会把 `node:*` 泄进前端包），`server/` 不许 import `ui/`。
两条都有编译器守着。
