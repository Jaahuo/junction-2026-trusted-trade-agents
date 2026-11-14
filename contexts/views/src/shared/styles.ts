import { css, unsafeCSS } from "lit";
import skin from "@app/ui/skin.css?raw";
import parts from "@app/ui/parts.css?raw";

const tokens = unsafeCSS(skin);
const sharedParts = unsafeCSS(parts);

// Shared building blocks of every view: text styles, buttons, chips, fields and states.
export const base = css`
  ${tokens}
  ${sharedParts}
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
    letter-spacing: var(--letter-spacing-label);
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
  .chip:focus-visible,
  .field:focus-visible,
  .toggle:focus-visible {
    outline: var(--size-focus-outline) solid var(--color-border-brand);
    outline-offset: var(--spacing-2xs);
  }
  .chip {
    padding: var(--spacing-sm) var(--spacing-md);
    border: var(--border-width-default) solid var(--color-border-strong);
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
    border: var(--border-width-default) solid var(--color-border-strong);
    border-radius: var(--border-radius-md);
    background: var(--color-white);
    color: var(--color-text);
    font: inherit;
  }
  .message {
    padding: var(--spacing-md) var(--spacing-lg);
    border: var(--border-width-default) solid var(--color-border);
    border-radius: var(--border-radius-md);
    background: var(--color-bg-brand-subtle);
    font-size: var(--font-size-xs);
    line-height: 1.25;
  }
  .message.danger {
    background: var(--color-bg-danger);
    color: var(--color-text-danger);
  }
  .spinner {
    display: inline-block;
    width: var(--spacing-lg);
    height: var(--spacing-lg);
    border: var(--border-width-button) solid currentColor;
    border-right-color: transparent;
    border-radius: var(--radius-full);
    animation: spin 0.8s linear infinite;
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
      transparent 15%,
      var(--shimmer-edge) 35%,
      var(--shimmer-sweep) 50%,
      var(--shimmer-edge) 65%,
      transparent 85%,
      transparent 100%
    );
    background-size: 200vw 100%;
    background-repeat: repeat;
    background-attachment: fixed;
    animation: shimmer 4s linear infinite;
    will-change: background-position;
  }
  /* A shimmer bar along the bottom of a header or strip while something loads. */
  .load-bar {
    --shimmer-base: var(--color-lilac-aimo-strong);
    display: block;
    height: 6px;
  }
  .empty {
    padding: var(--spacing-2xl) var(--spacing-xl);
    border: var(--border-width-default) dashed var(--color-border-strong);
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
