import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin";
import { answerQuiz, exportKnowledge, getAgentImpact, getDashboard, getWiki, nextQuiz, recordEvidence } from "./service.server";
import { readState, resetStoreForTests, statePath, updateState } from "./store.server";

function contextFor(workspaceId: string, directory: string): PluginHandlerContext {
  const workspace = {
    id: workspaceId,
    workspaceDirectory: directory,
    title: "Test workspace",
    name: "test",
  };
  const timeline = {
    agent: { id: "agent-1", workspaceId, status: "running" },
    entries: [
      { item: { type: "tool_call", callId: "call-1", name: "functions.write", status: "completed", detail: { type: "write", filePath: "app.tsx" } }, timestamp: "2026-01-02T12:00:00.000Z" },
      { item: { type: "tool_call", callId: "call-read", name: "read", status: "completed", detail: { type: "read", filePath: "app.tsx" } }, timestamp: "2026-01-02T12:01:00.000Z" },
      { item: { type: "tool_call", callId: "call-failed", name: "write", status: "failed", detail: { type: "write", filePath: "app.tsx" } }, timestamp: "2026-01-02T12:02:00.000Z" },
    ],
  };
  return {
    paseo: {
      workspaces: { ref: () => ({ refresh: async () => workspace }) },
      agents: { ref: () => ({ timeline: { refetch: async () => timeline } }) },
    },
  } as unknown as PluginHandlerContext;
}

test("workspace service supports scan, wiki, quiz, evidence, impact, and redacted export", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-service-"));
  const data = await mkdtemp(join(tmpdir(), "paseo-rumen-data-"));
  process.env.RUMEN_DATA_DIR = data;
  resetStoreForTests();
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    await writeFile(join(root, "app.tsx"), "import React from 'react';\n");
    const context = contextFor("workspace-1", root);
    const dashboard = await getDashboard({ workspaceId: "workspace-1", cwd: root }, context);
    const react = dashboard.technologies.find((item) => item.name === "React");
    assert.ok(react);
    assert.equal(dashboard.project.privacy, "private");

    const wiki = await getWiki({ workspaceId: "workspace-1", cwd: root, techId: react.id, force: false }, context);
    assert.match(wiki.body, /React fundamentals/);

    const question = await nextQuiz({ workspaceId: "workspace-1", cwd: root, techId: react.id }, context);
    const result = await answerQuiz({ workspaceId: "workspace-1", cwd: root, questionId: question.id, answer: "React core fundamentals explain abstractions, configuration, integration, tests, debugging, performance and security in production." }, context);
    assert.equal(result.passed, true);

    const node = react.nodes[0];
    const mastery = await recordEvidence({ workspaceId: "workspace-1", cwd: root, nodeId: node.id, kind: "wiki_read" }, context);
    assert.ok(mastery.score > 0);

    const impact = await getAgentImpact({ workspaceId: "workspace-1", cwd: root, agentId: "agent-1" }, context);
    assert.equal(impact.agentId, "agent-1");
    assert.equal(impact.totalDebt, 3, "one completed write creates one debt item per weak node; reads and failed writes do not");
    const replay = await getAgentImpact({ workspaceId: "workspace-1", cwd: root, agentId: "agent-1" }, context);
    assert.equal(replay.totalDebt, impact.totalDebt, "replaying the same canonical call must not add debt");

    const secondRoot = await mkdtemp(join(tmpdir(), "paseo-rumen-other-"));
    try {
      await writeFile(join(secondRoot, "package.json"), JSON.stringify({ dependencies: { redis: "^5.0.0", react: "^19.0.0" } }));
      const secondContext = contextFor("workspace-2", secondRoot);
      const secondDashboard = await getDashboard({ workspaceId: "workspace-2", cwd: secondRoot }, secondContext);
      const secondReact = secondDashboard.technologies.find((item) => item.name === "React")!;
      const secondWiki = await getWiki({ workspaceId: "workspace-2", cwd: secondRoot, techId: secondReact.id, force: false }, secondContext);
      assert.match(wiki.body, /2 local evidence anchors/);
      assert.match(secondWiki.body, /1 local evidence anchor/);
      const foreignNode = secondDashboard.technologies.find((item) => item.name === "Redis")!.nodes[0];
      await assert.rejects(() => recordEvidence({ workspaceId: "workspace-1", cwd: root, nodeId: foreignNode.id, kind: "wiki_read" }, context), /does not belong/);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }

    const exported = await exportKnowledge({});
    const content = await readFile(exported.path, "utf8");
    assert.ok(exported.records > 0);
    assert.equal(content.includes(root), false);
    assert.equal(content.includes("app.tsx"), false);
  } finally {
    delete process.env.RUMEN_DATA_DIR;
    resetStoreForTests();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("malformed persistent state is never replaced with an empty store", async () => {
  const data = await mkdtemp(join(tmpdir(), "paseo-rumen-corrupt-"));
  process.env.RUMEN_DATA_DIR = data;
  resetStoreForTests();
  try {
    await mkdir(data, { recursive: true });
    await writeFile(statePath(), "{not-json", "utf8");
    await assert.rejects(() => readState(), /malformed/);
    await assert.rejects(() => updateState((state) => state.projects.push()), /malformed/);
    assert.equal(await readFile(statePath(), "utf8"), "{not-json");
  } finally {
    delete process.env.RUMEN_DATA_DIR;
    resetStoreForTests();
    await rm(data, { recursive: true, force: true });
  }
});
