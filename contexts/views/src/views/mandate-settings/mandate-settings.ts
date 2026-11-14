import { brand } from "@app/ui/brand";
import { formatMoney, formatQuantity, formatTimestamp, ORDER_TERMS } from "@app/ui/format";
import { css, html } from "lit";
import { plainPageUrl, type ViewData, type ViewEntryOf, viewEntry } from "../../shared/bridge.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { loadMandate } from "./loader.ts";
import {
  categoriesText,
  effectiveStatus,
  expiryDelay,
  policyText,
  substitutionText,
  thresholdText,
} from "./presentation.ts";

const row = (label: string, value: string) =>
  html`<div class="row">
    <dt>${label}</dt>
    <dd>${value}</dd>
  </div>`;

class MandateSettings extends ViewElement<ViewEntryOf<"mandate-settings">> {
  static override styles = [
    base,
    css`
      .card {
        border: 1px solid var(--color-border);
        background: var(--color-white);
        overflow: hidden;
      }
      .header {
        background: var(--color-bg-brand);
        color: var(--color-text-on-brand);
        padding: var(--spacing-xl);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        color: var(--color-text-on-brand-subtle);
      }
      .logo {
        display: inline-flex;
      }
      .title {
        font-family: var(--font-family-condensed);
        font-size: var(--font-size-xl);
        font-weight: 700;
        margin-top: var(--spacing-lg);
      }
      .body {
        display: grid;
        gap: var(--spacing-xl);
        padding: var(--spacing-xl);
      }
      .status {
        padding: var(--spacing-md);
        background: var(--color-bg-brand-subtle);
      }
      .status.inactive {
        background: var(--color-bg-warning);
      }
      section {
        display: grid;
        gap: var(--spacing-md);
      }
      h3 {
        color: var(--color-heading);
        font-weight: 700;
      }
      dl {
        display: grid;
        gap: var(--spacing-md);
      }
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
        gap: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--spacing-sm);
      }
      dt {
        color: var(--color-text-secondary);
      }
      dd,
      li {
        overflow-wrap: anywhere;
      }
      ul {
        padding-left: var(--spacing-xl);
      }
      details {
        overflow-wrap: anywhere;
      }
      summary {
        cursor: pointer;
        color: var(--color-link);
        font-weight: 700;
      }
      details dl {
        margin-top: var(--spacing-md);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
      }
      @media (max-width: 400px) {
        .row {
          grid-template-columns: 1fr;
          gap: var(--spacing-xs);
        }
      }
    `,
  ];

  readonly entry = viewEntry("mandate-settings");
  private expiryTimer: number | undefined;
  private renderedStatus: "active" | "expired" | "revoked" | null = null;

  override connectedCallback() {
    // The shared shell loads on connect; this view must distinguish the current endpoint's 404.
    const source = this.source;
    this.source = null;
    super.connectedCallback();
    this.source = source;
    if (source !== null) void this.reload(false);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.expiryTimer);
  }

  override updated() {
    clearTimeout(this.expiryTimer);
    const state = this.state;
    if (!this.isConnected || state.kind !== "done" || this.renderedStatus === null) return;
    const delay = expiryDelay(state.data.mandate.exp, this.renderedStatus);
    if (delay !== null) this.expiryTimer = window.setTimeout(() => this.requestUpdate(), delay);
  }

  private async reload(retry: boolean) {
    const source = this.source;
    if (source === null) return;
    this.state = { kind: "loading" };
    this.state = await loadMandate(source, retry);
  }

  private header() {
    return html`<header class="header" part="header">
      <div class="brand">
        <img class="logo" src=${brand.logo} alt=${brand.name} /><span>Agent settings</span>
      </div>
      <h2 class="title">Agent limits</h2>
    </header>`;
  }

  override render() {
    const state = this.state;
    if (state.kind === "done") return this.renderDone(state.data);
    return html`<article class="card" part=${state.kind}>
      ${this.header()}
      <div class="body">
        ${
          state.kind === "loading"
            ? html`<p role="status">
                <span class="spinner" aria-hidden="true"></span> Loading agent limits…
              </p>`
            : state.kind === "empty"
              ? html`<section>
                  <h3>No current mandate</h3>
                  <p>
                    The agent has no current authority to place orders. Ask an approver to set up a
                    mandate.
                  </p>
                </section>`
              : html`<section role="alert">
                  <h3>Agent limits could not be loaded</h3>
                  <p>Try again or open the limits page.</p>
                  <div class="actions">
                    <button class="btn primary" @click=${() => this.reload(true)}>Try again</button
                    ><a
                      class="btn ghost"
                      href=${plainPageUrl("mandate-settings", document.querySelector<HTMLMetaElement>('meta[name="tt-base-url"]')?.content ?? location.origin) ?? "/views/mandate-settings"}
                      target="_blank"
                      rel="noreferrer"
                      >Open limits page</a
                    >
                  </div>
                </section>`
        }
      </div>
    </article>`;
  }

  protected override renderDone(record: ViewData<"mandate-settings">) {
    const { mandate } = record;
    const { limits, standingConstraints } = mandate;
    const status = effectiveStatus(record);
    this.renderedStatus = status;
    const hard = standingConstraints.hard;
    const soft = standingConstraints.soft;
    return html`<article class="card" part="done">
      ${this.header()}
      <div class="body">
        <div class="status ${status === "active" ? "" : "inactive"}" part="status">
          <p class="strong">
            ${status === "active" ? "Active" : status === "revoked" ? "Revoked" : "Expired"} ·
            Version ${mandate.version}
          </p>
          <p>
            ${status === "active" ? "Automatic placement is subject to these limits and other fixed checks." : "No current authority: these historical limits are not in force and cannot authorize orders."}
          </p>
        </div>
        ${status === "active" ? html`` : html`<h3>Previous limits and policies</h3>`}
        <section>
          <h3>Order limits</h3>
          <dl>
            ${row(ORDER_TERMS.limit, `${formatMoney(limits.maxOrderTotal.value, limits.maxOrderTotal.currency, limits.maxOrderTotal.basis)} per order, including VAT and deposits. At or below this limit, automatic placement is allowed subject to other checks; above it, approval is required.`)}
            ${row("Categories", `${categoriesText(limits.categories)}. ${limits.categories === null ? "All categories are eligible for automatic placement, subject to other checks." : limits.categories.length === 0 ? "No categories are eligible for automatic placement; approval is required." : "Listed categories are eligible for automatic placement, subject to other checks; other categories require approval."}`)}
            ${row("Substitutions", substitutionText(limits.substitutions))}
            ${row("Products not previously ordered by this customer", policyText(limits.newProducts))}
          </dl>
        </section>
        <section>
          <h3>Product data</h3>
          <dl>
            ${row("Minimum delivery reliability", `${thresholdText(limits.minDeliveryReliability, (value) => new Intl.NumberFormat("en-FI", { style: "percent", maximumFractionDigits: 4 }).format(value))} ${limits.minDeliveryReliability === null ? "" : "At or above the minimum, automatic placement is allowed subject to other checks; below it, approval is required."}`)}
            ${row("Maximum estimated CO₂-equivalent per kg", `${thresholdText(limits.maxCo2PerKg, (value) => `${formatQuantity({ value, unit: "KGM" })} CO₂-eq per kg`)} ${limits.maxCo2PerKg === null ? "" : "At or below the maximum, automatic placement is allowed subject to other checks; above it, approval is required."}`)}
            ${row("Missing allergen data", `${policyText(limits.allergenData.ifNoData)} when an allergen constraint is unknown. Contradicted or missing matches still require approval.`)}
          </dl>
        </section>
        <section>
          <h3>Payment terms</h3>
          <dl>
            ${row("Invoice", policyText(limits.paymentTerms.invoice))}
            ${row(ORDER_TERMS.paymentOnOrder, policyText(limits.paymentTerms.pay_on_order))}
          </dl>
        </section>
        <section>
          <h3>Standing constraints</h3>
          <p class="strong">Required</p>
          ${
            hard.length === 0
              ? html`<p>None</p>`
              : html`<ul>
                  ${hard.map(() => html`<li>Free from lactose</li>`)}
                </ul>`
          }
          <p class="strong">Preferred</p>
          ${
            soft.length === 0
              ? html`<p>None</p>`
              : html`<ul>
                  ${soft.map((item) => html`<li>${item.attribute === "countryOfOrigin" ? "Country of origin" : item.attribute === "category" ? "Category" : item.attribute}: ${item.prefer}</li>`)}
                </ul>`
          }
        </section>
        <section>
          <h3>Validity</h3>
          <dl>
            ${row("Issued", formatTimestamp(new Date(mandate.iat * 1000).toISOString()))}${row("Expires", formatTimestamp(new Date(mandate.exp * 1000).toISOString()))}
          </dl>
        </section>
        <p class="secondary">
          This view is read-only. An approver must authorize changes. Unusual quantities and
          unconfirmed stock can still require approval; other checks also apply.
        </p>
        <details>
          <summary>Technical details</summary>
          <dl>
            ${row("Mandate ID", mandate.mandateId)}${row("Customer", mandate.iss)}${row("Agent", mandate.agent)}${row("Signed by", mandate.signedBy)}${row("Registered", formatTimestamp(record.registeredAt))}
          </dl>
        </details>
      </div>
    </article>`;
  }
}

export const defineMandateSettings = () => defineView("tt-mandate-settings", MandateSettings);

declare global {
  interface HTMLElementTagNameMap {
    "tt-mandate-settings": MandateSettings;
  }
}
