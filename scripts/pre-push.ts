import { fail, git } from "./lib.ts";

// Git supplies the destination refs on stdin; reject all direct main updates, including deletion.
const input = await Bun.stdin.text();
for (const line of input.split("\n")) {
  const fields = line.trim().split(/\s+/);
  if (fields[2] === "refs/heads/main")
    fail("Direct pushes to main are forbidden; open a PR with bun run ship.");
  const local = fields[1];
  const remote = fields[3];
  if (
    local &&
    remote &&
    !/^0+$/.test(local) &&
    !/^0+$/.test(remote) &&
    !(await git("merge-base", "--is-ancestor", remote, local)).ok
  ) {
    fail("Non-fast-forward pushes are forbidden; do not force-push task branches.");
  }
}
