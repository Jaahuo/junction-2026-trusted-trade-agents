import { html, LitElement, nothing, type TemplateResult } from "lit";
import { loadView, type EntryData, type Source, type ViewEntry, type ViewState } from "./bridge.ts";
import { sourceFor } from "./source.ts";
import { base } from "./styles.ts";

/**
 * The shared shell of every view: loads the tool result from `source` and renders the
 * loading, empty and error states. A view renders only its data in `renderDone`.
 */
export abstract class ViewElement<E extends ViewEntry> extends LitElement {
  // No decorators: the bundler leaves them untransformed.
  static override properties = {
    source: { attribute: false },
    state: { state: true },
  };
  static override styles = [base];

  abstract readonly entry: E;
  declare source: Source | null;
  declare protected state: ViewState<EntryData<E>>;

  constructor() {
    super();
    this.source = null;
    this.state = { kind: "loading" };
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.source !== null)
      void loadView(this.entry, this.source).then((state) => (this.state = state));
  }

  protected abstract renderDone(data: EntryData<E>): TemplateResult;

  override render() {
    const state = this.state;
    if (state.kind === "loading")
      return html`<p class="secondary body-small" part="loading">
        <span class="spinner" role="status" aria-label="Loading"></span> Loading…
      </p>`;
    if (state.kind === "empty")
      return html`<div class="empty" part="empty">
        <p class="strong">Nothing to show</p>
        <p class="secondary body-small">The result has no items.</p>
      </div>`;
    if (state.kind === "error")
      return html`<div class="message danger" role="alert" part="error">
        <p class="strong">This view can't be shown</p>
        <p>${state.message}</p>
        ${
          state.plainUrl === null
            ? nothing
            : html`<a href=${state.plainUrl} target="_blank" rel="noreferrer"
                >Open the plain page</a
              >`
        }
      </div>`;
    return this.renderDone(state.data);
  }
}

/** Registers a view element once; safe to call more than once. */
export function defineView(tag: string, element: CustomElementConstructor) {
  if (customElements.get(tag) === undefined) customElements.define(tag, element);
}

/** Connects a view element to its source and adds it to the page. */
export function mountView(element: ViewElement<ViewEntry>) {
  element.source = sourceFor(element.entry.view);
  document.querySelector("#root")?.append(element);
}
