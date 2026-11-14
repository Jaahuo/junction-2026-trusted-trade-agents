// Test helpers: read Lit templates without a DOM, which Bun does not have.

const isTemplate = (value: unknown): value is { strings: readonly string[]; values: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "strings" in value &&
  "values" in value &&
  Array.isArray(value.strings) &&
  Array.isArray(value.values);

/**
 * Each template's first `event` handler (`@click` by default) after `marker`, outer templates
 * first, found without a DOM.
 */
export const handlers = (value: unknown, marker: string, event = "@click="): (() => void)[] => {
  if (Array.isArray(value)) return value.flatMap((item) => handlers(item, marker, event));
  if (!isTemplate(value)) return [];
  const found: (() => void)[] = [];
  let markup = "";
  for (const [index, part] of value.strings.entries()) {
    markup += part;
    const bound = value.values[index];
    if (markup.includes(marker) && part.trimEnd().endsWith(event) && typeof bound === "function") {
      found.push(() => bound());
      break;
    }
    if (typeof bound === "string") markup += bound;
  }
  for (const nested of value.values) found.push(...handlers(nested, marker, event));
  return found;
};

/** The `@click` handler of the first button after `marker`. */
export const clickHandler = (value: unknown, marker: string) => handlers(value, marker)[0];

/** The template's markup with its text values, leaving out templates that start with `skip`. */
export const markup = (value: unknown, skip?: string): string => {
  if (Array.isArray(value)) return value.map((v) => markup(v, skip)).join(" ");
  if (!isTemplate(value))
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (skip !== undefined && value.strings[0]?.trimStart().startsWith(skip)) return "";
  return value.strings.map((part, i) => part + markup(value.values[i], skip)).join("");
};
