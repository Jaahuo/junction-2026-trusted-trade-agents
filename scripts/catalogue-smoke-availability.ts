import { fictionalProducts } from "../contexts/catalog/src/infra/test-fixtures.ts";
import recording from "../contexts/offers/src/infra/wholesaler-fixture.json";

const recorded = recording.calls.find((call) => call.path === "/api/availability")?.response;
if (recorded === undefined) throw new Error("Recorded availability response is missing");

export const availabilityFixture = (
  productIds: readonly string[],
  requestedDate: string,
  now: Date,
) => {
  const products = [];
  for (const productId of productIds) {
    const index = fictionalProducts.findIndex((product) => product.id === productId);
    if (index < 0) continue;
    const sample = recorded.products[index];
    if (sample === undefined || !("scheduleLines" in sample) || sample.scheduleLines === undefined)
      throw new Error("Recorded availability product is missing");
    const product = structuredClone(sample);
    product.productId = productId;
    product.closingTime = new Date(now.getTime() + 86_400_000).toISOString();
    if (product.scheduleLines === undefined) throw new Error("Missing recorded schedule lines");
    for (const line of product.scheduleLines) line.availableDate = requestedDate;
    products.push(product);
  }
  return { timeNow: now.toISOString(), requestedDate, products };
};

if (import.meta.main) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.argv[2] ?? "3001"),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response("ok");
      if (path !== "/api/availability" || request.method !== "POST")
        return new Response(null, { status: 404 });
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("requestedDate" in body) ||
        typeof body.requestedDate !== "string" ||
        !("products" in body) ||
        !Array.isArray(body.products) ||
        !body.products.every((id) => typeof id === "string")
      )
        return new Response(null, { status: 400 });
      return Response.json(availabilityFixture(body.products, body.requestedDate, new Date()));
    },
  });
  console.log(`Fictional image-smoke availability: http://127.0.0.1:${server.port}`);
}
