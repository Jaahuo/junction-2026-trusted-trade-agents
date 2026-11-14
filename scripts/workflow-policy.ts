export type Risk = "ordinary" | "impact" | "lock-in";
export type Review = {
  user: { login: string; type?: string } | null;
  state: string;
  commit_id: string | null;
};

export type AgentReview = {
  head: string;
  taskOwnerAgent: string;
  reviewerAgent: string;
  method: string;
  findings: string;
  verdict: "approved";
};

export function parseAgentReview(value: unknown): AgentReview {
  if (typeof value !== "object" || value === null)
    throw new Error("Review report must be an object.");
  const get = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
  const head = get("head");
  const taskOwnerAgent = get("taskOwnerAgent");
  const reviewerAgent = get("reviewerAgent");
  const method = get("method");
  const findings = get("findings");
  const verdict = get("verdict");
  if (
    typeof head !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(head) ||
    typeof taskOwnerAgent !== "string" ||
    !taskOwnerAgent.trim() ||
    typeof reviewerAgent !== "string" ||
    !reviewerAgent.trim() ||
    taskOwnerAgent.trim().toLowerCase() === reviewerAgent.trim().toLowerCase() ||
    typeof method !== "string" ||
    !method.trim() ||
    typeof findings !== "string" ||
    !findings.trim() ||
    verdict !== "approved"
  ) {
    throw new Error(
      "Review needs an exact head, distinct agent identities, method, complete findings and approved verdict.",
    );
  }
  return { head, taskOwnerAgent, reviewerAgent, method, findings, verdict };
}

export const agentReviewMarker = "<!-- independent-agent-review-v1 -->";
export function agentReviewComment(body: string): AgentReview | undefined {
  if (!body.startsWith(`${agentReviewMarker}\n`)) return undefined;
  try {
    const value: unknown = JSON.parse(body.slice(agentReviewMarker.length + 1));
    return parseAgentReview(value);
  } catch {
    return undefined;
  }
}

export function parseRisk(body: string): Risk {
  const matches = [...body.matchAll(/^Risk:\s*(\S+)\s*$/gim)];
  const value = matches[0]?.[1]?.toLowerCase();
  if (matches.length !== 1 || (value !== "ordinary" && value !== "impact" && value !== "lock-in")) {
    throw new Error("PR must declare exactly one Risk: ordinary, impact, or lock-in line.");
  }
  return value;
}

export function requireMergeEvidence(input: {
  risk: Risk;
  head: string;
  localHead: string;
  base: string;
  currentMain: string;
  baseIsAncestor: boolean;
  author: string;
  reviews: Review[];
  agentReviews?: AgentReview[];
  checks: { name: string; status: string; conclusion: string | null }[];
}): void {
  if (input.head !== input.localHead)
    throw new Error("PR head changed; fetch and inspect before retrying.");
  if (input.base !== input.currentMain || !input.baseIsAncestor)
    throw new Error("PR is not based on current main; update the branch first.");
  const gates = input.checks.filter((check) => check.name === "gate");
  if (
    gates.length === 0 ||
    gates.some((check) => check.status !== "completed" || check.conclusion !== "success")
  ) {
    throw new Error("The gate check for this exact head must be green.");
  }
  if (input.risk === "ordinary") return;
  const latest = new Map<string, Review>();
  for (const review of input.reviews) {
    if (review.user && review.state !== "COMMENTED" && review.state !== "PENDING")
      latest.set(review.user.login.toLowerCase(), review);
  }
  const approval = [...latest.values()].some(
    (review) =>
      review.user &&
      review.user.login.toLowerCase() !== input.author.toLowerCase() &&
      review.state === "APPROVED" &&
      review.commit_id === input.head &&
      (input.risk !== "lock-in" || review.user.type === "User"),
  );
  const agentApproval =
    input.risk === "impact" && input.agentReviews?.some((review) => review.head === input.head);
  if (!approval && !agentApproval)
    throw new Error(
      input.risk === "lock-in"
        ? "Lock-in requires an independent human GitHub approval on this exact head."
        : "Impact requires an independent current-head GitHub approval or agent review report.",
    );
}

export type Worktree = { path: string; branch: string | null; head: string };

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain.split(/\n\s*\n/).flatMap((block) => {
    const line = (key: string) =>
      block
        .split("\n")
        .find((entry) => entry.startsWith(`${key} `))
        ?.slice(key.length + 1);
    const path = line("worktree");
    const head = line("HEAD");
    if (!path || !head) return [];
    const ref = line("branch");
    return [{ path, head, branch: ref?.replace(/^refs\/heads\//, "") ?? null }];
  });
}

export function worktreeCleanup(input: {
  worktree: Worktree;
  mainPath: string;
  callerPath: string;
  dirty: boolean;
  mergedHead: string;
}): { remove: true } | { remove: false; reason: string } {
  if (input.worktree.path === input.mainPath)
    return { remove: false, reason: "it is the main worktree" };
  if (
    input.callerPath === input.worktree.path ||
    input.callerPath.startsWith(`${input.worktree.path}/`)
  )
    return { remove: false, reason: "this command runs inside it" };
  if (input.dirty) return { remove: false, reason: "it has uncommitted changes" };
  if (input.worktree.head !== input.mergedHead)
    return { remove: false, reason: "its HEAD differs from the merged PR head" };
  return { remove: true };
}
