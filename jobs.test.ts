import assert from "node:assert/strict";
import test from "node:test";
import { getJob, listJobs, resetJobsForTests, startJob } from "./jobs.server";

const SEED = { kind: "wiki" as const, projectId: "p1", techId: "tech:redis" };

test("startJob 立刻返回 —— 生成不能长在请求-响应上", async () => {
  resetJobsForTests();
  let released: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { released = resolve; });

  const started = Date.now();
  const job = startJob("wiki:redis", SEED, () => blocked);
  assert.ok(Date.now() - started < 50, "起任务必须是瞬时的");
  assert.equal(job.status, "running");
  assert.equal(getJob("wiki:redis")?.status, "running");

  released();
  await blocked;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getJob("wiki:redis")?.status, "done");
  assert.ok(getJob("wiki:redis")?.finishedAt);
});

test("同一件事只跑一个 —— 重复点不再烧一份配额", async () => {
  resetJobsForTests();
  let runs = 0;
  const blocked = new Promise<void>(() => {});
  const first = startJob("wiki:redis", SEED, () => { runs += 1; return blocked; });
  const second = startJob("wiki:redis", SEED, () => { runs += 1; return blocked; });
  assert.equal(runs, 1);
  assert.equal(second.startedAt, first.startedAt, "拿到的是同一个正在跑的任务");
});

test("失败要留下可读的原因和会话入口", async () => {
  resetJobsForTests();
  await new Promise<void>((resolve) => {
    startJob("wiki:fail", SEED, async (job) => {
      job.agentId = "agent-42";
      resolve();
      throw new Error("agent 返回的内容无法校验");
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  const job = getJob("wiki:fail");
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, "agent 返回的内容无法校验");
  assert.equal(job?.agentId, "agent-42", "失败时要能点进去看 agent 到底答了什么");
});

test("按项目过滤", async () => {
  resetJobsForTests();
  const blocked = new Promise<void>(() => {});
  startJob("a", { kind: "wiki", projectId: "p1", techId: "t" }, () => blocked);
  startJob("b", { kind: "classify", projectId: "p2", techId: null }, () => blocked);
  assert.equal(listJobs("p1").length, 1);
  assert.equal(listJobs("p2").length, 1);
  assert.equal(listJobs().length, 2);
});
