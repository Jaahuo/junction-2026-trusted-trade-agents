# Agent writing skills

**Last updated:** 2026-11-14

This page covers the repository's writing skills, their sources, and their maintenance.
It assumes familiarity with the active agent host. It does not define that host's installation or invocation behavior.

## Choose a skill

| Skill                                                                                                   | Use it for                                                                          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [writing-for-agents](../.agents/skills/writing-for-agents/SKILL.md)                                     | Skills, agent instructions, and documents that agents consume.                      |
| [writing-simplified-technical-english](../.agents/skills/writing-simplified-technical-english/SKILL.md) | Clear reports, technical prose, error messages, and instructions.                   |
| [writing-technical-docs](../.agents/skills/writing-technical-docs/SKILL.md)                             | Setup, architecture, technical decisions, API behavior, and operational procedures. |

The canonical files live in `.agents/skills/`.
The existing `.claude/skills` symlink exposes the same files to Claude Code.
A host must discover these files before it can use their descriptions to select a skill.
If a running session does not list a new skill, reload its skill discovery or start a new session.
You can also direct the agent to read the linked `SKILL.md` file.
A skill does not grant permission to publish, delete data, or bypass the repository workflow.

## Public sources and licenses

### Agent-facing writing

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills/tree/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/productivity/writing-for-agents) at revision `5863806dd4e15c63174bee4e7515a4256792ecfa`.
The import includes `SKILL.md` and `SKILL-MECHANICS.md`.
The local adaptation identifies invocation settings that depend on the host.
The [MIT license and Matt Pocock's copyright notice](../.agents/skills/writing-for-agents/LICENSE) remain with the skill.

### Simplified Technical English

Adapted from [PostHog/skills](https://github.com/PostHog/skills/tree/f87c8afca37db929d41461026f35388cef7306e1/skills/omnibus/writing-simplified-technical-english) at revision `f87c8afca37db929d41461026f35388cef7306e1`.
The import includes the two reference files linked from `SKILL.md`.
The local adaptation replaces upstream house style with repository conventions and preserves uncertainty in rewrite examples.
The reference credits [danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill/tree/d5caf54905eac776e9bb3a247be84153701ff4f8).
The [license file](../.agents/skills/writing-simplified-technical-english/LICENSE) retains both MIT notices, including Dustin Yuchen Teng's copyright notice.
This skill supports clear writing. It does not certify compliance with ASD-STE100 or include its approved dictionary.

`writing-technical-docs` is repository-authored and uses the repository's license.

## Maintenance

These are adapted local skills, not unmodified package-manager installs.
Their pinned provenance lives on this page; `skills-lock.json` continues to track skills managed by the skills installer.
When updating an import, compare it with the pinned public revision, retain license notices, and preserve the listed local adaptations.
Check the content for organization-specific accounts, domains, paths, credentials, and host-only tools before sharing it.
Check frontmatter, linked files, and discovery through the existing skill symlink.
Exercise changed guidance with a bounded writing task. Inspect whether the output preserves facts and reaches a checkable completion condition.
