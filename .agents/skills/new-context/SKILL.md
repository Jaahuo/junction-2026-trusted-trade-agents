---
name: new-context
description: Create a new bounded context with its own API, UI and tables when a task needs a new feature area.
---

# Create a context

1. Agree ownership and writable scope. Pick a short lowercase plural name, for example `polls`.
2. Run `bun run new:context polls`. It creates `contexts/polls`, a route and a screen at `/polls`, discovered without registration.
3. Add the behavior with the [add-feature skill](../add-feature/SKILL.md), including domain and route regression tests, migrations and demo data where applicable.
4. At the integrated end run applicable whole-repository checks and the gate, then exercise the real flow locally. The task owner commits and follows the [task workflow](../task-workflow/SKILL.md) and [ship skill](../ship/SKILL.md).
