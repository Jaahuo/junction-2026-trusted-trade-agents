import type { MandateDraft, StoredMandate } from "@app/contract";
import { brand } from "@app/ui/brand";
import { formatMoney, formatTimestamp, ORDER_WORDING } from "@app/ui/format";
import { css, html, nothing } from "lit";
import {
  callAction,
  plainPageUrl,
  type Source,
  type ViewData,
  type ViewEntryOf,
  viewEntry,
} from "../../shared/bridge.ts";
import { lang, pick } from "../../shared/locale.ts";
import { required } from "../../shared/constraints.ts";
import { base } from "../../shared/styles.ts";
import { defineView, ViewElement } from "../../shared/view-element.ts";
import { loadMandate } from "./loader.ts";
import {
  categoriesText,
  co2Text,
  draftRows,
  effectiveStatus,
  expiryDelay,
  inForce,
  isDraft,
  isNoCurrentMandate,
  percentText,
  policyText,
  registeredContext,
  registerInput,
  registersDraft,
  softText,
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
  // No decorators: the bundler leaves them untransformed.
  static override properties = {
    ...ViewElement.properties,
    registering: { state: true },
    registerError: { state: true },
    currentUnknown: { state: true },
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
      .proposed {
        font-weight: 600;
      }
      .in-force {
        display: block;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        margin-top: var(--spacing-2xs);
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
  private expiryTimer: number | undefined;
  private renderedStatus: "active" | "expired" | "revoked" | null = null;
  declare private registering: boolean;
  /** Why the last Register failed, shown next to the button; `unconfirmed` when the outcome is unknown. */
  declare private registerError: { message: string; unconfirmed: boolean } | null;
  /** True after a Register whose outcome no check settled: the view cannot tell which limits are in force. */
  declare private currentUnknown: boolean;
  /** Created at the first Register of a draft and kept, so a retry is a replay (SPEC-008). */
  private operationId: string | null = null;
  /** True while a substitution rule is being removed. */
  declare private revoking: boolean;
  declare private revokeFailed: boolean;

  constructor() {
    super();
    this.registering = false;
    this.registerError = null;
    this.currentUnknown = false;
    this.revoking = false;
    this.revokeFailed = false;
  }

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
    // A draft shows its current mandate as in force only until that mandate expires.
    const exp = isDraft(state.data) ? state.data.current?.mandate.exp : state.data.mandate.exp;
    if (exp === undefined) return;
    const delay = expiryDelay(exp, this.renderedStatus);
    if (delay !== null) this.expiryTimer = window.setTimeout(() => this.requestUpdate(), delay);
  }

  private async reload(retry: boolean) {
    const source = this.source;
    if (source === null) return;
    this.state = { kind: "loading" };
    this.state = await loadMandate(source, retry);
  }

  private async register(draft: MandateDraft) {
    const source = this.source;
    if (source === null || this.registering) return;
    this.operationId ??= `op_view_${crypto.randomUUID()}`;
    this.registering = true;
    this.registerError = null;
    const result = await callAction(
      source,
      "register_mandate",
      registerInput(draft.draft, this.operationId),
      null,
    );
    if (result.kind === "done") return this.registered(source, result.data);
    // The register may have committed before its answer was lost: the mandate in force tells.
    const check = await callAction(source, "get_mandate", {}, null);
    if (check.kind === "done" && registersDraft(check.data, draft))
      return this.registered(source, check.data);
    this.registering = false;
    const none =
      check.kind === "error" &&
      (check.message.startsWith("NOT_FOUND:") || isNoCurrentMandate(new Error(check.message)));
    // The check is the latest word on the mandate in force; without one, nothing is claimed.
    if (check.kind === "done" || none)
      this.state = {
        kind: "done",
        data: { ...draft, current: check.kind === "done" ? check.data : null },
      };
    this.currentUnknown = check.kind !== "done" && !none;
    this.registerError = {
      message: result.kind === "error" ? result.message : "",
      unconfirmed: this.currentUnknown,
    };
  }

  private registered(source: Source, stored: StoredMandate) {
    this.registering = false;
    this.currentUnknown = false;
    this.state = { kind: "done", data: stored };
    void source.context?.(registeredContext(stored));
  }

  /** Registers the mandate again without the rule at `index`, then shows the new version. */
  private async revoke(record: StoredMandate, index: number) {
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
    if (saved.kind === "done") this.registered(source, saved.data);
  }

  private rules(record: StoredMandate, active: boolean) {
    const rules = record.mandate.limits.substitutionRules ?? [];
    if (rules.length === 0) return nothing;
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
                : nothing
            }
          </li>`;
        })}
      </ul>
      ${this.revokeFailed ? html`<p role="alert">${text.revokeFailed}</p>` : nothing}
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

  protected override renderDone(data: ViewData<"mandate-settings">) {
    return isDraft(data) ? this.renderDraft(data) : this.renderStored(data);
  }

  private renderDraft(record: MandateDraft) {
    const text = pick(MANDATE);
    const current = this.currentUnknown ? null : inForce(record);
    this.renderedStatus =
      record.current === null || this.currentUnknown ? null : effectiveStatus(record.current);
    return html`<article class="card" part="draft">
      ${this.header()}
      <div class="body">
        <div class="status inactive" part="status">
          <p class="strong">${text.draftStatus}</p>
          <p>${text.draftNote}</p>
        </div>
        <section>
          <h3>${text.proposedLimits}</h3>
          <p class="secondary">
            ${
              this.currentUnknown
                ? text.draftUnknownCurrent
                : current === null
                  ? text.draftNoCurrent
                  : text.draftCompare(current.mandate.version)
            }
          </p>
          <dl>
            ${draftRows({ ...record, current }).map(
              (item) =>
                html`<div class="row">
                  <dt>${item.label}</dt>
                  <dd>
                    <span class=${item.current === null ? "" : "proposed"}>${item.proposed}</span>
                    ${
                      item.current === null
                        ? nothing
                        : html`<span class="in-force">${text.inForce(item.current)}</span>`
                    }
                  </dd>
                </div>`,
            )}
          </dl>
        </section>
        ${
          this.registerError === null
            ? nothing
            : html`<div class="message danger" role="alert" part="register-error">
                <p class="strong">
                  ${this.registerError.unconfirmed ? text.registerUnconfirmedTitle : text.registerFailedTitle}
                </p>
                <p>${this.registerError.message}</p>
                <p>
                  ${this.registerError.unconfirmed ? text.registerUnconfirmedBody : text.registerFailedBody}
                </p>
              </div>`
        }
        <div class="actions">
          <button
            class="btn primary"
            aria-busy=${this.registering ? "true" : "false"}
            ?disabled=${this.registering || this.source === null}
            @click=${() => this.register(record)}
          >
            ${this.registering ? text.registering : text.register}
          </button>
        </div>
        <p class="secondary">${text.humanOnly}</p>
      </div>
    </article>`;
  }

  private renderStored(record: StoredMandate) {
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
            ${row(text.minReliability, `${thresholdText(limits.minDeliveryReliability, percentText)} ${limits.minDeliveryReliability === null ? "" : text.reliabilityRule}`)}
            ${row(text.maxCo2, `${thresholdText(limits.maxCo2PerKg, co2Text)} ${limits.maxCo2PerKg === null ? "" : text.co2Rule}`)}
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
                  ${hard.map((item) => html`<li>${required(item.attribute)}</li>`)}
                </ul>`
          }
          <p class="strong">${text.preferred}</p>
          ${
            soft.length === 0
              ? html`<p>${text.none}</p>`
              : html`<ul>
                  ${soft.map((item) => html`<li>${softText(item)}</li>`)}
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
