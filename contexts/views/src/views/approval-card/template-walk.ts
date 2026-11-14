// Test helpers: read Lit templates without a DOM, which Bun does not have.

const isTemplate = (value: unknown): value is { strings: readonly string[]; values: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "strings" in value &&
  "values" in value &&
  Array.isArray(value.strings) &&
  Array.isArray(value.values);

/** The `@click` handler of the first button after `marker` in a template, found without a DOM. */
export const clickHandler = (value: unknown, marker: string): (() => void) | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = clickHandler(item, marker);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) return undefined;
  let markup = "";
  for (const [index, part] of value.strings.entries()) {
    markup += part;
    const bound = value.values[index];
    if (
      markup.includes(marker) &&
      part.trimEnd().endsWith("@click=") &&
      typeof bound === "function"
    )
      return () => bound();
    if (typeof bound === "string") markup += bound;
  }
  for (const nested of value.values) {
    const found = clickHandler(nested, marker);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The template's markup with its text values, leaving out templates that start with `skip`. */
export const markup = (value: unknown, skip?: string): string => {
  if (Array.isArray(value)) return value.map((v) => markup(v, skip)).join(" ");
  if (!isTemplate(value))
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (skip !== undefined && value.strings[0]?.trimStart().startsWith(skip)) return "";
  return value.strings.map((part, i) => part + markup(value.values[i], skip)).join("");
};
