// Reads Lit templates without a DOM, so tests can check what a view renders in Bun.

type Template = { strings: readonly string[]; values: unknown[] };

const isTemplate = (value: unknown): value is Template =>
  typeof value === "object" &&
  value !== null &&
  "strings" in value &&
  "values" in value &&
  Array.isArray(value.strings) &&
  Array.isArray(value.values);

/** A directive result such as `unsafeSVG(...)`: Lit renders it, not its string form. */
const isDirective = (value: unknown) =>
  typeof value === "object" && value !== null && "_$litDirective$" in value;

/** Whether the markup ends inside a tag, given whether it started inside one. */
const endsInTag = (part: string, inTag: boolean) => {
  const open = part.lastIndexOf("<");
  const close = part.lastIndexOf(">");
  return open === close ? inTag : open > close;
};

/** A property, event or boolean binding (`.x=`, `@x=`, `?x=`): Lit renders no text for it. */
const isPropertyBinding = (part: string) => /[.@?][\w-]+=$/.test(part.trimEnd());

/** What Lit writes for a value in a child or attribute position. */
const valueText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(valueText).join(" ");
  if (isTemplate(value)) return markup(value);
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "function" || typeof value === "symbol" || isDirective(value)) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return String(value);
  // Lit writes other objects with String(): a plain object shows as "[object Object]".
  return value instanceof Date ? value.toString() : Object.prototype.toString.call(value);
};

/**
 * The template's markup: static parts with each value as Lit renders it, tags kept. A plain
 * object shows as `[object Object]`, as it would in the page.
 */
export function markup(value: unknown): string {
  if (!isTemplate(value)) return valueText(value);
  let inTag = false;
  return value.strings
    .map((part, i) => {
      inTag = endsInTag(part, inTag);
      if (i >= value.values.length) return part;
      const skip = inTag && isPropertyBinding(part);
      return `${part} ${skip ? "" : valueText(value.values[i])}`;
    })
    .join(" ");
}

/** The `@click` handler of the button whose markup contains `marker`, found without a DOM. */
export const clickHandler = (value: unknown, marker: string): (() => void) | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = clickHandler(item, marker);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) return undefined;
  if (value.strings.join("").includes(marker)) {
    const index = value.strings.findIndex((part) => part.trimEnd().endsWith("@click="));
    const handler = value.values[index];
    if (typeof handler === "function") return () => handler();
  }
  for (const nested of value.values) {
    const found = clickHandler(nested, marker);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Elements whose text runs on inside the surrounding block. */
const INLINE = new Set(["a", "abbr", "b", "code", "em", "i", "small", "span", "strong", "time"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "source", "wbr"]);
/** Rows of a list: each may repeat a sentence that another row has. */
const ROWS = new Set(["dd", "li"]);

/** A sentence: three or more words that end in `.`, `!` or `?`. */
const sentencesIn = (text: string) =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => /[.!?]$/.test(part) && part.split(/\s+/).length >= 3);

/**
 * The sentences that show twice in one row (`li`, `dd`) or twice outside any row. Rows of a
 * list may share a sentence, such as one reason on two events.
 */
function repeatedSentences(html: string): string[] {
  const seen = new Map<string, Set<string>>();
  const repeated = new Set<string>();
  const rows: string[] = [];
  const open: string[] = [];
  let next = 0;
  let block = "";
  const flush = () => {
    const scope = rows.at(-1) ?? "view";
    const sentences = seen.get(scope) ?? new Set<string>();
    seen.set(scope, sentences);
    for (const sentence of sentencesIn(block)) {
      if (sentences.has(sentence)) repeated.add(sentence);
      sentences.add(sentence);
    }
    block = "";
  };
  for (const token of html.split(/(<[^>]*>)/)) {
    const tag = /^<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>$/.exec(token);
    if (tag === null) {
      block += ` ${token}`;
      continue;
    }
    const [, closing, rawName = "", selfClosing] = tag;
    const name = rawName.toLowerCase();
    if (INLINE.has(name)) continue;
    flush();
    if (VOID.has(name) || selfClosing === "/") continue;
    if (closing === "") {
      open.push(name);
      if (ROWS.has(name)) rows.push(`${name}${next++}`);
      continue;
    }
    const at = open.lastIndexOf(name);
    if (at === -1) continue;
    for (const closed of open.splice(at)) if (ROWS.has(closed)) rows.pop();
  }
  flush();
  return [...repeated];
}

/** What a reader must never see: unset or broken values printed as text. */
const BROKEN = /\bundefined\b|\bNaN\b|\[object Object\]/g;

/** The problems in a rendered view: broken values anywhere, repeated sentences in its text. */
export function renderProblems(rendered: unknown): string[] {
  const html = markup(rendered);
  return [
    ...[...new Set(html.match(BROKEN))].map((token) => `shows ${token}`),
    ...repeatedSentences(html).map((sentence) => `repeats "${sentence}"`),
  ];
}
