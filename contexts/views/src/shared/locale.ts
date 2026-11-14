import type { FormatLang } from "@app/ui/format";
import type { ReactiveController, ReactiveControllerHost } from "lit";

/** The languages the views are written in, as the shared formats name them. */
export type Lang = FormatLang;
const LANGS: readonly Lang[] = ["en", "fi"];

/** The `Intl` locale of each language: day-month dates and euro amounts. */
const INTL: Record<Lang, string> = { en: "en-GB", fi: "fi-FI" };

/**
 * The first candidate whose primary subtag is a supported language, else English.
 * Candidates go from most to least specific: the tool input, the host, the browser.
 */
export function resolveLang(...candidates: (string | null | undefined)[]): Lang {
  for (const candidate of candidates) {
    const primary = candidate?.trim().toLowerCase().split(/[-_]/)[0];
    const lang = LANGS.find((entry) => entry === primary);
    if (lang !== undefined) return lang;
  }
  return "en";
}

let current: Lang = "en";
const listeners = new Set<() => void>();

export const lang = (): Lang => current;
export const intlLocale = (): string => INTL[current];

/** Switches every view on the page to `next`, and the document's `lang` with it. */
export function setLang(next: Lang) {
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Picks the current language's entry, so text is read at render time. */
export const pick = <T>(byLang: Record<Lang, T>): T => byLang[current];

/** Re-renders its element when the language changes. */
export class LocaleController implements ReactiveController {
  private readonly update = () => this.host.requestUpdate();

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected() {
    listeners.add(this.update);
  }

  hostDisconnected() {
    listeners.delete(this.update);
  }
}
