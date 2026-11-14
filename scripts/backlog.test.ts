import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BacklogIssue,
  type Board,
  blockers,
  canonicalPath,
  dependencies,
  isStale,
  loopClaim,
  ownedPaths,
  overlapping,
  overlaps,
  plan,
} from "./backlog.ts";

const body = (owns: string, depends = "None.", acceptance = "1. gate.") =>
  `## Goal\n\nx\n\n## Owns\n\nOwned paths: ${owns}\n\n## Depends on\n\n${depends}\n\n## Acceptance\n\n${acceptance}\n`;

const issue = (number: number, patch: Partial<BacklogIssue> = {}): BacklogIssue => ({
  number,
  title: `Issue ${number}`,
  body: body("`contexts/offers/**`"),
  labels: ["wave:4"],
  assignees: [],
  status: "Todo",
  ...patch,
});

const board = (open: BacklogIssue[], patch: Partial<Board> = {}): Board => ({
  open,
  closed: new Set(),
  prs: [],
  claimed: new Set(),
  ...patch,
});

describe("issue text", () => {
  test("dependencies reads Depends on and Merge after references", () => {
    expect(dependencies(body("`a`", "#19\n\nMerge after: #119, #120"))).toEqual([19, 119, 120]);
    expect(dependencies(body("`a`"))).toEqual([]);
  });

  test("dependencies also reads a Merge after section and inline Depends on lines", () => {
    expect(dependencies(`${body("`a`")}\n## Merge after\n\n#9\n`)).toEqual([9]);
    expect(dependencies("## Goal\n\nDepends on: #7 and #8.\n- Blocked by #6\n")).toEqual([7, 8, 6]);
  });

  test("ownedPaths reads the backticked paths and drops trailing globs", () => {
    expect(
      ownedPaths(body("`contexts/offers/**` except package.json, `scripts/demo-smoke.ts`")),
    ).toEqual(["contexts/offers", "scripts/demo-smoke.ts"]);
  });

  test("ownedPaths reads bullet lines, drops trailing slashes and skips Keep out of", () => {
    const owns =
      "## Owns\n\nOwned paths:\n- `scripts/`\n- `docs/workflow.md` (one section)\n\nKeep out of: `contexts/**`\n\n## Acceptance\n";
    expect(ownedPaths(owns)).toEqual(["scripts", "docs/workflow.md"]);
    expect(overlaps(ownedPaths(owns) ?? [], ["scripts/backlog.ts"])).toBe(true);
  });

  test("canonicalPath turns every spelling of a folder into one prefix", () => {
    for (const spelling of ["scripts", "scripts/", "./scripts/**", "scripts/**/", "scripts/*"])
      expect(canonicalPath(spelling)).toBe("scripts");
    expect(canonicalPath("contexts/*/src")).toBe("contexts");
    expect(canonicalPath("the views lane")).toBeNull();
  });

  test("ownedPaths skips every bullet of a Keep out of list", () => {
    const owns =
      "## Owns\n\nOwned paths: `scripts/**`\n\nKeep out of:\n- `contexts/**`\n- `apps/**`\n\n## Acceptance\n";
    expect(ownedPaths(owns)).toEqual(["scripts"]);
  });

  test("ownedPaths is null when the Owns section is missing or names no path", () => {
    expect(ownedPaths("## Goal\n\nx\n")).toBeNull();
    expect(ownedPaths("## Owns\n\nOwned paths: the views lane\n")).toBeNull();
  });

  test("overlaps compares whole path segments", () => {
    expect(overlaps(["contexts/offers"], ["contexts/offers/src/api"])).toBe(true);
    expect(overlaps(["contexts/offers"], ["contexts/offers-ui"])).toBe(false);
  });
});

describe("blockers", () => {
  test("a clean Todo issue with closed dependencies is ready", () => {
    const ready = issue(1, { body: body("`a`", "#9") });
    expect(blockers(ready, board([ready], { closed: new Set([9]) }))).toEqual([]);
  });

  test("an open dependency or an open merge-after issue blocks", () => {
    const waiting = issue(1, { body: body("`a`", "#9\n\nMerge after: #10") });
    const result = blockers(waiting, board([waiting, issue(9), issue(10)]));
    expect(result).toContain("depends on open #9");
    expect(result).toContain("depends on open #10");
  });

  test("an open PR named as a dependency blocks; a merged one does not", () => {
    const waiting = issue(1, { body: body("`a`", "Merge after: #116") });
    expect(
      blockers(waiting, board([waiting], { prs: [{ number: 116, headRefName: "x", closes: [] }] })),
    ).toEqual(["depends on open #116"]);
    expect(blockers(waiting, board([waiting], { closed: new Set([116]) }))).toEqual([]);
    expect(blockers(waiting, board([waiting]))).toEqual([
      "depends on #116, which is neither closed nor merged",
    ]);
  });

  test("blocking labels, person-only titles and missing acceptance block", () => {
    for (const label of ["blocked", "needs-decision", "risk:lock-in", "kind:spike"]) {
      const labelled = issue(1, { labels: [label] });
      expect(blockers(labelled, board([labelled]))).toEqual([`label ${label}`]);
    }
    const mentor = issue(2, { title: "Mentor question: may we?" });
    expect(blockers(mentor, board([mentor]))).toEqual(["needs a person"]);
    const decision = issue(4, { title: "Decision: choose a provider" });
    expect(blockers(decision, board([decision]))).toEqual(["needs a person"]);
    const unowned = issue(5, { body: "## Acceptance\n\n1. gate.\n" });
    expect(blockers(unowned, board([unowned]))).toEqual(["no owned paths"]);
    const vague = issue(3, { body: "## Owns\n\nOwned paths: `a`\n" });
    expect(blockers(vague, board([vague]))).toEqual(["no acceptance criteria"]);
  });

  test("an assigned, in-progress, claimed or PR-covered issue is taken", () => {
    const taken = issue(1, { assignees: ["someone"], status: "In progress" });
    expect(
      blockers(
        taken,
        board([taken], {
          claimed: new Set([1]),
          prs: [{ number: 50, headRefName: "task/1", closes: [] }],
        }),
      ),
    ).toEqual([
      "assigned to someone",
      "board In progress",
      "claimed: task/1 exists",
      "open PR #50",
    ]);
  });

  test("an explicit claim accepts only its own assignee, without exposing it in the pool", () => {
    const mine = issue(1, { assignees: ["Jaahuo"] });
    expect(blockers(mine, board([mine]), "jaahuo")).toEqual([]);
    expect(plan(board([mine])).ready).toEqual([]);
    const shared = issue(1, { assignees: ["Jaahuo", "someone"] });
    expect(blockers(shared, board([shared]), "Jaahuo")).toEqual(["assigned to someone"]);
    expect(blockers(mine, board([mine]), "someone")).toEqual(["assigned to Jaahuo"]);
  });

  test("a self-assigned claim still respects reservations and overlapping owners", () => {
    const mine = issue(1, { assignees: ["Jaahuo"] });
    const other = issue(2, { assignees: ["someone"] });
    expect(blockers(mine, board([mine, other], { claimed: new Set([1]) }), "Jaahuo")).toEqual([
      "claimed: task/1 exists",
      "owned paths overlap active #2",
    ]);
  });

  test("owned paths that overlap an active issue block; a Done or idle issue does not", () => {
    const mine = issue(1, { body: body("`contexts/offers/src/domain`") });
    const active = issue(2, { assignees: ["someone"] });
    const done = issue(3, { assignees: ["someone"], status: "Done" });
    const idle = issue(4);
    expect(blockers(mine, board([mine, active, done, idle]))).toEqual([
      "owned paths overlap active #2",
    ]);
    expect(blockers(mine, board([mine, done, idle]))).toEqual([]);
  });

  test("two claims of one issue: once the remote branch exists, the issue is no longer ready", () => {
    const contested = issue(1);
    expect(plan(board([contested])).ready.map((entry) => entry.number)).toEqual([1]);
    expect(
      plan(board([contested], { claimed: new Set([1]) })).ready.map((entry) => entry.number),
    ).toEqual([]);
  });
});

describe("claim rollback", () => {
  for (const preassigned of [true, false]) {
    test(`a rival claim ${preassigned ? "preserves existing" : "removes newly added"} assignment`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "backlog-claim-"));
      try {
        const script = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const git = process.argv[1].endsWith("/git");
const dir = ${JSON.stringify(dir)};
appendFileSync(dir + "/calls", JSON.stringify({ git, args }) + "\\n");
const output = value => console.log(JSON.stringify(value));
if (git) {
  if (args[0] === "ls-remote" && !args.includes("--heads")) console.log("a".repeat(40) + "\\trefs/heads/main");
} else if (args[0] === "repo") {
  output({nameWithOwner:"owner/repo",name:"repo",owner:{login:"owner"}});
} else if (args[0] === "api") {
  if (args[1] === "user") output({login:"jaahuo"});
  else if (args[1] === "graphql") output({data:{repository:{projectsV2:{nodes:[{title:"Board"}]}}}});
  else output({});
} else if (args[0] === "issue" && args[1] === "list" && args.includes("open")) {
  const count = existsSync(dir + "/count") ? Number(readFileSync(dir + "/count", "utf8")) : 0;
  writeFileSync(dir + "/count", String(count + 1));
  const item = (number, assignees) => ({number,title:"Task",body:${JSON.stringify(body("`contexts/offers/**`"))},labels:[],assignees:assignees.map(login=>({login})),projectItems:[]});
  output(count === 0 ? [item(1, ${JSON.stringify(preassigned ? ["Jaahuo"] : [])})] : [item(1, ["Jaahuo"]), item(2, ["rival"])]);
} else if (args[1] === "list") {
  output([]);
}
`;
        await Promise.all(
          ["gh", "git"].map((name) => writeFile(join(dir, name), script, { mode: 0o755 })),
        );
        const child = Bun.spawn(
          [process.execPath, new URL("./backlog.ts", import.meta.url).pathname, "claim", "1"],
          {
            env: { ...process.env, PATH: `${dir}:${process.env["PATH"]}` },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).toBe(3);
        expect(stderr).toContain("#2 was claimed at the same time");
        const calls = (await readFile(join(dir, "calls"), "utf8")).split("\n");
        expect(calls.some((line) => line.includes("--remove-assignee"))).toBe(!preassigned);
        expect(calls.some((line) => line.includes("--add-assignee"))).toBe(!preassigned);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("staggered claims of overlapping issues", () => {
  // After its own ref exists, claim gives way to any overlapping issue that became active
  // since its ready check; these cases pin the board facts that rule reads.
  const first = issue(5, { body: body("`scripts/**`") });
  const second = issue(7, { body: body("`./scripts/backlog.ts`") });

  test("the later claimer sees the earlier claim as an overlapping active issue", () => {
    const later = board([first, second], { claimed: new Set([5, 7]) });
    expect(blockers(second, later)).toContain("owned paths overlap active #5");
    expect(blockers(first, later)).toContain("owned paths overlap active #7");
  });

  test("before either claim, both look ready", () => {
    const before = board([first, second]);
    expect(blockers(first, before)).toEqual([]);
    expect(blockers(second, before)).toEqual([]);
  });
});

describe("plan", () => {
  test("picks demo-critical first, then lower wave, then non-stretch, then oldest (R-04)", () => {
    const issues = [
      issue(5, { labels: ["wave:2"], body: body("`e`") }),
      issue(4, { labels: ["wave:4", "demo-critical"], body: body("`d`") }),
      issue(3, { labels: ["wave:1", "stretch"], body: body("`c`") }),
      issue(2, { labels: ["wave:2"], body: body("`b`") }),
    ];
    expect(plan(board(issues)).ready.map((entry) => entry.number)).toEqual([4, 3, 2, 5]);
  });
});

describe("unreadable ownership", () => {
  test("ownedPaths reads quoted and bare paths on one line", () => {
    const mixed = "## Owns\n\nOwned paths: `contexts/offers/**`, scripts/backlog.ts\n";
    expect(ownedPaths(mixed)).toEqual(["contexts/offers", "scripts/backlog.ts"]);
    const excepted =
      "## Owns\n\nOwned paths: contexts/offers/** (except package.json) and scripts/backlog.ts\n";
    expect(ownedPaths(excepted)).toEqual(["contexts/offers", "scripts/backlog.ts"]);
    expect(
      ownedPaths(
        "## Owns\n\nOwned paths: contexts/offers/** (except package.json and tsconfig.json and README.md)\n",
      ),
    ).toEqual(["contexts/offers"]);
    const mine = issue(1, { body: `${excepted}\n## Acceptance\n\n1. gate.\n` });
    const active = issue(2, { assignees: ["someone"], body: body("`scripts/backlog.ts`") });
    expect(blockers(mine, board([mine, active]))).toEqual(["owned paths overlap active #2"]);
  });

  test("ownedPaths reads comma-separated paths without backticks", () => {
    expect(
      ownedPaths("## Owns\n\nhosts/openwebui/**, scripts/openwebui.ts, DESIGN.md (one part).\n"),
    ).toEqual(["hosts/openwebui", "scripts/openwebui.ts", "DESIGN.md"]);
  });

  test("an active issue with unreadable Owns blocks issues of its area, not others", () => {
    const vague = issue(9, {
      assignees: ["someone"],
      labels: ["area:demo"],
      body: "## Owns\n\nthe host lane\n",
    });
    const sameArea = issue(1, { labels: ["area:demo"] });
    const otherArea = issue(2, { labels: ["area:offers"] });
    const all = board([vague, sameArea, otherArea]);
    expect(overlapping(sameArea, ["x"], all).map((other) => other.number)).toEqual([9]);
    expect(overlapping(otherArea, ["x"], all)).toEqual([]);
  });
});

const note = (login: string, createdAt: string) => ({
  body: `Claimed by agent for @${login} through the backlog loop (remote branch \`task/1\`).`,
  createdAt,
});

describe("stale claims", () => {
  test("loopClaim reads the latest loop claim note and ignores other comments", () => {
    expect(
      loopClaim([
        note("first", "2026-11-14T10:00:00Z"),
        { body: "looks good", createdAt: "2026-11-14T11:00:00Z" },
        note("second", "2026-11-14T12:00:00Z"),
      ]),
    ).toEqual({ login: "second", at: Date.parse("2026-11-14T12:00:00Z") });
    expect(loopClaim([{ body: "manual branch", createdAt: "2026-11-14T10:00:00Z" }])).toBeNull();
  });

  test("a claim is stale after 90 minutes only when nothing was pushed", () => {
    const at = Date.parse("2026-11-14T10:00:00Z");
    expect(isStale(at, at + 89 * 60_000, false)).toBe(false);
    expect(isStale(at, at + 90 * 60_000, false)).toBe(true);
    expect(isStale(at, at + 300 * 60_000, true)).toBe(false);
  });
});
