import { html, LitElement, nothing, type TemplateResult } from "lit";
import { loadView, type EntryData, type Source, type ViewEntry, type ViewState } from "./bridge.ts";
import { loadFonts } from "./fonts.ts";
import { LocaleController, pick } from "./locale.ts";
import { sourceFor } from "./source.ts";
import { base } from "./styles.ts";

const SHELL = {
  en: {
    loading: "Loading",
    emptyTitle: "Nothing to show",
    emptyBody: "The result has no items.",
    errorTitle: "This view can't be shown",
    openPlain: "Open the plain page",
    needsHost: "This view needs data from a host. ",
    goToApprovals: "Go to approvals",
  },
  fi: {
    loading: "Ladataan",
    emptyTitle: "Ei näytettävää",
    emptyBody: "Tuloksessa ei ole rivejä.",
    errorTitle: "Näkymää ei voi näyttää",
    openPlain: "Avaa tavallinen sivu",
    needsHost: "Tämä näkymä tarvitsee tiedot isäntäsovellukselta. ",
    goToApprovals: "Siirry hyväksyntöihin",
  },
};

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
  protected readonly locale = new LocaleController(this);

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
    const text = pick(SHELL);
    if (state.kind === "loading")
      return html`<div part="loading">
        <p class="secondary body-small" role="status">${text.loading}…</p>
        <span class="shimmer load-bar" aria-hidden="true"></span>
      </div>`;
    if (state.kind === "empty")
      return html`<div class="empty" part="empty">
        <p class="strong">${text.emptyTitle}</p>
        <p class="secondary body-small">${text.emptyBody}</p>
      </div>`;
    if (state.kind === "error")
      return html`<div class="message danger" role="alert" part="error">
        <p class="strong">${text.errorTitle}</p>
        <p>${state.message}</p>
        ${
          state.plainUrl === null
            ? nothing
            : html`<a href=${state.plainUrl} target="_blank" rel="noreferrer">${text.openPlain}</a>`
        }
      </div>`;
    return this.renderDone(state.data);
  }
}

/** Registers a view element once; safe to call more than once. */
export function defineView(tag: string, element: CustomElementConstructor) {
  loadFonts();
  if (customElements.get(tag) === undefined) customElements.define(tag, element);
}

/** Connects a view element to its source and adds it to the page. */
export function mountView(element: ViewElement<ViewEntry>) {
  element.source = sourceFor(element.entry.view);
  // Opened as its own page rather than in a chat frame: view.css centres it at card width.
  if (window.parent === window && document.querySelector("#tt-harness") === null)
    document.documentElement.classList.add("page");
  const root = document.querySelector("#root");
  if ("standaloneFallback" in element.source) {
    // sourceFor has set the page language by now.
    const text = pick(SHELL);
    const message = document.createElement("p");
    const link = document.createElement("a");
    link.href = "/approvals";
    link.textContent = text.goToApprovals;
    message.append(text.needsHost, link, ".");
    root?.append(message);
    return;
  }
  root?.append(element);
}
