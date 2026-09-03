import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confidenceForLayers, evidenceKey, masteryOf, normalizeRemote, projectIdentity } from "./domain.shared";
import { scanWorkspace } from "./scanner.server";
import { parseTimelineImpact } from "./timeline.shared";

test("mastery preserves debt semantics and grasp threshold", () => {
  const now = Date.now();
  const debtOnly = masteryOf([{ kind: "agent_wrote_unreviewed", createdAt: now }], now);
  assert.equal(debtOnly.score, 0);
  assert.equal(debtOnly.debt, 1);
  assert.equal(debtOnly.grasped, false);
  const learned = masteryOf([
    { kind: "human_wrote", createdAt: now },
    { kind: "debugged", createdAt: now },
    { kind: "quiz_passed", createdAt: now },
  ], now);
  assert.ok(learned.score >= 60);
  assert.ok(learned.confidence >= 0.5);
  assert.equal(learned.grasped, true);
});

test("project identity normalizes equivalent Git remotes", () => {
  assert.equal(normalizeRemote("git@github.com:Example/Rumen.git"), "github.com/example/rumen");
  assert.equal(
    projectIdentity({ remote: "https://github.com/example/rumen.git", path: "/tmp/a" }),
    projectIdentity({ remote: "git@github.com:example/rumen.git", path: "/tmp/b" }),
  );
});

test("evidence is idempotent within a UTC day", () => {
  const first = Date.parse("2026-01-02T01:00:00Z");
  const second = Date.parse("2026-01-02T23:00:00Z");
  assert.equal(evidenceKey("node", "wiki_read", "ref", first), evidenceKey("node", "wiki_read", "ref", second));
  assert.notEqual(evidenceKey("node", "wiki_read", "ref", first), evidenceKey("node", "quiz_passed", "ref", first));
});

test("cross-layer confidence is bounded", () => {
  assert.equal(confidenceForLayers(0.95, 1), 0.95);
  assert.ok(confidenceForLayers(0.7, 3) > 0.7);
  assert.ok(confidenceForLayers(0.95, 10) <= 0.99);
});

test("scanner detects direct and source technologies without reading env", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-test-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", redis: "^5.0.0" } }));
    await writeFile(join(root, "app.tsx"), "import React from 'react';\nimport { createClient } from 'redis';\n");
    await writeFile(join(root, ".env"), "SECRET=redis\n");
    const result = await scanWorkspace(root);
    const names = result.technologies.map((item) => item.name);
    assert.ok(names.includes("React"));
    assert.ok(names.includes("Redis"));
    assert.ok(result.technologies.find((item) => item.name === "React")!.confidence >= 0.95);
    assert.ok(result.technologies.every((item) => item.evidence.every((anchor) => anchor.file !== ".env")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline transformation is bounded to completed mutating tools", () => {
  assert.deepEqual(parseTimelineImpact({ type: "tool_call", callId: "call-1", name: "write", status: "completed", detail: { type: "write", filePath: "package.json" } }), {
    tool: "write",
    target: "package.json",
    signal: "manifest",
    label: "Dependency or infrastructure change",
  });
  assert.equal(parseTimelineImpact({ type: "tool_call", callId: "call-2", name: "read", status: "completed", detail: { type: "read", filePath: "package.json" } }), null);
  assert.equal(parseTimelineImpact({ type: "tool_call", callId: "call-3", name: "write", status: "running", detail: { type: "write", filePath: "x.ts" } }), null);
});
