---
name: writing-technical-docs
description: Write or revise repository documentation for setup, architecture, technical decisions, API behavior, and repeatable operational procedures. Use for README changes, docs pages, and runbooks. For agent instructions or skills, use writing-for-agents.
---

# Writing technical docs

Write for a maintainer who needs to make a decision or complete a task.
Use [writing-simplified-technical-english](../writing-simplified-technical-english/SKILL.md) for prose.

## Establish the contract

1. Identify the reader, their question, and the document's scope from the request and existing docs.
2. Read the relevant implementation, configuration, and current documentation. Record the source for each operational claim.
3. Ask only when a missing decision changes the scope, safety, or intended behavior. Use the host's question tool when available.
4. Choose the structure below. Keep existing document locations and conventions. Put new repository docs in `docs/`.

## Choose the structure

### Setup or system explanation

State what the system does and how its parts connect.
Name prerequisites, configuration sources, and environment differences that affect the reader.
Link to the authoritative scripts and configuration instead of copying volatile lists.
Give a minimal setup path and an observable success condition.
Separate current behavior from proposed changes.

### Technical decision

State the problem, constraints, decision, alternatives, and consequences.
Explain why the rejected alternatives fail the constraints.
Identify the affected context, HTTP contracts, stored data, and shared packages where relevant.
Record whether the decision is proposed or accepted. Do not imply approval without evidence.

### API behavior

Use the API types, routes, or supplied specification as the contract source.
Explain prerequisites, authentication, expected failures, and an example request and response.
Label synthetic examples. Keep credentials out of examples.
Distinguish intended behavior from behavior observed in a test.
Link to generated reference material rather than maintaining a second full schema.

### Repeatable procedure or runbook

State the trigger, operator, access requirements, working directory, and target environment.
Put impact warnings and approval requirements before the affected command.
Use numbered steps. Give each step an observable result and a stop condition when failure would make the next step unsafe.
Identify commands that change or delete data. Scope them to an explicit target.
Include recovery steps and final verification. If recovery is not possible, state that before the destructive step and require approval.
Keep credentials in the approved secret store or ignored environment files. Document variable names, not values.

## Verify and deliver

- Preserve facts, uncertainty, conditions, numbers, and units when rewriting. Mark unresolved facts as unknown instead of inventing values.
- Check relative links and command names against the repository. Run safe documented commands when possible.
- Use a disposable target for mutating examples. Request approval before a destructive verification or external publication.
- Report commands you actually ran and their results. State what remains unverified.
- Remove empty sections, repeated explanations, and unresolved drafting markers before presenting a document as complete.
- Update the existing authoritative page when behavior changes. Link to it from the README when a reader needs an entry point.

Completion: the reader can answer the stated question or execute the procedure, identify success, and handle the documented failure paths.
