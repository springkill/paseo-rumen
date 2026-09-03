import { execFile } from "node:child_process";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { confidenceForLayers, projectIdentity } from "./domain.shared";
import type { StoredAnchor, StoredTechnology } from "./store.server";

const exec = promisify(execFile);
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_SCAN_MS = 45_000;
const EXCLUDED = new Set([".git", "node_modules", "vendor", "target", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".cache", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".ex", ".exs"]);

interface TechDef { name: string; category: string; worthLearning: boolean; aliases: string[] }

const DEFINITIONS: TechDef[] = [
  { name: "TypeScript", category: "language", worthLearning: true, aliases: ["typescript"] },
  { name: "React", category: "framework", worthLearning: true, aliases: ["react", "react-dom", "@types/react"] },
  { name: "React Native", category: "framework", worthLearning: true, aliases: ["react-native", "expo"] },
  { name: "Next.js", category: "framework", worthLearning: true, aliases: ["next"] },
  { name: "Vue", category: "framework", worthLearning: true, aliases: ["vue", "nuxt"] },
  { name: "Angular", category: "framework", worthLearning: true, aliases: ["@angular/core"] },
  { name: "Svelte", category: "framework", worthLearning: true, aliases: ["svelte", "@sveltejs/kit"] },
  { name: "Express", category: "framework", worthLearning: true, aliases: ["express"] },
  { name: "NestJS", category: "framework", worthLearning: true, aliases: ["@nestjs/core"] },
  { name: "Vite", category: "build", worthLearning: true, aliases: ["vite"] },
  { name: "Webpack", category: "build", worthLearning: true, aliases: ["webpack"] },
  { name: "Tailwind CSS", category: "framework", worthLearning: true, aliases: ["tailwindcss", "@tailwindcss"] },
  { name: "Zod", category: "library", worthLearning: true, aliases: ["zod"] },
  { name: "TanStack Query", category: "library", worthLearning: true, aliases: ["@tanstack/react-query", "@tanstack/query-core"] },
  { name: "Jest", category: "test", worthLearning: false, aliases: ["jest", "@jest"] },
  { name: "Vitest", category: "test", worthLearning: false, aliases: ["vitest"] },
  { name: "FastAPI", category: "framework", worthLearning: true, aliases: ["fastapi"] },
  { name: "Django", category: "framework", worthLearning: true, aliases: ["django"] },
  { name: "Flask", category: "framework", worthLearning: true, aliases: ["flask"] },
  { name: "Pydantic", category: "library", worthLearning: true, aliases: ["pydantic"] },
  { name: "SQLAlchemy", category: "datastore", worthLearning: true, aliases: ["sqlalchemy"] },
  { name: "Pytest", category: "test", worthLearning: false, aliases: ["pytest"] },
  { name: "NumPy", category: "library", worthLearning: true, aliases: ["numpy"] },
  { name: "Pandas", category: "library", worthLearning: true, aliases: ["pandas"] },
  { name: "PyTorch", category: "framework", worthLearning: true, aliases: ["torch", "pytorch"] },
  { name: "TensorFlow", category: "framework", worthLearning: true, aliases: ["tensorflow"] },
  { name: "Tokio", category: "framework", worthLearning: true, aliases: ["tokio"] },
  { name: "Axum", category: "framework", worthLearning: true, aliases: ["axum"] },
  { name: "Serde", category: "library", worthLearning: true, aliases: ["serde"] },
  { name: "Gin", category: "framework", worthLearning: true, aliases: ["github.com/gin-gonic/gin"] },
  { name: "Spring Boot", category: "framework", worthLearning: true, aliases: ["spring-boot", "org.springframework.boot"] },
  { name: "PostgreSQL", category: "datastore", worthLearning: true, aliases: ["pg", "postgres", "postgresql", "psycopg", "psycopg2"] },
  { name: "MySQL", category: "datastore", worthLearning: true, aliases: ["mysql", "mysql2", "pymysql"] },
  { name: "SQLite", category: "datastore", worthLearning: true, aliases: ["sqlite", "sqlite3", "better-sqlite3", "rusqlite"] },
  { name: "Redis", category: "datastore", worthLearning: true, aliases: ["redis", "ioredis", "redis-py"] },
  { name: "MongoDB", category: "datastore", worthLearning: true, aliases: ["mongodb", "mongoose", "pymongo"] },
  { name: "GraphQL", category: "messaging", worthLearning: true, aliases: ["graphql", "apollo", "@apollo"] },
  { name: "gRPC", category: "messaging", worthLearning: true, aliases: ["grpc", "@grpc", "tonic"] },
  { name: "Docker", category: "infra", worthLearning: true, aliases: ["docker"] },
  { name: "Kubernetes", category: "infra", worthLearning: true, aliases: ["kubernetes", "k8s"] },
  { name: "Terraform", category: "infra", worthLearning: true, aliases: ["terraform"] },
  { name: "GitHub Actions", category: "infra", worthLearning: false, aliases: ["github-actions"] },
  { name: "AWS", category: "infra", worthLearning: true, aliases: ["aws-sdk", "@aws-sdk", "boto3", "aws"] },
];

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const ALIASES = new Map<string, TechDef>();
for (const def of DEFINITIONS) for (const alias of def.aliases) ALIASES.set(alias.toLowerCase(), def);

function definitionFor(pkg: string): TechDef | undefined {
  const key = pkg.toLowerCase();
  const exact = ALIASES.get(key);
  if (exact) return exact;
  for (const [alias, def] of ALIASES) {
    if ((alias.startsWith("@") && key.startsWith(`${alias}/`)) || (alias.includes(".") && key.startsWith(`${alias}/`))) return def;
  }
  return undefined;
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
    out.push({ pkg, ecosystem, version: typeof version === "string" ? version : null, confidence: 0.95, anchor: anchor(file, 1, `${pkg}: ${String(version)}`, "manifest") });
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
      const match = line.trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:[=<>~!]+\s*(.+))?$/);
      if (match) out.push({ pkg: match[1], ecosystem: "pypi", version: match[2] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
    });
  } else if (name === "pyproject.toml") {
    let dependencies = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) dependencies = /dependencies|poetry\.dependencies/.test(trimmed);
      if (!dependencies) return;
      const match = trimmed.match(/^['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:=|[=<>~!])\s*['"]?([^,'"]*)/);
      if (match && !["python"].includes(match[1].toLowerCase())) out.push({ pkg: match[1], ecosystem: "pypi", version: match[2] || null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
    });
  } else if (name === "Cargo.toml") {
    let dependencies = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) dependencies = /^\[(dev-|build-)?dependencies/.test(trimmed);
      if (!dependencies) return;
      const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/);
      if (match) out.push({ pkg: match[1], ecosystem: "cargo", version: match[2] ?? match[3] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
    });
  } else if (name === "go.mod") {
    lines.forEach((line, index) => {
      const match = line.trim().match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s+(v[^\s]+)/);
      if (match) out.push({ pkg: match[1], ecosystem: "go", version: match[2], confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
    });
  } else if (name === "Gemfile") {
    lines.forEach((line, index) => {
      const match = line.match(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
      if (match) out.push({ pkg: match[1], ecosystem: "gem", version: match[2] ?? null, confidence: 0.95, anchor: anchor(file, index + 1, line, "manifest") });
    });
  } else if (name === "pom.xml") {
    const regex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g;
    for (const match of text.matchAll(regex)) {
      const pkg = `${match[1]}.${match[2]}`;
      out.push({ pkg, ecosystem: "maven", version: null, confidence: 0.95, anchor: anchor(file, text.slice(0, match.index).split("\n").length, pkg, "manifest") });
    }
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
    ];
    for (const match of matches) {
      let pkg = match[1].split("/")[0];
      if (match[1].startsWith("@")) pkg = match[1].split("/").slice(0, 2).join("/");
      if (!definitionFor(pkg)) continue;
      out.push({ pkg, ecosystem: "source", version: null, confidence: 0.7, anchor: anchor(file, index + 1, line, "source") });
    }
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

export async function resolveProjectRoot(cwd: string): Promise<string> {
  if (!cwd.startsWith(sep)) throw new Error("Workspace directory must be absolute");
  const canonical = await realpath(resolve(cwd));
  const root = await git(canonical, ["rev-parse", "--show-toplevel"]);
  return root ? await realpath(root) : canonical;
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

async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const gitFiles = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (gitFiles !== null) {
    const all = gitFiles.split("\0").filter(Boolean);
    return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
  }
  const files: string[] = [];
  const queue = [root];
  const started = Date.now();
  let truncated = false;
  while (queue.length && files.length < MAX_FILES && Date.now() - started < MAX_SCAN_MS) {
    const directory = queue.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (EXCLUDED.has(entry.name) || entry.name === ".env") continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(relative(root, full));
      if (files.length >= MAX_FILES) break;
    }
  }
  if (queue.length || Date.now() - started >= MAX_SCAN_MS) truncated = true;
  return { files, truncated };
}

const MANIFESTS = new Set(["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "pom.xml", "composer.json"]);

export async function scanWorkspace(root: string): Promise<{ technologies: StoredTechnology[]; truncated: boolean }> {
  const listed = await listFiles(root);
  const findings: Finding[] = [];
  for (const relativePath of listed.files) {
    const name = basename(relativePath);
    const lower = relativePath.toLowerCase();
    if (name === ".env" || lower.includes("/.env")) continue;
    let info;
    try { info = await lstat(join(root, relativePath)); } catch { continue; }
    if (!info.isFile() || info.size > MAX_FILE_SIZE) continue;
    const isManifest = MANIFESTS.has(name) || name.startsWith("requirements");
    const isConfig = name === "Dockerfile" || name.startsWith("Dockerfile.") || /(^|\/)docker-compose.*\.ya?ml$/i.test(relativePath)
      || /(^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(relativePath) || extname(name) === ".tf";
    const isSource = SOURCE_EXTENSIONS.has(extname(name));
    if (!isManifest && !isConfig && !isSource) continue;
    let text: string;
    try { text = await readFile(join(root, relativePath), "utf8"); } catch { continue; }
    if (isManifest) findings.push(...parseManifest(relativePath, text));
    if (isSource) findings.push(...parseSource(relativePath, text));
    if (isConfig) {
      const pkg = name.startsWith("Dockerfile") || /docker-compose/i.test(name) ? "docker"
        : relativePath.includes(".github/workflows") ? "github-actions"
          : extname(name) === ".tf" ? "terraform" : "config";
      if (pkg !== "config") findings.push({ pkg, ecosystem: "config", version: null, confidence: 0.85, anchor: anchor(relativePath, 1, name, "config") });
      if (/\b(kubernetes|kubectl|kind:\s*(Deployment|Service|Pod))\b/i.test(text)) findings.push({ pkg: "kubernetes", ecosystem: "config", version: null, confidence: 0.85, anchor: anchor(relativePath, 1, name, "config") });
    }
  }

  const groups = new Map<string, { def?: TechDef; ecosystem: string; pkg: string; versions: string[]; findings: Finding[] }>();
  for (const finding of findings) {
    const def = definitionFor(finding.pkg);
    const id = def ? `tech:${slug(def.name)}` : `tech:${finding.ecosystem}/${finding.pkg.toLowerCase()}`;
    const group = groups.get(id) ?? { def, ecosystem: finding.ecosystem, pkg: finding.pkg, versions: [], findings: [] };
    group.findings.push(finding);
    if (finding.version && !group.versions.includes(finding.version)) group.versions.push(finding.version);
    groups.set(id, group);
  }

  const technologies: StoredTechnology[] = [];
  for (const [id, group] of groups) {
    const layers = new Set(group.findings.map((item) => item.anchor.layer));
    const maxConfidence = Math.max(...group.findings.map((item) => item.confidence));
    const evidence = [...new Map(group.findings.map((item) => [`${item.anchor.file}:${item.anchor.line}`, item.anchor])).values()].slice(0, 20);
    technologies.push({
      id,
      name: group.def?.name ?? group.pkg,
      category: group.def?.category ?? "unknown",
      version: group.versions[0] ?? null,
      confidence: Math.round(confidenceForLayers(maxConfidence, layers.size) * 100) / 100,
      worthLearning: group.def?.worthLearning ?? null,
      curated: Boolean(group.def),
      evidence,
    });
  }
  technologies.sort((a, b) => b.confidence - a.confidence || b.evidence.length - a.evidence.length || a.name.localeCompare(b.name));
  return { technologies: technologies.filter((item) => item.confidence >= 0.4), truncated: listed.truncated };
}
