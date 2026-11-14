# Aimo design system

The web app and MCP App views share one Valio Aimo wholesaler skin.
The source of truth is `packages/ui/src/skin.css`.
`parts.css` defines shared buttons and status pills.
`fonts.css` loads the bundled fonts.
`theme.css` imports these files and maps skin tokens to Tailwind utilities.
Its `--text-xs` through `--text-3xl` utilities reference the shared 12–32px type scale.
Its `--spacing` unit references `--spacing-xs`; medium text uses the shared semibold weight.
React components live in `packages/ui/src`; Lit views use the same skin and parts inside shadow DOM.

## Colors

Use semantic tokens instead of raw palette colors.
The lavender surface is an intentional part of the Aimo skin, not a separate theme.

| Token                          | Value       | Use                               |
| ------------------------------ | ----------- | --------------------------------- |
| `--color-bg-brand`             | `#005670`   | Brand backgrounds.                |
| `--color-text-brand`           | `#005670`   | Brand text.                       |
| `--color-heading`              | `#005670`   | Headings.                         |
| `--color-link`                 | `#005670`   | Links.                            |
| `--color-border-brand`         | `#005670`   | Brand borders and focus outline.  |
| `--color-button`               | `#c0e021`   | Primary button fill.              |
| `--color-button-text`          | `#003747`   | Primary button text.              |
| `--color-light-purple-aimo`    | `#eee8f5`   | Lavender skin surface.            |
| `--color-bg-attention`         | `#fff3b0`   | Attention pill background.        |
| `--color-text`                 | `#23282d`   | Main text.                        |
| `--color-text-secondary`       | `#555759`   | Secondary text.                   |
| `--color-text-on-brand`        | `#ffffff`   | Text on brand fills.              |
| `--color-text-on-brand-subtle` | `#d9e6ea`   | Secondary text on brand fills.    |
| `--color-text-warning`         | `#92400e`   | Warning text.                     |
| `--color-text-danger`          | `#b91c1c`   | Error text and danger buttons.    |
| `--color-text-success`         | `#15803d`   | Success text.                     |
| `--color-on-danger`            | `#ffffff`   | Text on danger fills.             |
| `--color-white`                | `#ffffff`   | White surfaces.                   |
| `--color-border`               | `#0000001a` | Borders and dividers.             |
| `--color-border-strong`        | `#818181`   | Strong borders and disabled text. |
| `--color-bg-brand-subtle`      | `#f2f7f8`   | Information background.           |
| `--color-bg-subtle`            | `#f4f4f4`   | Page and neutral backgrounds.     |
| `--color-bg-warning`           | `#fef3c7`   | Warning background.               |
| `--color-bg-success`           | `#eaf8e9`   | Success background.               |
| `--color-bg-danger`            | `#fdedeb`   | Error background.                 |

The web theme maps `background`, `surface`, `foreground`, `muted`, `primary`,
`primary-hover`, `primary-foreground`, `danger`, `success`, and `warning` utilities
to these skin colors. `primary` is the link color; the primary button uses
`--color-button` through the shared `.btn` rules.

## Typography

`fonts.css` bundles Latin WOFF2 files; no external font request is needed.

| Role                    | Font                                              | Weights            |
| ----------------------- | ------------------------------------------------- | ------------------ |
| Body and interface text | Nunito, then system UI sans-serif                 | 400, 600, 700, 800 |
| Headings and buttons    | Barlow Condensed, then Arial Narrow or sans-serif | 400, 600, 700, 800 |

| Size token        | Value |
| ----------------- | ----- |
| `--font-size-2xs` | 12px  |
| `--font-size-xs`  | 14px  |
| `--font-size-sm`  | 16px  |
| `--font-size-md`  | 18px  |
| `--font-size-lg`  | 20px  |
| `--font-size-xl`  | 24px  |
| `--font-size-2xl` | 32px  |

The weight tokens are `regular` 400, `semibold` 600, `bold` 700, and `extrabold` 800.

`--letter-spacing-label` is 0.2px for labels.

## Spacing and shape

| Spacing token   | Value |
| --------------- | ----- |
| `--spacing-2xs` | 2px   |
| `--spacing-xs`  | 4px   |
| `--spacing-sm`  | 8px   |
| `--spacing-md`  | 12px  |
| `--spacing-lg`  | 16px  |
| `--spacing-xl`  | 24px  |
| `--spacing-2xl` | 32px  |

| Shape token              | Value                         | Use                          |
| ------------------------ | ----------------------------- | ---------------------------- |
| `--border-radius-square` | 0px                           | Square surfaces and buttons. |
| `--border-radius-md`     | 5px                           | Standard controls.           |
| `--border-radius-lg`     | 10px                          | Larger rounded surfaces.     |
| `--radius-full`          | 999px                         | Status pills.                |
| `--radius-md`            | `var(--border-radius-md)`     | Tailwind medium radius.      |
| `--radius-xl`            | `var(--border-radius-square)` | Tailwind extra-large radius. |

The default border width, `--border-width-default`, is 1px.

Cards are square. Shared primary, brand, and danger buttons are square.
The shared button minimum height is `--size-button` (44px), its border is
`--border-width-button` (2px).
Buttons use 8px vertical and 24px horizontal padding.
Shared buttons and view fields, chips, and toggles use a solid petrol focus outline.
The outline uses `--color-border-brand` and `--size-focus-outline` (3px), with a 2px offset.

## Buttons and status

Shared buttons use Barlow Condensed, 18px bold uppercase text, and a visible focus outline.
React `Button` supports `primary`, `secondary`, `ghost`, and `danger`.
The shared CSS also provides `brand` for view consumers.
Both React size options, `md` and `sm`, currently use the shared button dimensions.

| Button      | Fill                  | Text                    | Border / shape                  |
| ----------- | --------------------- | ----------------------- | ------------------------------- |
| `primary`   | `--color-button`      | `--color-button-text`   | Square, transparent border.     |
| `secondary` | `--color-white`       | `--color-text-brand`    | Brand border, 5px radius.       |
| `ghost`     | Transparent           | `--color-text-brand`    | Transparent border, 5px radius. |
| `brand`     | `--color-bg-brand`    | `--color-text-on-brand` | Square, transparent border.     |
| `danger`    | `--color-text-danger` | `--color-on-danger`     | Square, transparent border.     |
| Disabled    | `--color-bg-subtle`   | `--color-border-strong` | Transparent border.             |

Pills use 12px bold text, a full radius, and 4px/12px/4px/8px padding.
An unqualified pill uses the attention background and main text.

| Status tone | Background                | Text                   |
| ----------- | ------------------------- | ---------------------- |
| `neutral`   | `--color-bg-subtle`       | `--color-text`         |
| `info`      | `--color-bg-brand-subtle` | `--color-text-brand`   |
| `success`   | `--color-bg-success`      | `--color-text-success` |
| `warning`   | `--color-bg-warning`      | `--color-text-warning` |
| `danger`    | `--color-bg-danger`       | `--color-text-danger`  |

## Components

Import React components from `@app/ui`.
Use the shared components for controls and feedback.

| Component    | Use for                                       | Notes                                                                                |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PageHeader` | Title, description and page actions.          | Use one per screen.                                                                  |
| `Card`       | A group of related content.                   | Add `CardTitle` when it needs a heading.                                             |
| `CardTitle`  | A card heading.                               |                                                                                      |
| `Button`     | Actions.                                      | Variants: `primary`, `secondary`, `ghost`, `danger`. Set `loading` during a request. |
| `Field`      | Label, hint and error around one control.     | Pass the error text in `error`.                                                      |
| `Input`      | One line of text.                             | Wrap in `Field`.                                                                     |
| `Textarea`   | Several lines of text.                        | Wrap in `Field`.                                                                     |
| `Select`     | One choice from a short list.                 | Wrap in `Field`.                                                                     |
| `Table`      | Rows of comparable records.                   | Use `Th` and `Td` for cells.                                                         |
| `Th`         | A header cell.                                |                                                                                      |
| `Td`         | A body cell.                                  |                                                                                      |
| `Badge`      | A status word.                                | Tones: `neutral`, `info`, `success`, `warning`, `danger`.                            |
| `Alert`      | A message that stays on the page.             | Tones: `info`, `success`, `warning`, `danger`. Optional `title`.                     |
| `EmptyState` | A list or screen with no data yet.            | Say what to do next and add an action when needed.                                   |
| `Spinner`    | Loading with no layout to show yet.           | `Button` shows its own.                                                              |
| `Dialog`     | A short task or a confirmation over the page. | Put actions in `footer`, primary action last.                                        |
| `toast`      | Feedback for a finished or failed action.     | Use `toast.success(text)` or `toast.error(text)`.                                    |
| `Toaster`    | Renders toasts.                               | The app shell mounts it once.                                                        |
| `cn`         | Joins class names inside `packages/ui`.       |                                                                                      |

## Views and another wholesaler

Lit views use shadow DOM and share the skin, fonts, and parts with the web app.
View consumers import the same brand data and asset as the web app.
Use visible labels for controls and keep keyboard focus visible.
Use tokens and exposed `part` names for host customization.

To introduce another wholesaler:

1. Replace the values in the single shared `packages/ui/src/skin.css`.
2. Replace the brand name and logo asset referenced by `packages/ui/src/brand.ts`.
3. Keep the web app and view consumers on that shared skin and brand data.
4. Update the tables in this document to match the new skin.

## Guidelines

1. Use one primary action per view. Use secondary or ghost actions for the rest.
2. Confirm destructive actions before they run.
3. Show loading and error states near the action or control.
4. Write short, concrete interface text in sentence case.
5. Give each control a visible label. A placeholder is not a label.
6. Keep forms and focus states usable with a keyboard.
7. Design for a 1000px laptop window first. Avoid horizontal scrolling at 400px.
