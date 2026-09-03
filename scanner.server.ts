/**
 * 技术栈识别 L1~L3（确定性，零 LLM）。
 *
 * ```
 * L1 依赖清单     拿到精确版本，最高置信
 * L2 基础设施配置  docker-compose / Dockerfile / k8s / CI —— Redis、PG 常只在这里出现
 * L3 代码信号     import / use / require
 * ```
 *
 * L4（agent 归类）在 classify.server.ts，它只给已检出的结果改标签，
 * 永远不能加出一条项目里根本不存在的技术。
 *
 * **每条识别结果必须带 evidence 锚点**（`file:line` + 原文片段）。
 * UI 上每个技术栈卡片都能展开"凭什么说我用了 Kafka" ——
 * 这是信任的来源，也是自查误报的唯一手段。
 */

import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { confidenceForLayers, projectIdentity } from "./domain.shared";
import { forbiddenRoot } from "./roots.server";
import type { StoredAnchor, StoredProjectTech, StoredTechEntity } from "./store.server";
import {
  learnedKey,
  resolveTech,
  type LearnedAlias,
  type PendingPackage,
} from "./techmap.shared";

const exec = promisify(execFile);

const MAX_FILE_SIZE = 2 * 1024 * 1024;
/** 单次扫描的文件上限。超了标 truncated 并在 UI 上明说，不假装扫全了。 */
const MAX_FILES = 60_000;
/**
 * 非 git 目录的文件上限。
 *
 * ⚠️ 这条护栏是实机事故的直接产物：用户把家目录当 workspace 打开过一次，
 * 扫描器一路遍历下去，产出 2293 个「技术栈」、6945 个知识点、7.8MB 状态文件。
 * git 仓库有 `ls-files` 天然框住边界，非 git 目录没有 —— 所以给它一条硬线，
 * 超了就**拒绝并说清楚**，而不是扫出一堆垃圾。
 */
const NON_GIT_MAX_FILES = 15_000;
const MAX_SCAN_MS = 45_000;

const EXCLUDED = new Set([
  ".git", "node_modules", "vendor", "target", "dist", "build", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", ".cache", "coverage", ".gradle", ".idea", ".vscode",
  "bower_components", ".pytest_cache", ".mypy_cache", ".tox", "site-packages",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".kt", ".kts", ".rb", ".php", ".ex", ".exs", ".cs", ".swift", ".scala",
]);

const MANIFESTS = new Set([
  "package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod",
  "Gemfile", "pom.xml", "composer.json", "build.gradle", "build.gradle.kts",
  "pubspec.yaml", "Package.swift",
]);

export class ScanBoundaryError extends Error {
  constructor(
    readonly reason: "home_or_root" | "too_broad",
    readonly path: string,
    readonly fileCount: number,
  ) {
    super(`Refusing to scan ${path} (${reason})`);
    this.name = "ScanBoundaryError";
  }
}

function anchor(file: string, line: number, snippet: string, layer: StoredAnchor["layer"]): StoredAnchor {
  return { file, line, snippet: snippet.trim().slice(0, 200), layer };
}

interface Finding {
  pkg: string;
  ecosystem: string;
  version: string | null;
  confidence: number;
  anchor: StoredAnchor;
}

function addObjectDependencies(out: Finding[], ecosystem: string, file: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [pkg, version] of Object.entries(value as Record<string, unknown>)) {
    out.push({
      pkg,
      ecosystem,
      version: typeof version === "string" ? version : null,
      confidence: 0.95,
      anchor: anchor(file, 1, `${pkg}: ${String(version)}`, "manifest"),
    });
  }
}

function parseManifest(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const name = basename(file);
  try {
    if (name === "package.json") {
      const json = JSON.parse(text) as Record<string, unknown>;
      addObjectDependencies(out, "npm", file, json.dependencies);
      addObjectDependencies(out, "npm", file, json.devDependencies);
      addObjectDependencies(out, "npm", file, json.peerDependencies);
      return out;
    }
    if (name === "composer.json") {
      const json = JSON.parse(text) as Record<string, unknown>;
      addObjectDependencies(out, "composer", file, json.require);
      addObjectDependencies(out, "composer", file, json["require-dev"]);
      return out;
    }
  } catch {
    return out;
  }
  const lines = text.split(/\r?\n/);
  if (name === "requirements.txt" || name.startsWith("requirements")) {
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) return;
      const match = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:[=<>~!]+\s*(.+))?$/);
      if (match) {
        out.push({ pkg: match[1]!, ecosystem: "pypi", version: match[2] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
      }
    });
  } else if (name === "pyproject.toml") {
    let inDependencies = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) inDependencies = /dependencies|poetry\.dependencies/.test(trimmed);
      if (trimmed.startsWith("dependencies")) inDependencies = true;
      if (!inDependencies) return;
      const match = trimmed.match(/^['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:[=<>~!]+|=)\s*['"]?([^,'"]*)/);
      if (match && match[1]!.toLowerCase() !== "python") {
        out.push({ pkg: match[1]!, ecosystem: "pypi", version: match[2] || null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
      }
    });
  } else if (name === "Cargo.toml") {
    let inDependencies = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) inDependencies = /^\[(?:workspace\.)?(?:dev-|build-)?dependencies/.test(trimmed);
      if (!inDependencies) return;
      const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/);
      if (match) {
        out.push({ pkg: match[1]!, ecosystem: "cargo", version: match[2] ?? match[3] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
      }
    });
  } else if (name === "go.mod") {
    lines.forEach((line, index) => {
      const match = line.trim().match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s+(v[^\s]+)/);
      if (match) {
        out.push({ pkg: match[1]!, ecosystem: "go", version: match[2]!, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
      }
    });
  } else if (name === "Gemfile") {
    lines.forEach((line, index) => {
      const match = line.match(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
      if (match) {
        out.push({ pkg: match[1]!, ecosystem: "gem", version: match[2] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
      }
    });
  } else if (name === "pom.xml") {
    const regex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g;
    for (const match of text.matchAll(regex)) {
      const pkg = `${match[1]!.trim()}.${match[2]!.trim()}`;
      out.push({ pkg, ecosystem: "maven", version: null, confidence: 0.95, anchor: anchor(file, text.slice(0, match.index).split("\n").length, pkg, "manifest") });
    }
  } else if (name.startsWith("build.gradle")) {
    lines.forEach((line, index) => {
      const match = line.match(/(?:implementation|api|compileOnly|testImplementation|runtimeOnly)\s*[("']+([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::([^"')]+))?/);
      if (match) {
        out.push({ pkg: `${match[1]}.${match[2]}`, ecosystem: "maven", version: match[3] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
      }
    });
  }
  return out;
}

function parseSource(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).slice(0, 5000).forEach((line, index) => {
    const matches = [
      ...line.matchAll(/(?:from\s+|import\s+(?:[^'";]+\s+from\s+)?|require\s*\()['"]([^'"./][^'"]*)['"]/g),
      ...line.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_.]*)/g),
      ...line.matchAll(/^\s*use\s+([A-Za-z_][A-Za-z0-9_]*)::/g),
      ...line.matchAll(/^\s*import\s+(?:"([^"]+)"|([A-Za-z0-9_.]+))/g),
    ];
    for (const match of matches) {
      const raw = match[1] ?? match[2];
      if (!raw) continue;
      const pkg = raw.startsWith("@") ? raw.split("/").slice(0, 2).join("/") : raw.split("/")[0]!;
      out.push({ pkg, ecosystem: "source", version: null, confidence: 0.7, anchor: anchor(file, index + 1, line, "source") });
    }
  });
  return out;
}

/** L2：从 compose 的 `image:` 里认出 Redis / PG / Kafka —— 它们常只在这里出现。 */
function parseInfraConfig(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const name = basename(file);
  const lower = file.toLowerCase();
  const push = (pkg: string, line: number, snippet: string) =>
    out.push({ pkg, ecosystem: "config", version: null, confidence: 0.85, anchor: anchor(file, line, snippet, "config") });

  if (name.startsWith("Dockerfile") || /docker-compose/i.test(name)) push("docker", 1, name);
  if (lower.includes(".github/workflows")) push("github-actions", 1, name);
  if (extname(name) === ".tf") push("terraform", 1, name);

  text.split(/\r?\n/).slice(0, 3000).forEach((line, index) => {
    const image = line.match(/^\s*(?:image|FROM)\s*:?\s*["']?([A-Za-z0-9_./-]+)(?::[^\s"']+)?/i);
    if (image) {
      const repository = image[1]!.split("/").pop()!.toLowerCase();
      if (repository && repository !== "scratch") push(repository, index + 1, line);
    }
    if (/^\s*kind:\s*(?:Deployment|Service|StatefulSet|Pod|Ingress)\b/.test(line)) {
      push("kubernetes", index + 1, line);
    }
    const scheme = line.match(/\b(redis|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|amqp|kafka|clickhouse):\/\//i);
    if (scheme) push(scheme[1]!.toLowerCase().replace("postgres", "postgresql").replace("postgresqlql", "postgresql"), index + 1, line);
  });
  return out;
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function resolveProjectRoot(cwd: string): Promise<{ root: string; isGit: boolean }> {
  if (!cwd.startsWith(sep)) throw new Error("Workspace directory must be absolute");
  const canonical = await realpath(resolve(cwd));
  const top = await git(canonical, ["rev-parse", "--show-toplevel"]);
  if (top) return { root: await realpath(top), isGit: true };
  return { root: canonical, isGit: false };
}

export async function identifyProject(root: string) {
  const [remote, firstCommit] = await Promise.all([
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["rev-list", "--max-parents=0", "HEAD"]),
  ]);
  return {
    id: projectIdentity({ remote, firstCommit: firstCommit?.split("\n")[0], path: root }),
    name: basename(root),
  };
}

async function listFiles(root: string, isGit: boolean): Promise<{ files: string[]; truncated: boolean }> {
  if (isGit) {
    const tracked = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
    if (tracked !== null) {
      const all = tracked.split("\0").filter(Boolean);
      return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
    }
  }
  const files: string[] = [];
  const queue = [root];
  const started = Date.now();
  const limit = isGit ? MAX_FILES : NON_GIT_MAX_FILES;
  while (queue.length && files.length <= limit && Date.now() - started < MAX_SCAN_MS) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(relative(root, full));
      if (files.length > limit) break;
    }
  }
  if (!isGit && files.length > NON_GIT_MAX_FILES) {
    throw new ScanBoundaryError("too_broad", root, NON_GIT_MAX_FILES);
  }
  return { files, truncated: queue.length > 0 || Date.now() - started >= MAX_SCAN_MS };
}

export interface ScanResult {
  /** 新发现的全局 TechEntity，调用方负责并进注册表。 */
  techs: StoredTechEntity[];
  /** 「项目 × 技术」的用法边。 */
  technologies: StoredProjectTech[];
  /** 未命中 alias 表的包。**它们不是技术栈**，等 L4 归类。 */
  pending: PendingPackage[];
  truncated: boolean;
}

export async function scanWorkspace(
  root: string,
  isGit: boolean,
  learned: readonly LearnedAlias[] = [],
): Promise<ScanResult> {
  if (forbiddenRoot(root)) throw new ScanBoundaryError("home_or_root", root, 0);

  const learnedMap = new Map(learned.map((item) => [learnedKey(item.pkg, item.ecosystem), item]));
  // agent 学到的 alias 也允许跨生态复用：一个包名在哪个生态里都是同一个东西
  for (const item of learned) learnedMap.set(`*:${item.pkg.toLowerCase()}`, item);

  const listed = await listFiles(root, isGit);
  const findings: Finding[] = [];

  for (const relativePath of listed.files) {
    const name = basename(relativePath);
    const lower = relativePath.toLowerCase();
    // `.env` 一个字都不读 —— 里面是密钥，不是技术栈证据
    if (name === ".env" || name.startsWith(".env.") || lower.includes("/.env")) continue;

    const isManifest = MANIFESTS.has(name) || name.startsWith("requirements");
    const isConfig = name.startsWith("Dockerfile")
      || /(^|\/)docker-compose[^/]*\.ya?ml$/i.test(relativePath)
      || /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(relativePath)
      || extname(name) === ".tf"
      || /(^|\/)(?:k8s|kubernetes|deploy|manifests)\/[^/]+\.ya?ml$/i.test(relativePath);
    const isSource = SOURCE_EXTENSIONS.has(extname(name));
    if (!isManifest && !isConfig && !isSource) continue;

    let info;
    try {
      info = await lstat(join(root, relativePath));
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_SIZE) continue;

    let text: string;
    try {
      text = await readFile(join(root, relativePath), "utf8");
    } catch {
      continue;
    }
    if (isManifest) findings.push(...parseManifest(relativePath, text));
    if (isConfig) findings.push(...parseInfraConfig(relativePath, text));
    if (isSource) findings.push(...parseSource(relativePath, text));
  }

  // ── 归并：Package → TechEntity ─────────────────────────────────
  const techs = new Map<string, StoredTechEntity>();
  const usage = new Map<string, {
    /** 版本候选，按"这个包有多像这个技术本身"排序后取第一个。 */
    versions: Array<{ version: string; rank: number }>;
    findings: Finding[];
    packages: Set<string>;
  }>();
  const pending = new Map<string, { pkg: string; ecosystem: string; version: string | null; occurrences: number }>();

  for (const finding of findings) {
    const resolved = resolveTech(finding.pkg, finding.ecosystem, learnedMap);
    if (!resolved) {
      // L3 的 source import 噪声太大（本地模块、相对路径已排除但仍有标准库），
      // 只把**依赖清单和基础设施配置**里未命中的包送进待归类池。
      if (finding.ecosystem === "source") continue;
      const key = learnedKey(finding.pkg, finding.ecosystem);
      const existing = pending.get(key);
      if (existing) existing.occurrences += 1;
      else pending.set(key, { pkg: finding.pkg, ecosystem: finding.ecosystem, version: finding.version, occurrences: 1 });
      continue;
    }
    techs.set(resolved.techId, {
      id: resolved.techId,
      name: resolved.name,
      category: resolved.category,
      worthLearning: resolved.worthLearning,
      origin: resolved.source,
    });
    const entry = usage.get(resolved.techId) ?? { versions: [], findings: [], packages: new Set<string>() };
    entry.findings.push(finding);
    entry.packages.add(finding.pkg);
    if (finding.version) {
      // ⭐ 带上 alias 规范度，下面按它排序。直接取先出现的那个会显示出
      // `TypeScript@^4.20.6` 这种根本不存在的版本（那是 tsx 的版本号）
      entry.versions.push({ version: finding.version, rank: resolved.aliasRank });
    }
    usage.set(resolved.techId, entry);
  }

  const technologies: StoredProjectTech[] = [];
  for (const [techId, entry] of usage) {
    const layers = new Set(entry.findings.map((item) => item.anchor.layer));
    const maxConfidence = Math.max(...entry.findings.map((item) => item.confidence));
    const evidence = [...new Map(entry.findings.map((item) => [`${item.anchor.file}:${item.anchor.line}`, item.anchor])).values()].slice(0, 20);
    const version = entry.versions
      .slice()
      .sort((left, right) => left.rank - right.rank)[0]?.version ?? null;
    technologies.push({
      techId,
      version,
      confidence: Math.round(confidenceForLayers(maxConfidence, layers.size) * 100) / 100,
      evidence,
      packages: [...entry.packages].slice(0, 20),
    });
  }
  technologies.sort((left, right) => right.confidence - left.confidence || right.evidence.length - left.evidence.length);

  return {
    techs: [...techs.values()],
    technologies: technologies.filter((item) => item.confidence >= 0.4),
    pending: [...pending.values()]
      .sort((left, right) => right.occurrences - left.occurrences)
      .slice(0, 400) satisfies PendingPackage[],
    truncated: listed.truncated,
  };
}
