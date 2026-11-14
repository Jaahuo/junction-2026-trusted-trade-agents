import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { err, ok, type Result } from "@app/kernel";
import { env } from "@app/server-kit";
import type { SkillPack } from "../application/skills.ts";
import { SKILL_FILES, SKILL_NAME, type SkillFile } from "../domain/skill.ts";

// The compiled production binary finds the repo files through APP_ROOT.
const defaultDir = () =>
  resolve(env("APP_ROOT") ?? resolve(import.meta.dir, "../../../.."), "skills", SKILL_NAME);

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** The YAML block between the leading `---` lines of a SKILL.md; its `name` must be the skill's name. */
export const parseFrontmatter = (
  text: string,
): Result<Record<string, unknown>, "INVALID_SKILL"> => {
  const block = FRONTMATTER.exec(text)?.[1];
  if (block === undefined) return err("INVALID_SKILL");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(block);
  } catch {
    return err("INVALID_SKILL");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("INVALID_SKILL");
  }
  const frontmatter = Object.fromEntries(Object.entries(parsed));
  return frontmatter["name"] === SKILL_NAME ? ok(frontmatter) : err("INVALID_SKILL");
};

export const fsSkillPack = (dir: () => string = defaultDir): SkillPack => ({
  snapshot: async () => {
    let files: SkillFile[];
    try {
      const root = dir();
      files = await Promise.all(
        SKILL_FILES.map(async (name) => {
          const bytes = await Bun.file(resolve(root, name)).bytes();
          return { name, bytes, digest: sha256(bytes), size: bytes.byteLength };
        }),
      );
    } catch {
      return err("UNAVAILABLE");
    }
    const main = files.find(({ name }) => name === "SKILL.md");
    if (main === undefined) return err("INVALID_SKILL");
    const frontmatter = parseFrontmatter(new TextDecoder().decode(main.bytes));
    return frontmatter.ok ? ok({ frontmatter: frontmatter.value, files }) : frontmatter;
  },
});
