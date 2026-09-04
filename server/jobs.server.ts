/**
 * 生成任务的登记簿。
 *
 * ## 为什么必须有
 *
 * 生成一篇 wiki 要联网搜多次再写长文，实测几分钟起步。早先 `generateWiki`
 * 是**同步 RPC**，一等就是十五分钟 —— 实机上直接把界面转死了，
 * 中途 RPC 传输层还先超时报错，用户看到的是"报了个错然后一直转圈"。
 *
 * 一个可能跑十五分钟的动作不能长在请求-响应上。这里把它变成：
 * RPC 立刻返回一个任务 id，界面轮询状态，任务在后台跑。
 *
 * ## 只放内存，不落盘
 *
 * 任务状态不跨插件重启 —— 插件重启了我们就是**不知道**那次生成怎么样了，
 * 落一份盘只会让界面显示一个永远"运行中"的僵尸。重启后用户重试即可，
 * 而 Shared 层缓存会让已经成功的那部分不必重跑。
 *
 * （agent 会话本身在 Paseo 里是持久的，用户始终能点进去看。）
 */

export type JobStatus = "running" | "done" | "failed";

export interface Job {
  readonly id: string;
  readonly kind: "wiki" | "classify";
  readonly projectId: string;
  /** wiki 任务专属，用来在界面上对上是哪个技术栈。 */
  readonly techId: string | null;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  /** 已经本地化好的错误文案。 */
  error: string | null;
  /** Rumen 起的那个会话，失败时用户要能点进去看。 */
  agentId: string | null;
}

const jobs = new Map<string, Job>();

/** 完成的任务留这么久，够界面轮询到结果并展示一次。 */
const RETENTION_MS = 10 * 60_000;

function prune(now: number): void {
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.finishedAt !== null && now - job.finishedAt > RETENTION_MS) {
      jobs.delete(id);
    }
  }
}

/**
 * 同一件事只跑一个。
 *
 * key 就是任务 id —— 重复点"生成 Wiki"应该拿到同一个正在跑的任务，
 * 而不是再烧一份配额。
 */
export function startJob(
  id: string,
  seed: Pick<Job, "kind" | "projectId" | "techId">,
  run: (job: Job) => Promise<void>,
): Job {
  const now = Date.now();
  prune(now);
  const existing = jobs.get(id);
  if (existing?.status === "running") return { ...existing };

  const job: Job = {
    id,
    ...seed,
    status: "running",
    startedAt: now,
    finishedAt: null,
    error: null,
    agentId: null,
  };
  jobs.set(id, job);

  // 刻意不 await：这就是"后台"的全部含义
  void run(job)
    .then(() => {
      job.status = "done";
      job.finishedAt = Date.now();
    })
    .catch((error: unknown) => {
      job.status = "failed";
      job.finishedAt = Date.now();
      job.error = error instanceof Error ? error.message : String(error);
    });

  return { ...job };
}

export function getJob(id: string): Job | null {
  const job = jobs.get(id);
  return job ? { ...job } : null;
}

export function listJobs(projectId?: string): Job[] {
  prune(Date.now());
  return [...jobs.values()]
    .filter((job) => !projectId || job.projectId === projectId)
    .map((job) => ({ ...job }))
    .sort((left, right) => right.startedAt - left.startedAt);
}

export function resetJobsForTests(): void {
  jobs.clear();
}
