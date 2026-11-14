import { brand } from "@app/ui/brand";
import { formatMoney, formatQuantity, formatTimestamp, ORDER_WORDING } from "@app/ui/format";
import { css, html } from "lit";
import {
  callAction,
  plainPageUrl,
  type ViewData,
  type ViewEntryOf,
  viewEntry,
} from "../../shared/bridge.ts";
import { lang, pick } from "../../shared/locale.ts";
import { preferred } from "../../shared/constraints.ts";
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
import { MANDATE } from "./strings.ts";

const row = (label: string, value: string) =>
  html`<div class="row">
    <dt>${label}</dt>
    <dd>${value}</dd>
  </div>`;

export class MandateSettings extends ViewElement<ViewEntryOf<"mandate-settings">> {
  static override properties = {
    ...ViewElement.properties,
    revoking: { state: true },
    revokeFailed: { state: true },
  };

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
      .rules {
        display: grid;
        gap: var(--spacing-md);
        padding: 0;
        list-style: none;
      }
      .rules li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--spacing-sm);
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
  /** True while a substitution rule is being removed. */
  declare private revoking: boolean;
  declare private revokeFailed: boolean;

  constructor() {
    super();
    this.revoking = false;
    this.revokeFailed = false;
  }
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

  /** Registers the mandate again without the rule at `index`, then shows the new version. */
  private async revoke(record: ViewData<"mandate-settings">, index: number) {
    const source = this.source;
    if (source === null) return;
    const { limits, standingConstraints, exp } = record.mandate;
    this.revoking = true;
    const saved = await callAction(
      source,
      "register_mandate",
      {
        limits: {
          ...limits,
          substitutionRules: (limits.substitutionRules ?? []).filter((_, i) => i !== index),
        },
        standingConstraints,
        exp,
      },
      null,
    );
    this.revoking = false;
    this.revokeFailed = saved.kind !== "done";
    if (saved.kind === "done") this.state = saved;
  }

  private rules(record: ViewData<"mandate-settings">, active: boolean) {
    const rules = record.mandate.limits.substitutionRules ?? [];
    if (rules.length === 0) return html``;
    const text = pick(MANDATE);
    const l = lang();
    return html`<section part="substitution-rules">
      <h3>${text.substitutionRules}</h3>
      <p class="secondary">${text.substitutionRulesNote}</p>
      <ul class="rules">
        ${rules.map((rule, index) => {
          const since = formatTimestamp(rule.decidedAt, l);
          return html`<li>
            <div>
              <p class="strong">
                ${text.rule(rule.productName ?? rule.productId, rule.replacesName ?? rule.replaces)}
              </p>
              <p class="secondary">
                ${rule.policy === "auto" ? text.ruleAuto(since) : text.ruleNever(since)}
              </p>
            </div>
            ${
              active
                ? html`<button
                    class="btn secondary"
                    ?disabled=${this.revoking}
                    @click=${() => this.revoke(record, index)}
                  >
                    ${text.revoke}
                  </button>`
                : html``
            }
          </li>`;
        })}
      </ul>
      ${this.revokeFailed ? html`<p role="alert">${text.revokeFailed}</p>` : html``}
    </section>`;
  }

  private header() {
    const text = pick(MANDATE);
    return html`<header class="header" part="header">
      <div class="brand">
        <img class="logo" src=${brand.logo} alt=${brand.name} /><span>${text.agentSettings}</span>
      </div>
      <h2 class="title">${text.title}</h2>
    </header>`;
  }

  override render() {
    const state = this.state;
    if (state.kind === "done") return this.renderDone(state.data);
    const text = pick(MANDATE);
    return html`<article class="card" part=${state.kind}>
      ${this.header()}
      <div class="body">
        ${
          state.kind === "loading"
            ? html`<p role="status">
                <span class="spinner" aria-hidden="true"></span> ${text.loading}
              </p>`
            : state.kind === "empty"
              ? html`<section>
                  <h3>${text.noMandateTitle}</h3>
                  <p>${text.noMandateBody}</p>
                </section>`
              : html`<section role="alert">
                  <h3>${text.loadFailedTitle}</h3>
                  <p>${text.loadFailedBody}</p>
                  <div class="actions">
                    <button class="btn primary" @click=${() => this.reload(true)}>
                      ${text.tryAgain}</button
                    ><a
                      class="btn ghost"
                      href=${plainPageUrl("mandate-settings", document.querySelector<HTMLMetaElement>('meta[name="tt-base-url"]')?.content ?? location.origin) ?? "/views/mandate-settings"}
                      target="_blank"
                      rel="noreferrer"
                      >${text.openLimitsPage}</a
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
    const text = pick(MANDATE);
    const terms = pick(ORDER_WORDING).terms;
    const l = lang();
    return html`<article class="card" part="done">
      ${this.header()}
      <div class="body">
        <div class="status ${status === "active" ? "" : "inactive"}" part="status">
          <p class="strong">${text.status[status]} · ${text.version(mandate.version)}</p>
          <p>${status === "active" ? text.activeNote : text.inactiveNote}</p>
        </div>
        ${status === "active" ? html`` : html`<h3>${text.previousLimits}</h3>`}
        <section>
          <h3>${text.orderLimits}</h3>
          <dl>
            ${row(terms.limit, text.perOrder(formatMoney(limits.maxOrderTotal.value, limits.maxOrderTotal.currency, limits.maxOrderTotal.basis, l)))}
            ${row(text.categories, `${categoriesText(limits.categories)}. ${limits.categories === null ? text.categoriesAll : limits.categories.length === 0 ? text.categoriesNone : text.categoriesListed}`)}
            ${row(text.substitutions, substitutionText(limits.substitutions))}
            ${row(text.newProducts, policyText(limits.newProducts))}
          </dl>
        </section>
        ${this.rules(record, status === "active")}
        <section>
          <h3>${text.productData}</h3>
          <dl>
            ${row(text.minReliability, `${thresholdText(limits.minDeliveryReliability, (value) => new Intl.NumberFormat(l === "fi" ? "fi-FI" : "en-FI", { style: "percent", maximumFractionDigits: 4 }).format(value))} ${limits.minDeliveryReliability === null ? "" : text.reliabilityRule}`)}
            ${row(text.maxCo2, `${thresholdText(limits.maxCo2PerKg, (value) => text.co2PerKg(formatQuantity({ value, unit: "KGM" }, l)))} ${limits.maxCo2PerKg === null ? "" : text.co2Rule}`)}
            ${row(text.missingAllergen, text.allergenRule(policyText(limits.allergenData.ifNoData)))}
          </dl>
        </section>
        <section>
          <h3>${text.paymentTerms}</h3>
          <dl>
            ${row(text.invoice, policyText(limits.paymentTerms.invoice))}
            ${row(terms.paymentOnOrder, policyText(limits.paymentTerms.pay_on_order))}
          </dl>
        </section>
        <section>
          <h3>${text.standingConstraints}</h3>
          <p class="strong">${text.required}</p>
          ${
            hard.length === 0
              ? html`<p>${text.none}</p>`
              : html`<ul>
                  ${hard.map(() => html`<li>${text.freeFromLactose}</li>`)}
                </ul>`
          }
          <p class="strong">${text.preferred}</p>
          ${
            soft.length === 0
              ? html`<p>${text.none}</p>`
              : html`<ul>
                  ${soft.map((item) => html`<li>${preferred(item.attribute, item.prefer)}</li>`)}
                </ul>`
          }
        </section>
        <section>
          <h3>${text.validity}</h3>
          <dl>
            ${row(text.issued, formatTimestamp(new Date(mandate.iat * 1000).toISOString(), l))}${row(text.expires, formatTimestamp(new Date(mandate.exp * 1000).toISOString(), l))}
          </dl>
        </section>
        <p class="secondary">${text.readOnly}</p>
        <details>
          <summary>${text.technicalDetails}</summary>
          <dl>
            ${row(text.mandateId, mandate.mandateId)}${row(text.customer, mandate.iss)}${row(text.agent, mandate.agent)}${row(text.signedBy, mandate.signedBy)}${row(text.registered, formatTimestamp(record.registeredAt, l))}
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
