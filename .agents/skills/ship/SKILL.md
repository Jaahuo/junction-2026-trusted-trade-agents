---
name: ship
description: Ship a task through a pull request, with risk-appropriate review and approval.
---

# Ship a task

Only the task owner commits, pushes and manages the PR. Integrate helpers' changes, run the applicable checks at the integrated end and exercise the real changed flow. Record results and limitations in the PR. Never bypass hooks or force-push.

Choose risk by impact, not folder: `ordinary` for reversible changes, `impact` for high-impact changes, `lock-in` for hard-to-reverse decisions. Use `bun scripts/ship.ts --risk ordinary`, substituting the appropriate risk. The default opens or updates a PR, not a merge. An ordinary PR needs green CI. An impact PR needs independent current-head GitHub approval or independent agent review evidence. A lock-in PR needs independent human GitHub approval on that head.

For agent review, use `bun run ship --risk impact --review-file report.json`. The JSON must contain the full exact SHA in `head`, distinct nonempty `taskOwnerAgent` and `reviewerAgent`, `method`, complete review `findings` and their disposition, and `verdict` exactly `approved`. This posts a PR-author-attributed evidence comment. Independence and human identity are conventions, not cryptographically verified or server-enforced. Repeat review after a new commit.

After review and required CI, the owner may use `bun scripts/ship.ts --risk <risk> --merge` when authorized. It checks the required gate, current main and exact head. A stale head or failed gate requires updating the branch, rerunning checks and renewing evidence as needed. See [workflow](../../../docs/workflow.md) for server-enforcement limitations.
