import { fail } from "./lib.ts";
import { command, ghJson, option, repository } from "./workflow.ts";
import { cleanMergedWorktree } from "./worktree-cleanup.ts";
import { decodeBoard, decodeDependency, decodeIssue, decodeUser } from "./workflow-decode.ts";

const args = process.argv.slice(2);
const action = args[0];
if (!action || args.includes("--help")) {
  console.log(`Usage:
  bun scripts/task.ts start <issue>
  bun scripts/task.ts status <issue>
  bun scripts/task.ts handoff <issue> --scope owner:path [--scope owner:path ...] --message text
  bun scripts/task.ts sync <issue> --depends-on <merged-pr>
  bun scripts/task.ts finish <issue> --pr <merged-pr>

Start checks your issue assignment (not an atomic lock), creates task/<issue> with
wt, and moves the linked board item to In progress. Handoff records disjoint
writable paths in an issue comment. Sync requires the dependency's actual merge
commit on current main, then merges origin/main into this task branch. Finish
verifies the task PR's merge commit on main, closes the issue, moves it to Done
and removes the clean task worktree, its database and its branch.
Commands use your own gh authentication; project access requires the project scope.
Example: bun scripts/task.ts handoff 12 --scope api:contexts/api --scope web:apps/web --message 'API contract is ready'`);
  process.exit(0);
}
const number = args[1];
if (!number || !/^[1-9]\d*$/.test(number)) fail("Provide a positive issue number; see --help.");
const repo = await repository();
const issue = await ghJson(
  decodeIssue,
  "issue",
  "view",
  number,
  "--json",
  "state,title,url,assignees",
);

async function boardStatus(update?: string, add = false): Promise<string> {
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){projectsV2(first:100){nodes{id}} issue(number:$number){id projectItems(first:100){nodes{id project{id title fields(first:100){nodes{... on ProjectV2FieldCommon{id name} ... on ProjectV2SingleSelectField{options{id name}}}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`;
  const repositoryData = await ghJson(
    decodeBoard,
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${repo.owner.login}`,
    "-f",
    `repo=${repo.name}`,
    "-F",
    `number=${number}`,
  );
  const projects = repositoryData.projectsV2.nodes;
  if (projects.length !== 1 || !projects[0])
    fail("Repository must be linked to exactly one project board.");
  const project = projects[0];
  const items = repositoryData.issue.projectItems.nodes.filter(
    (item) => item.project.id === project.id,
  );
  if (items.length === 0 && add) {
    const mutation = `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`;
    await command(
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `project=${project.id}`,
      "-f",
      `content=${repositoryData.issue.id}`,
    );
    return boardStatus(update);
  }
  if (items.length !== 1)
    fail("Issue is not on the linked project board; start the task or add it first.");
  const item = items[0];
  if (!item) fail("Board item missing.");
  if (update) {
    const field = item.project.fields.nodes.find((node) => node?.name === "Status");
    const choice = field?.options?.find(
      (entry) => entry.name.toLowerCase() === update.toLowerCase(),
    );
    if (!field || !choice) fail(`Project ${item.project.title} has no Status option '${update}'.`);
    const mutation = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`;
    await command(
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `project=${item.project.id}`,
      "-f",
      `item=${item.id}`,
      "-f",
      `field=${field.id}`,
      "-f",
      `option=${choice.id}`,
    );
    return choice.name;
  }
  return item.fieldValueByName?.name ?? "unset";
}

if (action === "status") {
  console.log(
    `#${number} ${issue.title} (${issue.state})\n${issue.url}\nAssignees: ${issue.assignees.map((user) => user.login).join(", ") || "none"}\nBoard: ${await boardStatus()}`,
  );
} else if (action === "start") {
  const user = await ghJson(decodeUser, "api", "user");
  if (
    issue.state !== "OPEN" ||
    !issue.assignees.some((entry) => entry.login.toLowerCase() === user.login.toLowerCase())
  )
    fail(
      "An open issue must already be assigned to the authenticated user. Assignment is not a lock.",
    );
  await boardStatus(undefined, true);
  await command("git", "fetch", "origin", "main");
  await command("wt", "switch", "--create", `task/${number}`, "--base", "origin/main");
  await boardStatus("In progress");
  console.log(
    `Started task/${number}; assignment is not an exclusive claim. Navigate with: wt switch task/${number}`,
  );
} else if (action === "handoff") {
  const scopes: { owner: string; path: string }[] = [];
  for (let index = 2; index < args.length; index++) {
    if (args[index] !== "--scope") continue;
    const match = /^([A-Za-z0-9_-]+):([A-Za-z0-9_./-]+)$/.exec(args[++index] ?? "");
    const owner = match?.[1];
    const path = match?.[2]?.replace(/\/$/, "");
    if (
      !owner ||
      !path ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail("Scopes must be owner:relative/path without traversal.");
    scopes.push({ owner, path });
  }
  if (!scopes.length) fail("Provide at least one --scope owner:path.");
  for (const [index, scope] of scopes.entries())
    for (const other of scopes.slice(index + 1)) {
      if (
        scope.path === other.path ||
        scope.path.startsWith(`${other.path}/`) ||
        other.path.startsWith(`${scope.path}/`)
      )
        fail("Writable scopes must be disjoint.");
    }
  const message = option(args, "--message");
  if (!message) fail("Provide --message with the handoff details.");
  const body = `Task handoff (task owner retains Git and merge authority):\n\n${scopes.map((scope) => `- ${scope.owner}: \`${scope.path}\``).join("\n")}\n\n${message}`;
  await command("gh", "issue", "comment", number, "--body", body);
  console.log(`Handoff recorded on #${number}.`);
} else if (action === "sync") {
  const dependency = option(args, "--depends-on");
  if (!dependency || !/^[1-9]\d*$/.test(dependency)) fail("Provide --depends-on <merged-pr>.");
  const branch = await command("git", "branch", "--show-current");
  if (branch !== `task/${number}`) fail(`Run sync from task/${number}.`);
  if (await command("git", "status", "--porcelain"))
    fail("Commit or stash your changes before syncing.");
  const pr = await ghJson(
    decodeDependency,
    "api",
    `repos/${repo.nameWithOwner}/pulls/${dependency}`,
  );
  if (!pr.merged || !pr.merge_commit_sha || pr.base.ref !== "main")
    fail("Dependency PR must be merged into main.");
  await command("git", "fetch", "origin", "main");
  await command("git", "merge-base", "--is-ancestor", pr.merge_commit_sha, "origin/main");
  await command("git", "merge", "--no-edit", "origin/main");
  console.log(`Synced main including merge commit ${pr.merge_commit_sha}.`);
} else if (action === "finish") {
  const numberPr = option(args, "--pr");
  if (!numberPr || !/^[1-9]\d*$/.test(numberPr)) fail("Provide --pr <merged-pr>.");
  const pr = await ghJson(decodeDependency, "api", `repos/${repo.nameWithOwner}/pulls/${numberPr}`);
  if (
    !pr.merged ||
    !pr.merge_commit_sha ||
    pr.base.ref !== "main" ||
    pr.head.ref !== `task/${number}`
  )
    fail(`PR must be merged from task/${number} into main.`);
  await command("git", "fetch", "origin", "main");
  await command("git", "merge-base", "--is-ancestor", pr.merge_commit_sha, "origin/main");
  await boardStatus();
  if (issue.state !== "CLOSED") await command("gh", "issue", "close", number);
  await boardStatus("Done");
  console.log(`Finished #${number} from merged PR #${numberPr}.`);
  await cleanMergedWorktree(
    `task/${number}`,
    pr.head.sha,
    `bun run task finish ${number} --pr ${numberPr}`,
  );
} else fail("Unknown task command; see --help.");
