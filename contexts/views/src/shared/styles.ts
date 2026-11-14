import { css } from "lit";

// Design tokens of the views, named as the Figma variables of the Junction 2026 file
// (Screens, Approval request). Update a value here when the design changes. A page can
// override any of them on the element, for example `tt-approval-card { --color-bg-brand: … }`.
const tokens = css`
  :host {
    --color-bg-brand: #005670;
    --color-text-brand: #005670;
    --color-heading: #005670;
    --color-link: #005670;
    --color-border-brand: #005670;
    --color-button: #c0e021;
    --color-button-text: #003747;
    --color-light-purple-aimo: #eee8f5;
    --color-yellow-aimo-soft: #fff3b0;
    /* Lilacs of the loading shimmer: the skeletons, and the deeper loading bars. */
    --color-lilac-aimo: #e2daf5;
    --color-lilac-aimo-strong: #d9d2f5;
    --color-pink-soft: #efd4f2;
    --color-silver: #e9e6f2;
    --color-text: #23282d;
    --color-text-secondary: #555759;
    --color-text-on-brand: #ffffff;
    --color-text-on-brand-subtle: #d9e6ea;
    --color-text-warning: #92400e;
    --color-text-danger: #b91c1c;
    --color-text-success: #15803d;
    --color-white: #ffffff;
    --color-border: #0000001a;
    --color-border-strong: #818181;
    --color-bg-brand-subtle: #f2f7f8;
    --color-bg-subtle: #f4f4f4;
    --color-bg-warning: #fef3c7;
    --color-bg-success: #eaf8e9;
    --color-bg-danger: #fdedeb;
    --spacing-2xs: 2px;
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 12px;
    --spacing-lg: 16px;
    --spacing-xl: 24px;
    --spacing-2xl: 32px;
    --font-size-2xs: 12px;
    --font-size-xs: 14px;
    --font-size-sm: 16px;
    --font-size-xl: 24px;
    --border-radius-md: 5px;
    --border-radius-lg: 10px;
    --radius-full: 999px;
    --shadow-sm: 0 1px 3px 0 rgb(15 23 41 / 0.1), 0 1px 2px 0 rgb(15 23 41 / 0.06);
    /* The fonts are embedded by shared/view-element.ts (@fontsource, latin subset). */
    --font-family-sans: Nunito, system-ui, sans-serif;
    --font-family-condensed: "Barlow Condensed", "Arial Narrow", sans-serif;
  }
`;

// Shared building blocks of every view: text styles, buttons, chips, fields and states.
export const base = css`
  ${tokens}
  :host {
    display: block;
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-sm);
    line-height: 1.28;
  }
  * {
    box-sizing: border-box;
  }
  h2,
  h3,
  h4,
  p,
  ul,
  dl,
  dd {
    margin: 0;
  }
  /* Headings take their size from the type classes, not the browser's 1.5em default. */
  h2,
  h3,
  h4 {
    font-size: inherit;
    font-weight: inherit;
  }
  .label-small {
    font-size: var(--font-size-2xs);
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: 0.2px;
  }
  .body-small {
    font-size: var(--font-size-xs);
    line-height: 1.25;
  }
  .strong {
    font-weight: 600;
  }
  .secondary {
    color: var(--color-text-secondary);
  }
  /* Label/Button: Barlow Condensed bold, 18/24, uppercase. */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    min-height: 2.75rem;
    padding: var(--spacing-md) var(--spacing-xl);
    border: 2px solid transparent;
    border-radius: var(--border-radius-md);
    background: none;
    font-family: var(--font-family-condensed);
    font-size: 18px;
    font-weight: 700;
    line-height: 24px;
    letter-spacing: 0.36px;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
  }
  .btn:focus-visible,
  .chip:focus-visible,
  .field:focus-visible,
  .toggle:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--color-border-brand) 45%, transparent);
    outline-offset: 2px;
  }
  /* Outranks the variant colours; the card keeps a busy primary button lime. */
  .btn:is(.primary, .secondary, .ghost, .brand):disabled,
  .btn:disabled {
    border-color: transparent;
    background: var(--color-bg-subtle);
    color: var(--color-border-strong);
    cursor: not-allowed;
  }
  .btn.primary {
    border-radius: 0;
    background: var(--color-button);
    color: var(--color-button-text);
  }
  .btn.secondary {
    border-color: var(--color-border-brand);
    background: var(--color-white);
    color: var(--color-text-brand);
  }
  .btn.ghost {
    color: var(--color-text-brand);
  }
  /* Filled petrol, square like the primary (Figma v17 Reject). */
  .btn.brand {
    border-radius: 0;
    background: var(--color-bg-brand);
    color: var(--color-text-on-brand);
  }
  .chip {
    padding: var(--spacing-sm) var(--spacing-md);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-full);
    background: var(--color-white);
    color: var(--color-text);
    font: inherit;
    font-size: var(--font-size-xs);
    font-weight: 600;
    line-height: 1.25;
    cursor: pointer;
  }
  .chip[aria-pressed="true"] {
    border-color: var(--color-bg-brand);
    background: var(--color-bg-brand);
    color: var(--color-text-on-brand);
  }
  .field-label {
    display: block;
    margin-bottom: var(--spacing-xs);
    font-size: var(--font-size-xs);
    font-weight: 600;
    line-height: 1.25;
  }
  .field {
    width: 100%;
    padding: var(--spacing-md);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--border-radius-md);
    background: var(--color-white);
    color: var(--color-text);
    font: inherit;
  }
  .message {
    padding: var(--spacing-md) var(--spacing-lg);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius-md);
    background: var(--color-bg-brand-subtle);
    font-size: var(--font-size-xs);
    line-height: 1.25;
  }
  .message.danger {
    color: var(--color-text-danger);
  }
  /* Loading: a silver sheen edged with soft pink sweeps over lilac, no spinners. Always
     aria-hidden.
     The sweep is fixed to the viewport and repeats, so every shimmer moves in step and the
     loop never jumps. A shimmer on a petrol header sets --shimmer-base to translucent white. */
  .shimmer {
    --shimmer-base: var(--color-lilac-aimo);
    --shimmer-sweep: var(--color-silver);
    --shimmer-edge: color-mix(in srgb, var(--color-pink-soft) 80%, transparent);
    background-color: var(--shimmer-base);
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      var(--shimmer-edge) 35%,
      var(--shimmer-sweep) 50%,
      var(--shimmer-edge) 65%,
      transparent 100%
    );
    background-size: 200vw 100%;
    background-repeat: repeat;
    background-attachment: fixed;
    animation: shimmer 2.4s linear infinite;
  }
  /* A shimmer bar along the bottom of a header or strip while something loads. */
  .load-bar {
    --shimmer-base: var(--color-lilac-aimo-strong);
    display: block;
    height: 6px;
  }
  .empty {
    padding: var(--spacing-2xl) var(--spacing-xl);
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--border-radius-lg);
    text-align: center;
  }
  a {
    color: var(--color-link);
    font-weight: 600;
  }
  /* Exactly one gradient width per loop, so the end matches the start. */
  @keyframes shimmer {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 200vw 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer {
      animation: none;
    }
  }
  }
`;
