---
name: add-feature
description: Add or change behavior inside a bounded context, from domain rule to screen. Use for feature tasks in contexts/.
---

# Add a feature

Read `contexts/notes` and [AGENTS.md](../../../AGENTS.md). Agree the task's writable scope and ownership first. Work inward to outward:

1. Add pure domain types and rules returning `Result`, with meaningful rule and regression tests.
2. Add application use cases and ports for storage or external systems. Implement adapters in `infra/`. Generate and commit migrations for schema changes.
3. Add routes to the single `createApi` chain, with options before handler, validation and route tests including relevant error paths. The chain preserves Eden's route types.
4. Read `DESIGN.md` and build the screen using `@app/ui` and theme tokens. Use typed API calls, show errors, and add useful demo seed data.
5. At the integrated end, run the applicable whole-repository checks and gate once. Then follow [verify](../verify/SKILL.md) for the checks that the change needs, including errors. Report what was actually exercised.
6. The task owner commits and follows the [task workflow](../task-workflow/SKILL.md) and [ship skill](../ship/SKILL.md). Assess impact, review evidence and human approval as appropriate.
