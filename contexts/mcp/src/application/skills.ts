import type { Result } from "@app/kernel";
import {
  type SkillEntry,
  type SkillFile,
  type SkillSnapshot,
  skillEntry,
} from "../domain/skill.ts";

/** The skill's files with digests, and its parsed frontmatter. */
export interface SkillPack {
  snapshot(): Promise<Result<SkillSnapshot, "UNAVAILABLE" | "INVALID_SKILL">>;
}

export interface LoadedSkill {
  readonly entry: SkillEntry;
  readonly files: readonly SkillFile[];
}

export const loadSkill = async (
  pack: SkillPack,
): Promise<Result<LoadedSkill, "UNAVAILABLE" | "INVALID_SKILL">> => {
  const snapshot = await pack.snapshot();
  if (!snapshot.ok) return snapshot;
  return { ok: true, value: { entry: skillEntry(snapshot.value), files: snapshot.value.files } };
};
