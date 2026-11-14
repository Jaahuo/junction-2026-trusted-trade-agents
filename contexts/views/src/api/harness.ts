const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * Writes the server's base URL into a built view and, in the harness, the fixture the
 * view reads instead of a tool result. JSON inside a script escapes `<`.
 */
export function inject(html: string, baseUrl: string, fixture?: unknown) {
  const meta = `<meta name="tt-base-url" content="${escapeHtml(baseUrl)}">`;
  const data =
    fixture === undefined
      ? ""
      : `<script type="application/json" id="tt-harness">${JSON.stringify(fixture).replaceAll("<", String.raw`<`)}</script>`;
  return html.replace("</head>", `${meta}${data}</head>`);
}

/** Every state of the given views, each in a frame like a chat host. */
export function harnessIndex(views: { view: string; states: string[] }[]) {
  const sections = views.map(({ view, states }) => {
    const frames = states.map((state) => {
      const src = escapeHtml(`/views/harness?view=${view}&state=${state}`);
      return `<figure><figcaption><a href="${src}">${escapeHtml(state)}</a></figcaption>
        <iframe title="${escapeHtml(`${view} ${state}`)}" src="${src}"></iframe></figure>`;
    });
    return `<section><h2>${escapeHtml(view)}</h2><div class="grid">${frames.join("")}</div></section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>View harness</title>
<style>
  body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }
  h2 { margin: 16px 0 8px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  figure { margin: 0; }
  figcaption { font-size: 13px; margin-bottom: 4px; }
  iframe { width: 100%; height: 160px; border: 1px solid #ccc; border-radius: 8px; }
</style></head><body><h1>View harness</h1>${sections.join("")}</body></html>`;
}
