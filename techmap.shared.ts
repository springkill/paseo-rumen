/**
 * Package → TechEntity 的归并层。
 *
 * ## 为什么必须有这一层
 *
 * 「A 项目的 Redis == B 项目的 Redis」这件事必须是**标识层天然成立**，
 * 而不是靠后期同步：
 *
 * ```
 * Package  →  pkg:npm/ioredis@5.4.1
 *             pkg:pypi/redis@5.0.1
 *             pkg:maven/org.springframework.data/spring-data-redis@3.2.0
 *               ↓  alias 表（确定性规则 + agent 兜底 + 学到就落库）
 * TechEntity →  tech:redis        （概念层，语言无关）
 * ```
 *
 * `Package` 层解决"精确版本、精确依赖"，`TechEntity` 层解决"跨语言跨项目是同一个东西"。
 *
 * ⚠️ **没有这一层会发生什么，是实测出来的**：早先的实现让每个未命中的包各自成一个
 * TechEntity，于是一个 workspace 扫出 **2293 个「技术栈」、6945 个知识点**，
 * state 文件涨到 7.8MB。技术栈列表变成依赖清单的另一种排版，
 * 而依赖清单 `cat package.json` 就能看，不需要一个产品。
 *
 * 所以未命中的包**不是** TechEntity，它进待归类池（{@link PendingPackage}），
 * 等 L4 归类把它并到概念层，或者判定它不值得学。
 */

export type TechCategory =
  | "language"
  | "framework"
  | "datastore"
  | "messaging"
  | "infra"
  | "build"
  | "test"
  | "observability"
  | "security"
  | "library"
  | "unknown";

export const TECH_CATEGORIES: readonly TechCategory[] = [
  "language",
  "framework",
  "datastore",
  "messaging",
  "infra",
  "build",
  "test",
  "observability",
  "security",
  "library",
  "unknown",
];

export function isTechCategory(value: string): value is TechCategory {
  return (TECH_CATEGORIES as readonly string[]).includes(value);
}

export interface TechDef {
  /** 概念层 id，永远是 `tech:<slug>`。跨生态共享。 */
  readonly id: string;
  readonly name: string;
  readonly category: TechCategory;
  /**
   * 值不值得当成知识点来学。
   *
   * `false` 的不是"不重要"，是"学它的边际知识增量低" —— 格式化器、类型桩、
   * lint 插件这类。它们仍然被检出、仍然显示，只是不进学习路径、不产生知识债。
   */
  readonly worthLearning: boolean;
  /** 各生态里的包名。前缀式（`@scope` / `com.example`）会按前缀匹配。 */
  readonly aliases: readonly string[];
}

function def(
  slug: string,
  name: string,
  category: TechCategory,
  worthLearning: boolean,
  aliases: readonly string[],
): TechDef {
  return { id: `tech:${slug}`, name, category, worthLearning, aliases };
}

/**
 * 内置的确定性 alias 表。
 *
 * 覆盖不了的走 L4 归类，学到的落库（{@link LearnedAlias}），下次就是确定性命中。
 * 这张表只放**跨项目反复出现、且归类无争议**的条目 —— 它不需要穷尽，
 * 穷尽是 L4 的活。
 */
export const TECH_DEFS: readonly TechDef[] = [
  // ── 语言与运行时 ──────────────────────────────────────────────
  def("typescript", "TypeScript", "language", true, ["typescript", "ts-node", "tsx"]),
  def("node", "Node.js", "language", true, ["@types/node", "node"]),
  def("python", "Python", "language", true, ["python"]),
  def("rust", "Rust", "language", true, ["rust"]),
  def("go", "Go", "language", true, ["golang"]),
  def("kotlin", "Kotlin", "language", true, ["kotlin", "org.jetbrains.kotlin"]),

  // ── 前端框架 ──────────────────────────────────────────────────
  def("react", "React", "framework", true, ["react", "react-dom", "@types/react", "@types/react-dom"]),
  def("react-native", "React Native", "framework", true, ["react-native", "expo", "@expo", "@react-native"]),
  def("nextjs", "Next.js", "framework", true, ["next"]),
  def("vue", "Vue", "framework", true, ["vue", "nuxt", "@vue"]),
  def("angular", "Angular", "framework", true, ["@angular"]),
  def("svelte", "Svelte", "framework", true, ["svelte", "@sveltejs"]),
  def("solid", "SolidJS", "framework", true, ["solid-js"]),
  def("tailwind", "Tailwind CSS", "framework", true, ["tailwindcss", "@tailwindcss"]),
  def("tanstack-query", "TanStack Query", "library", true, ["@tanstack/react-query", "@tanstack/query-core", "@tanstack/vue-query"]),
  def("redux", "Redux", "library", true, ["redux", "@reduxjs/toolkit", "react-redux"]),
  def("zustand", "Zustand", "library", true, ["zustand"]),

  // ── 后端框架 ──────────────────────────────────────────────────
  def("express", "Express", "framework", true, ["express"]),
  def("fastify", "Fastify", "framework", true, ["fastify", "@fastify"]),
  def("nestjs", "NestJS", "framework", true, ["@nestjs"]),
  def("hono", "Hono", "framework", true, ["hono", "@hono"]),
  def("fastapi", "FastAPI", "framework", true, ["fastapi"]),
  def("django", "Django", "framework", true, ["django", "djangorestframework"]),
  def("flask", "Flask", "framework", true, ["flask"]),
  def("spring-boot", "Spring Boot", "framework", true, ["spring-boot", "org.springframework.boot", "org.springframework"]),
  def("axum", "Axum", "framework", true, ["axum"]),
  def("actix", "Actix Web", "framework", true, ["actix-web"]),
  def("gin", "Gin", "framework", true, ["github.com/gin-gonic/gin"]),
  def("echo", "Echo", "framework", true, ["github.com/labstack/echo"]),
  def("rails", "Ruby on Rails", "framework", true, ["rails", "actionpack", "activerecord"]),
  def("laravel", "Laravel", "framework", true, ["laravel/framework", "illuminate"]),
  def("symfony", "Symfony", "framework", true, ["symfony"]),

  // ── 异步运行时与并发 ──────────────────────────────────────────
  def("tokio", "Tokio", "framework", true, ["tokio", "tokio-util", "tokio-stream"]),
  def("asyncio", "asyncio", "library", true, ["asyncio", "anyio", "trio"]),

  // ── 数据存储 ──────────────────────────────────────────────────
  def("postgresql", "PostgreSQL", "datastore", true, ["pg", "postgres", "postgresql", "psycopg", "psycopg2", "psycopg2-binary", "asyncpg", "tokio-postgres", "sqlx-postgres", "org.postgresql"]),
  def("mysql", "MySQL", "datastore", true, ["mysql", "mysql2", "pymysql", "mysqlclient", "com.mysql", "mysql-connector-java"]),
  def("sqlite", "SQLite", "datastore", true, ["sqlite", "sqlite3", "better-sqlite3", "rusqlite", "aiosqlite"]),
  def("redis", "Redis", "datastore", true, ["redis", "ioredis", "redis-py", "aioredis", "hiredis", "spring-data-redis", "lettuce-core", "jedis"]),
  def("mongodb", "MongoDB", "datastore", true, ["mongodb", "mongoose", "pymongo", "motor"]),
  def("elasticsearch", "Elasticsearch", "datastore", true, ["elasticsearch", "@elastic/elasticsearch", "opensearch"]),
  def("clickhouse", "ClickHouse", "datastore", true, ["clickhouse", "clickhouse-driver", "@clickhouse/client"]),
  def("duckdb", "DuckDB", "datastore", true, ["duckdb"]),
  def("prisma", "Prisma", "datastore", true, ["prisma", "@prisma/client"]),
  def("drizzle", "Drizzle ORM", "datastore", true, ["drizzle-orm", "drizzle-kit"]),
  def("sqlalchemy", "SQLAlchemy", "datastore", true, ["sqlalchemy", "alembic"]),
  def("typeorm", "TypeORM", "datastore", true, ["typeorm"]),
  def("mybatis", "MyBatis", "datastore", true, ["mybatis", "org.mybatis"]),
  def("sqlx", "SQLx", "datastore", true, ["sqlx"]),
  def("diesel", "Diesel", "datastore", true, ["diesel"]),
  def("gorm", "GORM", "datastore", true, ["gorm.io/gorm"]),

  // ── 消息与 API ────────────────────────────────────────────────
  def("graphql", "GraphQL", "messaging", true, ["graphql", "apollo-server", "@apollo", "graphene", "strawberry-graphql", "async-graphql"]),
  def("grpc", "gRPC", "messaging", true, ["grpc", "@grpc", "grpcio", "tonic", "google.golang.org/grpc"]),
  def("kafka", "Kafka", "messaging", true, ["kafkajs", "kafka-python", "confluent-kafka", "rdkafka", "spring-kafka", "org.apache.kafka"]),
  def("rabbitmq", "RabbitMQ", "messaging", true, ["amqplib", "pika", "lapin", "amqp"]),
  def("nats", "NATS", "messaging", true, ["nats", "nats.py", "async-nats"]),
  def("websocket", "WebSocket", "messaging", true, ["ws", "websockets", "socket.io", "tokio-tungstenite", "tungstenite"]),
  def("mqtt", "MQTT", "messaging", true, ["mqtt", "paho-mqtt", "rumqttc"]),

  // ── 基础设施 ──────────────────────────────────────────────────
  def("docker", "Docker", "infra", true, ["docker", "docker-compose"]),
  def("kubernetes", "Kubernetes", "infra", true, ["kubernetes", "k8s", "@kubernetes/client-node", "kubernetes-client"]),
  def("terraform", "Terraform", "infra", true, ["terraform"]),
  def("github-actions", "GitHub Actions", "infra", false, ["github-actions"]),
  def("aws", "AWS", "infra", true, ["aws-sdk", "@aws-sdk", "boto3", "botocore", "aws-cdk", "software.amazon.awssdk"]),
  def("gcp", "Google Cloud", "infra", true, ["@google-cloud", "google-cloud", "google-cloud-storage"]),
  def("azure", "Azure", "infra", true, ["@azure", "azure-identity", "azure-storage-blob"]),
  def("nginx", "Nginx", "infra", true, ["nginx"]),

  // ── 构建与打包 ────────────────────────────────────────────────
  def("vite", "Vite", "build", true, ["vite", "@vitejs"]),
  def("webpack", "Webpack", "build", true, ["webpack", "webpack-cli"]),
  def("esbuild", "esbuild", "build", true, ["esbuild"]),
  def("rollup", "Rollup", "build", true, ["rollup", "@rollup"]),
  def("babel", "Babel", "build", false, ["@babel", "babel-core"]),
  def("gradle", "Gradle", "build", true, ["gradle", "org.gradle"]),
  def("maven", "Maven", "build", true, ["maven", "org.apache.maven"]),
  def("turborepo", "Turborepo", "build", false, ["turbo"]),

  // ── 测试 ──────────────────────────────────────────────────────
  def("jest", "Jest", "test", false, ["jest", "@jest", "ts-jest", "babel-jest"]),
  def("vitest", "Vitest", "test", false, ["vitest", "@vitest"]),
  def("playwright", "Playwright", "test", true, ["playwright", "@playwright"]),
  def("cypress", "Cypress", "test", true, ["cypress"]),
  def("pytest", "Pytest", "test", false, ["pytest", "pytest-asyncio", "pytest-cov"]),
  def("junit", "JUnit", "test", false, ["junit", "org.junit", "junit-jupiter"]),
  def("testing-library", "Testing Library", "test", false, ["@testing-library"]),

  // ── 校验、序列化 ──────────────────────────────────────────────
  def("zod", "Zod", "library", true, ["zod"]),
  def("pydantic", "Pydantic", "library", true, ["pydantic", "pydantic-settings"]),
  def("serde", "Serde", "library", true, ["serde", "serde_json", "serde_yaml"]),
  def("jackson", "Jackson", "library", true, ["jackson", "com.fasterxml.jackson"]),

  // ── 数据与机器学习 ────────────────────────────────────────────
  def("numpy", "NumPy", "library", true, ["numpy"]),
  def("pandas", "Pandas", "library", true, ["pandas", "polars"]),
  def("pytorch", "PyTorch", "framework", true, ["torch", "pytorch", "torchvision", "pytorch-lightning"]),
  def("tensorflow", "TensorFlow", "framework", true, ["tensorflow", "keras"]),
  def("scikit-learn", "scikit-learn", "library", true, ["scikit-learn", "sklearn"]),
  def("transformers", "Transformers", "library", true, ["transformers", "tokenizers", "sentence-transformers"]),
  def("langchain", "LangChain", "framework", true, ["langchain", "langchain-core", "langgraph"]),

  // ── 可观测性 ──────────────────────────────────────────────────
  def("opentelemetry", "OpenTelemetry", "observability", true, ["@opentelemetry", "opentelemetry-api", "opentelemetry-sdk", "opentelemetry"]),
  def("prometheus", "Prometheus", "observability", true, ["prom-client", "prometheus-client", "prometheus"]),
  def("sentry", "Sentry", "observability", true, ["@sentry", "sentry-sdk"]),
  def("tracing", "tracing", "observability", true, ["tracing", "tracing-subscriber"]),

  // ── 安全 ──────────────────────────────────────────────────────
  def("jwt", "JWT", "security", true, ["jsonwebtoken", "jose", "pyjwt", "jjwt", "jsonwebtoken-rs"]),
  def("oauth", "OAuth / OIDC", "security", true, ["passport", "openid-client", "authlib", "spring-security-oauth2"]),
  def("spring-security", "Spring Security", "security", true, ["spring-security", "org.springframework.security"]),
  def("bcrypt", "bcrypt", "security", true, ["bcrypt", "bcryptjs", "argon2"]),

  // ── 代码质量（检出但不值得当知识点）───────────────────────────
  def("eslint", "ESLint", "build", false, ["eslint", "@eslint", "eslint-config-prettier", "eslint-plugin-react"]),
  def("prettier", "Prettier", "build", false, ["prettier"]),
  def("ruff", "Ruff", "build", false, ["ruff"]),
  def("black", "Black", "build", false, ["black"]),
  def("mypy", "mypy", "build", false, ["mypy"]),
  def("clippy", "Clippy", "build", false, ["clippy"]),
];

/** agent 学到的 alias。落库之后下次就是确定性命中，不再花钱。 */
export interface LearnedAlias {
  /** 原始包名，小写。 */
  readonly pkg: string;
  readonly ecosystem: string;
  /** 归到哪个 TechEntity。`null` = 判定为不值得单列，永久压住。 */
  readonly techId: string | null;
  readonly name: string;
  readonly category: TechCategory;
  readonly worthLearning: boolean;
  readonly confidence: number;
  readonly learnedAt: number;
}

/** 待归类的包。**它不是 TechEntity** —— 归类之前不进技术栈列表。 */
export interface PendingPackage {
  readonly pkg: string;
  readonly ecosystem: string;
  readonly version: string | null;
  readonly occurrences: number;
}

export interface TechResolution {
  readonly techId: string;
  readonly name: string;
  readonly category: TechCategory;
  readonly worthLearning: boolean;
  /** 来自内置表还是 agent 学的。UI 上不区分，排障时区分。 */
  readonly source: "builtin" | "learned";
  /**
   * 这个包名有多"像"这个技术本身，0 最像。
   *
   * ⚠️ 这个字段不是装饰。多个包并到同一个 TechEntity 时，**版本号必须取最规范的
   * 那个包的**。实机踩到过：`tsx@^4.20.6` 和 `typescript@^5.9.3` 都归到
   * `tech:typescript`，取数组第一个的结果是界面上显示 `TypeScript@^4.20.6` ——
   * 一个不存在的版本号，而用户没法知道它是从哪来的。
   */
  readonly aliasRank: number;
}

const EXACT = new Map<string, { def: TechDef; rank: number }>();
const PREFIXES: Array<{ prefix: string; def: TechDef; rank: number }> = [];
for (const definition of TECH_DEFS) {
  definition.aliases.forEach((alias, rank) => {
    const key = alias.toLowerCase();
    if (!EXACT.has(key)) EXACT.set(key, { def: definition, rank });
    // `@scope` 和 `com.example` 这类是命名空间，按前缀吃掉整个命名空间。
    // 前缀命中排在所有精确命中之后 —— `@types/react` 不该比 `react` 更权威
    if (key.startsWith("@") || key.includes(".") || key.includes("/")) {
      PREFIXES.push({ prefix: `${key}/`, def: definition, rank: rank + 100 });
      if (key.includes(".")) PREFIXES.push({ prefix: `${key}.`, def: definition, rank: rank + 100 });
    }
  });
}
// 长前缀优先，否则 `@types/react` 会被 `@types` 之类的短前缀先吃掉
PREFIXES.sort((left, right) => right.prefix.length - left.prefix.length);

/**
 * 把一个包名解析到 TechEntity。
 *
 * `learned` 传入已落库的 agent 归类结果 —— 它**压过**内置表，因为内置表是
 * 我们的猜测，而 learned 是针对这个用户实际用到的包判过一次的。
 */
export function resolveTech(
  pkg: string,
  ecosystem: string,
  learned?: ReadonlyMap<string, LearnedAlias>,
): TechResolution | null {
  const key = pkg.toLowerCase();
  const fromLearned = learned?.get(`${ecosystem}:${key}`) ?? learned?.get(`*:${key}`);
  if (fromLearned) {
    if (!fromLearned.techId) return null;
    return {
      techId: fromLearned.techId,
      name: fromLearned.name,
      category: fromLearned.category,
      worthLearning: fromLearned.worthLearning,
      source: "learned",
      // agent 是针对这个具体的包判过一次的，比内置表的猜测更贴
      aliasRank: 0,
    };
  }
  const exact = EXACT.get(key);
  if (exact) {
    return {
      techId: exact.def.id,
      name: exact.def.name,
      category: exact.def.category,
      worthLearning: exact.def.worthLearning,
      source: "builtin",
      aliasRank: exact.rank,
    };
  }
  for (const { prefix, def: definition, rank } of PREFIXES) {
    if (key.startsWith(prefix)) {
      return {
        techId: definition.id,
        name: definition.name,
        category: definition.category,
        worthLearning: definition.worthLearning,
        source: "builtin",
        aliasRank: rank,
      };
    }
  }
  return null;
}

export function learnedKey(pkg: string, ecosystem: string): string {
  return `${ecosystem}:${pkg.toLowerCase()}`;
}
