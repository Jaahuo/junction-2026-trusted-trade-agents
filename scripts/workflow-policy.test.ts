import { describe, expect, test } from "bun:test";
import {
  agentReviewComment,
  agentReviewMarker,
  parseAgentReview,
  parseRisk,
  parseWorktrees,
  requireMergeEvidence,
  type Review,
  worktreeCleanup,
} from "./workflow-policy.ts";

const approval: Review = {
  user: { login: "reviewer", type: "User" },
  state: "APPROVED",
  commit_id: "head",
};
const ready = () => ({
  risk: "ordinary" as const,
  head: "head",
  localHead: "head",
  base: "main",
  currentMain: "main",
  baseIsAncestor: true,
  author: "author",
  reviews: [] as Review[],
  checks: [{ name: "gate", status: "completed", conclusion: "success" as string | null }],
});

describe("PR merge policy", () => {
  test("requires one known risk declaration", () => {
    expect(parseRisk("Details\nRisk: impact")).toBe("impact");
    expect(() => parseRisk("")).toThrow();
    expect(() => parseRisk("Risk: unknown")).toThrow();
    expect(() => parseRisk("Risk: ordinary\nRisk: impact")).toThrow();
  });
  test("ordinary changes require only current head, base and green gate", () => {
    expect(() => requireMergeEvidence(ready())).not.toThrow();
    expect(() => requireMergeEvidence({ ...ready(), localHead: "old" })).toThrow();
    expect(() => requireMergeEvidence({ ...ready(), currentMain: "new" })).toThrow();
    expect(() => requireMergeEvidence({ ...ready(), baseIsAncestor: false })).toThrow();
    expect(() => requireMergeEvidence({ ...ready(), checks: [] })).toThrow();
    expect(() =>
      requireMergeEvidence({
        ...ready(),
        checks: [{ name: "gate", status: "completed", conclusion: "failure" }],
      }),
    ).toThrow();
  });
  test("impact needs independent current-head approval", () => {
    const impact = { ...ready(), risk: "impact" as const };
    expect(() => requireMergeEvidence(impact)).toThrow();
    expect(() =>
      requireMergeEvidence({ ...impact, reviews: [{ ...approval, commit_id: "old" }] }),
    ).toThrow();
    expect(() =>
      requireMergeEvidence({
        ...impact,
        reviews: [{ ...approval, user: { login: "author", type: "User" } }],
      }),
    ).toThrow();
    expect(() =>
      requireMergeEvidence({
        ...impact,
        reviews: [approval, { ...approval, state: "CHANGES_REQUESTED" }],
      }),
    ).toThrow();
    expect(() => requireMergeEvidence({ ...impact, reviews: [approval] })).not.toThrow();
  });
  test("agent review evidence is independent, complete and bound to the exact head", () => {
    const head = "a".repeat(40);
    const data = {
      head,
      taskOwnerAgent: "owner-agent",
      reviewerAgent: "review-agent",
      method: "independent review of the diff",
      findings: "No unresolved findings; checked concurrency and contracts.",
      verdict: "approved",
    };
    const report = agentReviewComment(`${agentReviewMarker}\n${JSON.stringify(data)}`);
    expect(report).toBeDefined();
    if (!report) throw new Error("valid report was not decoded");
    const impact = {
      ...ready(),
      risk: "impact" as const,
      head,
      localHead: head,
      agentReviews: [report],
    };
    expect(() => requireMergeEvidence(impact)).not.toThrow();
    expect(() =>
      requireMergeEvidence({ ...impact, head: "b".repeat(40), localHead: "b".repeat(40) }),
    ).toThrow();
    expect(() => requireMergeEvidence({ ...impact, risk: "lock-in" })).toThrow();
    expect(() => parseAgentReview({ ...data, reviewerAgent: "owner-agent" })).toThrow();
    expect(() => parseAgentReview({ ...data, findings: "" })).toThrow();
    expect(() => parseAgentReview({ ...data, method: "" })).toThrow();
    expect(agentReviewComment(`${agentReviewMarker}\n{}`)).toBeUndefined();
  });
  test("lock-in additionally needs a human account", () => {
    const lockIn = { ...ready(), risk: "lock-in" as const };
    expect(() =>
      requireMergeEvidence({
        ...lockIn,
        reviews: [{ ...approval, user: { login: "bot", type: "Bot" } }],
      }),
    ).toThrow();
    expect(() => requireMergeEvidence({ ...lockIn, reviews: [approval] })).not.toThrow();
  });
});

describe("merged worktree cleanup", () => {
  const porcelain = [
    "worktree /repo\nHEAD aaa\nbranch refs/heads/main",
    "worktree /repo.task-7\nHEAD bbb\nbranch refs/heads/task/7",
    "worktree /repo.detached\nHEAD ccc\ndetached\nlocked in use",
  ].join("\n\n");
  const [main, task, detached] = parseWorktrees(`${porcelain}\n`);
  const input = (overrides: Partial<Parameters<typeof worktreeCleanup>[0]> = {}) => ({
    worktree: task ?? { path: "", head: "", branch: null, locked: false },
    mainPath: "/repo",
    callerPath: "/repo",
    dirty: false,
    mergedHead: "bbb",
    ...overrides,
  });

  test("parses worktree paths, heads and branches", () => {
    expect(main).toEqual({ path: "/repo", head: "aaa", branch: "main", locked: false });
    expect(task).toEqual({ path: "/repo.task-7", head: "bbb", branch: "task/7", locked: false });
    expect(detached).toEqual({ path: "/repo.detached", head: "ccc", branch: null, locked: true });
  });

  test("removes a clean worktree at the merged head", () => {
    expect(worktreeCleanup(input())).toEqual({ remove: true });
  });

  test("keeps the main worktree", () => {
    expect(worktreeCleanup(input({ mainPath: "/repo.task-7" })).remove).toBe(false);
  });

  test("keeps the worktree the command runs in", () => {
    expect(worktreeCleanup(input({ callerPath: "/repo.task-7/scripts" })).remove).toBe(false);
    expect(worktreeCleanup(input({ callerPath: "/repo.task-70" })).remove).toBe(true);
  });

  test("keeps a locked worktree", () => {
    const locked = { path: "/repo.task-7", head: "bbb", branch: "task/7", locked: true };
    expect(worktreeCleanup(input({ worktree: locked })).remove).toBe(false);
  });

  test("keeps a worktree with uncommitted changes", () => {
    expect(worktreeCleanup(input({ dirty: true })).remove).toBe(false);
  });

  test("keeps a worktree with commits after the merged head", () => {
    expect(worktreeCleanup(input({ mergedHead: "zzz" })).remove).toBe(false);
  });
});
