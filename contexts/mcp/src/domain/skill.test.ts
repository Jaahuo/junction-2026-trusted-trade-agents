import { expect, test } from "bun:test";
import { skillEntry } from "./skill.ts";

const file = (name: "SKILL.md" | "reason-codes.md", size: number) => ({
  name,
  bytes: new Uint8Array(size),
  digest: `sha256:${name}`,
  size,
});

test("skillEntry lists every file with its digest and size, SKILL.md first as the entry uri", () => {
  expect(
    skillEntry({
      frontmatter: { name: "trusted-trade-ordering" },
      files: [file("SKILL.md", 3), file("reason-codes.md", 5)],
    }),
  ).toEqual({
    uri: "skill://trusted-trade-ordering/SKILL.md",
    frontmatter: { name: "trusted-trade-ordering" },
    resources: [
      { uri: "skill://trusted-trade-ordering/SKILL.md", digest: "sha256:SKILL.md", size: 3 },
      {
        uri: "skill://trusted-trade-ordering/reason-codes.md",
        digest: "sha256:reason-codes.md",
        size: 5,
      },
    ],
  });
});
