import { readDemoProducts } from "../contexts/catalog/src/api/index.ts";
import { closeDb, env, openDb, selfBaseUrl } from "../packages/server-kit/src/index.ts";
import {
  DEMO_ACCOUNT,
  OffersRequestSchema,
  OffersResultSchema,
  OrderRefSchema,
  OrderSchema,
  PlaceOrderRequestSchema,
} from "../packages/contract/src/index.ts";
import { demoDatabaseUrl } from "./check-demo-data.ts";

const USAGE = `Usage: bun scripts/demo-scenario-3.ts [--database-env NAME]

Set INTERNAL_BASE_URL or PORT to the running application server. The server must
use WHOLESALER_LIVE=mock with its live wholesaler API key configured. Reads
s3 and requestedDate from the catalogue database. Use --database-env NAME
to select a different database explicitly. This creates a real order; a human must approve
it at the displayed URL. The script waits up
to five minutes for placement. Maximum: 63 application HTTP requests (one
offers request, one placement, one initial status, and 60 status polls).
WHOLESALER_LIVE=fixture is not supported by the server.`;

const POLLS = 60;
const POLL_INTERVAL_MS = 5_000;
const MAX_REQUESTS = 3 + POLLS;
let requests = 0;
let stage = "arguments";

async function request(path: string, body?: unknown): Promise<unknown> {
  if (++requests > MAX_REQUESTS) throw new Error(`Request ceiling ${MAX_REQUESTS} exceeded`);
  const response = await fetch(`${selfBaseUrl()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path}: response is not JSON`);
  }
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  requireCondition(args.length === 0 || (args.length === 2 && args[0] === "--database-env"), USAGE);
  requireCondition(
    env("WHOLESALER_LIVE") !== "fixture",
    "WHOLESALER_LIVE=fixture is not supported by the server; use the live mock adapter",
  );

  stage = "demo configuration";
  const db = openDb(await demoDatabaseUrl(selfBaseUrl(), args[1]));
  let demo;
  try {
    demo = await readDemoProducts(db);
  } finally {
    await closeDb(db);
  }
  requireCondition(demo, "Demo products are not configured in the catalogue database");
  const s3 = demo.s3;
  requireCondition(s3, "No s3 scenario is configured in the catalogue database");
  const input = OffersRequestSchema.parse({
    lines: [s3],
    deliverBy: demo.requestedDate,
    paymentTerms: DEMO_ACCOUNT.paymentTerms,
    hard: [],
    soft: [],
  });
  console.log(
    `Scenario 3: ${s3.productId}, ${s3.quantity.value} ${s3.quantity.unit}, requested ${demo.requestedDate}`,
  );

  stage = "offers";
  const result = OffersResultSchema.parse(await request("/api/offers", input));
  const originals = result.offers.filter(
    (offer) => offer.claims.productId === s3.productId && offer.claims.replaces === null,
  );
  requireCondition(
    originals.length === 1,
    `Expected exactly one original offer; got ${originals.length}. Omitted: ${JSON.stringify(result.omitted)}`,
  );
  const original = originals[0];
  requireCondition(original, "Original offer is missing");
  requireCondition(
    original.claims.stock === "confirmed" &&
      original.claims.shortfall !== null &&
      original.claims.shortfall.value > 0,
    "Original offer is not confirmed partial stock with a positive signed shortfall",
  );
  const best = result.offers.filter(
    (offer) => offer.claims.replaces === s3.productId && offer.rank === "best",
  );
  requireCondition(
    best.length === 1,
    `Expected exactly one best linked substitute; got ${best.length}`,
  );
  const substitute = best[0];
  requireCondition(substitute, "Best substitute is missing");
  requireCondition(
    substitute.claims.productId !== original.claims.productId &&
      substitute.comparison?.replaces === s3.productId,
    "Best substitute lacks the expected signed and comparison links",
  );
  console.log(
    `Partial original: ${original.claims.product.name} (${original.claims.productId}), ${original.claims.quantity.value} ${original.claims.quantity.unit}; shortfall ${original.claims.shortfall.value} ${original.claims.shortfall.unit}`,
  );
  console.log(
    `Best substitute: ${substitute.claims.product.name} (${substitute.claims.productId}), ${substitute.claims.quantity.value} ${substitute.claims.quantity.unit}; comparison ${JSON.stringify(substitute.comparison)}`,
  );

  stage = "place order";
  const place = PlaceOrderRequestSchema.parse({
    offers: [original.token, substitute.token],
    originalRequest: `Scenario 3: ${s3.quantity.value} ${s3.quantity.unit} of ${s3.productId} by ${demo.requestedDate}`,
    idempotencyKey: crypto.randomUUID(),
  });
  const placed = OrderSchema.parse(await request("/api/orders", place));
  requireCondition(
    placed.status === "pending_approval",
    `Expected pending_approval, got ${placed.status}: ${JSON.stringify(placed.reasons)}`,
  );
  requireCondition(
    placed.reasons.includes("SUBSTITUTION") && placed.reasons.includes("AVAILABILITY_DIFFERS"),
    `Expected SUBSTITUTION and AVAILABILITY_DIFFERS, got ${JSON.stringify(placed.reasons)}`,
  );
  requireCondition(
    placed.lines.length === 2 &&
      [original.offerId, substitute.offerId].every((id) =>
        placed.lines.some((line) => line.offerId === id),
      ),
    "Pending order does not contain exactly the two selected lines",
  );

  stage = "fetch pending order";
  const ref = OrderRefSchema.parse({ orderId: placed.orderId });
  const path = `/api/orders/${encodeURIComponent(ref.orderId)}`;
  const pending = OrderSchema.parse(await request(path));
  requireCondition(
    pending.orderId === ref.orderId && pending.status === "pending_approval" && pending.approvalUrl,
    "Fetched order is not pending or has no approval URL",
  );
  requireCondition(
    pending.reasons.includes("SUBSTITUTION") && pending.reasons.includes("AVAILABILITY_DIFFERS"),
    `Fetched order lost required reasons: ${JSON.stringify(pending.reasons)}`,
  );
  console.log(
    `Order ${pending.orderId}: ${pending.status}; reasons: ${pending.reasons.join(", ")}`,
  );
  console.log(`Human approval URL: ${pending.approvalUrl}`);
  console.log(
    "A human must open the URL and approve. Waiting up to five minutes; no automatic approval will be sent.",
  );

  stage = "wait for human approval and placement";
  for (let poll = 0; poll < POLLS; poll++) {
    await Bun.sleep(POLL_INTERVAL_MS);
    const order = OrderSchema.parse(await request(path));
    requireCondition(order.orderId === ref.orderId, "Status response has the wrong order ID");
    if (order.status === "placed") {
      requireCondition(
        order.lines.length === 2 &&
          [original.offerId, substitute.offerId].every((id) =>
            order.lines.some((line) => line.offerId === id),
          ),
        "Placed order does not contain the two selected lines",
      );
      requireCondition(
        order.audit.some((event) => event.event === "approved" && event.actor === "approver"),
        "Placed order has no human approval audit event",
      );
      console.log(
        `Placed: ${order.orderId}; status ${order.status}; approval recorded; total ${order.total.gross} EUR gross`,
      );
      console.log(`Application requests: ${requests}/${MAX_REQUESTS}`);
      return;
    }
    requireCondition(
      order.status === "pending_approval" || order.status === "awaiting_payment",
      `Order ended in ${order.status}: ${JSON.stringify(order.reasons)}`,
    );
  }
  throw new Error(
    `Timed out waiting for human approval and placement of ${ref.orderId}; inspect the order at ${pending.approvalUrl}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `Scenario 3 failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
