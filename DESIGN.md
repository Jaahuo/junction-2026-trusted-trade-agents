# Junction 2026 design system

Read this before you build or change a screen.
The tokens live in `packages/ui/src/theme.css` and the components in `packages/ui/src`.
A test fails when this file and those two sources disagree.

## Colors

Use the token class, never a raw palette color such as `bg-blue-500`.
To rebrand the app, change the values in `theme.css` and in this table.

| Token                        | Value                    | Class examples                   | Use for                                                 |
| ---------------------------- | ------------------------ | -------------------------------- | ------------------------------------------------------- |
| `--color-background`         | `oklch(0.985 0.002 250)` | `bg-background`                  | Page background.                                        |
| `--color-surface`            | `oklch(1 0 0)`           | `bg-surface`                     | Cards, inputs, dialogs, the top bar.                    |
| `--color-foreground`         | `oklch(0.21 0.02 260)`   | `text-foreground`                | Main text.                                              |
| `--color-muted`              | `oklch(0.52 0.02 260)`   | `text-muted`                     | Secondary text, hints, table headers.                   |
| `--color-border`             | `oklch(0.91 0.01 260)`   | `border-border`, `divide-border` | Every border and divider.                               |
| `--color-primary`            | `oklch(0.5 0.2 265)`     | `bg-primary`, `text-primary`     | The one main action per view, active navigation, links. |
| `--color-primary-hover`      | `oklch(0.44 0.2 265)`    | `hover:bg-primary-hover`         | Hover state of primary.                                 |
| `--color-primary-foreground` | `oklch(0.99 0 0)`        | `text-primary-foreground`        | Text on primary and danger fills.                       |
| `--color-danger`             | `oklch(0.55 0.21 27)`    | `text-danger`, `bg-danger`       | Errors and destructive actions.                         |
| `--color-success`            | `oklch(0.55 0.14 155)`   | `text-success`                   | Confirmed, healthy, done.                               |
| `--color-warning`            | `oklch(0.7 0.15 75)`     | `bg-warning/20`                  | Needs attention, not broken.                            |

Tints use opacity on a token, for example `bg-primary/10` or `border-danger/40`.

## Typography

One font: the Tailwind default sans stack (system UI font).
Do not add a web font without updating this file.

| Role                 | Classes                                 | Where                                  |
| -------------------- | --------------------------------------- | -------------------------------------- |
| Page title           | `text-2xl font-semibold tracking-tight` | `PageHeader` only, one per screen.     |
| Section title        | `text-lg font-semibold`                 | `CardTitle`, dialog title.             |
| Body                 | default size, normal weight             | Content and list rows.                 |
| Label and small text | `text-sm`, labels add `font-medium`     | `Field` labels, hints, tables, alerts. |
| Badge                | `text-xs font-medium`                   | `Badge` only.                          |

## Spacing

Use the Tailwind 4 px scale.
Arbitrary values such as `p-[13px]` are lint errors.

| Where                           | Value                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| Page container                  | `max-w-4xl px-6 py-8`, set by the app shell. Screens do not set their own. |
| Between cards and sections      | `gap-4`                                                                    |
| Inside a card                   | `p-5`, set by `Card`.                                                      |
| Between a label and its control | `gap-1.5`, set by `Field`.                                                 |
| Between controls in a row       | `gap-2`                                                                    |
| Control height                  | `h-10`, small buttons `h-8`.                                               |

## Shape

| Token         | Value     | Class        | Use for                                    |
| ------------- | --------- | ------------ | ------------------------------------------ |
| `--radius-md` | `0.5rem`  | `rounded-md` | Buttons, inputs, alerts, navigation items. |
| `--radius-xl` | `0.75rem` | `rounded-xl` | Cards, tables, dialogs, empty states.      |

Badges are `rounded-full`.
Use no other radius.

## Components

Import every component from `@app/ui`.
Raw `<button>`, `<input>`, `<textarea>`, `<select>`, `<dialog>` and `<table>` in a screen are lint errors.
On a component, `className` may only change layout (width, margin, flex, grid).
If a component or variant is missing, add it to `packages/ui` and to this table in its own commit.

| Component    | Use for                                              | Notes                                                                                                       |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PageHeader` | Title, one-line description and page actions.        | First element of every screen.                                                                              |
| `Card`       | A group of related content.                          | Add `CardTitle` when the card needs a heading.                                                              |
| `CardTitle`  | The heading of a card.                               |                                                                                                             |
| `Button`     | Every action.                                        | Variants: `primary`, `secondary`, `ghost`, `danger`. Sizes: `md`, `sm`. Set `loading` while a request runs. |
| `Field`      | Label, hint and error around one control.            | Pass the error text in `error`.                                                                             |
| `Input`      | One line of text.                                    | Wrap in `Field`.                                                                                            |
| `Textarea`   | Several lines of text.                               | Wrap in `Field`.                                                                                            |
| `Select`     | One choice from a short list.                        | Wrap in `Field`.                                                                                            |
| `Table`      | Rows of comparable records.                          | Use `Th` and `Td` for cells.                                                                                |
| `Th`         | A header cell.                                       |                                                                                                             |
| `Td`         | A body cell.                                         |                                                                                                             |
| `Badge`      | A status word.                                       | Tones: `neutral`, `info`, `success`, `warning`, `danger`.                                                   |
| `Alert`      | A message that stays on the page.                    | Same tones as `Badge` except `neutral`. Optional `title`.                                                   |
| `EmptyState` | A list or screen with no data yet.                   | Say what to do next, and add the action when there is one.                                                  |
| `Spinner`    | Loading with no layout to show yet.                  | `Button` shows its own.                                                                                     |
| `Dialog`     | A short task or a confirmation over the page.        | Put the actions in `footer`, primary action last.                                                           |
| `toast`      | Feedback for an action that just finished or failed. | `toast.success(text)` and `toast.error(text)`.                                                              |
| `Toaster`    | Renders toasts.                                      | Mounted once by the app shell. Do not add another.                                                          |
| `cn`         | Joins class names inside `packages/ui`.              |                                                                                                             |

## Elevation

The interface is flat.
Borders separate surfaces, shadows only lift what floats.

| Level    | Class       | Use for                                  |
| -------- | ----------- | ---------------------------------------- |
| Flat     | none        | Page, top bar, inputs, tables.           |
| Raised   | `shadow-sm` | `Card`.                                  |
| Floating | `shadow-xl` | `Dialog`, over a `bg-black/40` backdrop. |

## Views

MCP App views in `contexts/views` follow the Junction 2026 Figma file (Screens, "Approval request"), not the tables above. They are Lit web components with shadow DOM, so one element works in a chat host, the web app and any other framework.

- Tokens: `contexts/views/src/shared/styles.ts`, named as the Figma variables (`--color-bg-brand`, `--spacing-xl` and so on). Change a value there when the design changes.
- Fonts: Nunito (text) and Barlow Condensed (buttons), embedded as WOFF2 by `contexts/views/src/shared/fonts.ts`. A view loads no external font.
- Shared parts: buttons (`.btn primary|secondary|ghost`), chips, fields, messages, spinner and empty state in the same file.
- Native `<button>` and `<input>` are allowed inside a view's shadow DOM. Give each control a visible label.
- A host page restyles a view through the tokens on the element or through its `part` names, never by reaching into the shadow DOM.
- The Figma file is the source of truth. Its newest iteration is the current design.

## Guidelines

1. Each view has one `primary` button. Every other action is `secondary` or `ghost`.
2. Destructive actions use `danger` and ask for confirmation in a `Dialog`.
3. Every request shows its state: `loading` on the button, `Spinner` or `EmptyState` in the list, and the error next to its cause.
4. Show a validation error in the `Field` it belongs to. Show a failed action with `toast.error`. Never show a raw error code.
5. Write interface text in sentence case, short and concrete: "Add note", not "Submit".
6. Every control has a visible label through `Field`. A placeholder is not a label.
7. Keep the keyboard working: forms submit on Enter, and the focus ring stays visible.
8. Do not use inline styles, arbitrary values or colors outside the token table.
9. Design for a 1000 px wide laptop window first. Nothing may scroll sideways at 400 px.
