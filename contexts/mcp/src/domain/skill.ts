export const SKILL_NAME = "trusted-trade-ordering";
export const SKILL_FILES = ["SKILL.md", "reason-codes.md"] as const;
type SkillFileName = (typeof SKILL_FILES)[number];

export const skillUri = (file: string): string => `skill://${SKILL_NAME}/${file}`;

/** One file of the skill with its raw bytes, the `sha256:<hex>` digest of the bytes and their length. */
export interface SkillFile {
  readonly name: SkillFileName;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly size: number;
}

/** The skill files and the parsed YAML frontmatter of its SKILL.md. */
export interface SkillSnapshot {
  readonly frontmatter: Record<string, unknown>;
  readonly files: readonly SkillFile[];
}

/** One entry of the MCP Skills extension: the SKILL.md uri, its frontmatter and the complete file manifest. */
export interface SkillEntry {
  readonly uri: string;
  readonly frontmatter: Record<string, unknown>;
  readonly resources: readonly { uri: string; digest: string; size: number }[];
}

export const skillEntry = ({ frontmatter, files }: SkillSnapshot): SkillEntry => ({
  uri: skillUri("SKILL.md"),
  frontmatter,
  resources: files.map(({ name, digest, size }) => ({ uri: skillUri(name), digest, size })),
});
