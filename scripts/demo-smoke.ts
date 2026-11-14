// Proves demo scenarios 1, 2 and 4 against a running server through the SPEC-003 REST routes.
// Scenario 4 is the multi-product request (#127): one sentence, one order with three lines.
// Usage: bun scripts/demo-smoke.ts --scenario 1|2|4 [--base-url <url>] [--no-reset] [--database-env NAME]
// It prints step names, HTTP statuses, order ids, totals and audit event names, never product rows.
import { readDemoProducts } from "../contexts/catalog/src/api/index.ts";
import { closeDb, openDb } from "../packages/server-kit/src/index.ts";
import {
  DecideApprovalRequestSchema,
  ErrorEnvelopeSchema,
  FactsRequestSchema,
  FactsResultSchema,
  OffersRequestSchema,
  OffersResultSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  RegisterMandateRequestSchema,
  SearchRequestSchema,
  SearchResultSchema,
  StoredMandateSchema,
  type DemoProducts,
  type Order,
  type Quantity,
} from "../packages/contract/src/index.ts";
import { demoDatabaseUrl } from "./check-demo-data.ts";
import { loadRuntime } from "./runtime.ts";

type Schema<T> = {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
};

const ROOT = `${import.meta.dir}/..`;
const HARD = [{ attribute: "lactose", is: "free_from" }] as const;
const S1_AUDIT = ["order_requested", "offer_verified", "check_passed", "placed"];
const SCENARIOS = [1, 2, 4] as const;
type Scenario = (typeof SCENARIOS)[number];
type Call = ReturnType<typeof makeClient>;

class StepFailure extends Error {
  constructor(
    readonly stepName: string,
    message: string,
  ) {
    super(message);
  }
}

function usage(message: string): never {
  console.error(
    `${message}\nUsage: bun scripts/demo-smoke.ts --scenario 1|2|4 [--base-url <url>] [--no-reset] [--database-env NAME]`,
  );
  process.exit(2);
}

function parseArgs(args: string[]) {
  let scenario: Scenario | undefined;
  let baseUrl: string | undefined;
  let databaseEnv: string | undefined;
  let reset = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scenario") {
      const value = args[++i];
      const parsed = SCENARIOS.find((n) => String(n) === value);
      if (parsed === undefined) usage("--scenario must be 1, 2 or 4.");
      scenario = parsed;
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) usage("--base-url must be an http(s) URL.");
    } else if (arg === "--database-env") {
      databaseEnv = args[++i];
      if (!databaseEnv) usage("--database-env requires an environment variable name.");
    } else if (arg === "--no-reset") reset = false;
    else usage(`Unknown argument: ${arg}`);
  }
  if (scenario === undefined) usage("Missing --scenario.");
  if (scenario === 4 && !reset)
    usage("Scenario 4 requires reset because it registers a tighter test mandate.");
  if (databaseEnv !== undefined && reset)
    usage("--database-env requires --no-reset; reset the selected target separately.");
  return { scenario, baseUrl, reset, databaseEnv };
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeClient(baseUrl: string) {
  return async function call<T>(
    method: "GET" | "POST",
    path: string,
    output: Schema<T>,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    let response: Response;
    try {
      const signal = AbortSignal.timeout(30_000);
      response = await fetch(
        `${baseUrl}${path}`,
        body === undefined
          ? { method, signal }
          : {
              method,
              signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
    } catch (error) {
      throw new Error(
        `${method} ${path}: no response (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const envelope = ErrorEnvelopeSchema.safeParse(json);
      throw new Error(
        `${method} ${path}: HTTP ${response.status}${
          envelope.success ? ` ${envelope.data.error.code}: ${envelope.data.error.message}` : ""
        }`,
      );
    }
    const parsed = output.safeParse(json);
    if (!parsed.success)
      throw new Error(
        `${method} ${path}: HTTP ${response.status}, body breaks the contract: ${issues(parsed.error)}`,
      );
    return { status: response.status, data: parsed.data };
  };
}

function request<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`request breaks the contract: ${issues(parsed.error)}`);
  return parsed.data;
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run();
    console.log(`ok   ${name}`);
    return value;
  } catch (error) {
    throw new StepFailure(name, error instanceof Error ? error.message : String(error));
  }
}

function isSubsequence(expected: string[], actual: string[]): boolean {
  let at = 0;
  for (const event of actual) if (event === expected[at]) at++;
  return at === expected.length;
}

async function prepare(call: Call, reset: boolean) {
  if (reset)
    await step("reset", async () => {
      const child = Bun.spawn(["bun", "run", "db:reset"], {
        cwd: ROOT,
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await child.exited;
      if (code !== 0)
        throw new Error(
          `bun run db:reset exited ${code}: ${(await new Response(child.stderr).text()).trim()}`,
        );
    });

  await step("health", async () => {
    const { data } = await call("GET", "/api/health", {
      safeParse: (value: unknown) =>
        typeof value === "object" && value !== null && "ok" in value && value.ok === true
          ? { success: true as const, data: true }
          : {
              success: false as const,
              error: { issues: [{ path: [], message: 'expected {"ok":true}' }] },
            },
    });
    return data;
  });
}

async function runScenario(scenario: 1 | 2, call: Call, reset: boolean, demo: DemoProducts) {
  const target = scenario === 1 ? demo.s1 : demo.s2;
  const terms = { deliverBy: demo.requestedDate, paymentTerms: "invoice", hard: HARD, soft: [] };
  await prepare(call, reset);

  const candidate = await step("search", async () => {
    const body = request(SearchRequestSchema, {
      ...terms,
      terms: ["milk"],
      quantity: target.quantity,
      originalRequest: `scenario ${scenario}: lactose-free milk`,
    });
    const { data } = await call("POST", "/api/catalog/search", SearchResultSchema, body);
    const found = data.candidates.find((c) => c.productId === target.productId);
    check(
      found !== undefined,
      `the scenario product is not among ${data.candidates.length} candidates`,
    );
    check(found.orderQuantity !== null, "the scenario product has no orderQuantity");
    return { productId: found.productId, orderQuantity: found.orderQuantity };
  });

  // Placed by offer ID, as an agent does (SPEC-009): the server looks up the token it issued.
  const offerId = await step("offers", async () => {
    const body = request(OffersRequestSchema, {
      ...terms,
      lines: [{ productId: candidate.productId, quantity: candidate.orderQuantity }],
    });
    const { data } = await call("POST", "/api/offers", OffersResultSchema, body);
    const offer = data.offers.find((o) => o.claims.productId === candidate.productId);
    const omitted = data.omitted.find((o) => o.productId === candidate.productId);
    check(
      offer !== undefined,
      `no offer for the scenario product (omitted: ${omitted?.reason ?? "no reason"})`,
    );
    return offer.offerId;
  });

  const order = await step("place", async () => {
    const body = request(PlaceOrderRequestSchema, {
      offers: [offerId],
      idempotencyKey: `demo-smoke-${crypto.randomUUID()}`,
      originalRequest: `scenario ${scenario}: lactose-free milk`,
    });
    const { status, data } = await call("POST", "/api/orders", OrderSchema, body);
    check(status === 201, `expected HTTP 201, got ${status}`);
    if (scenario === 1) {
      check(data.status === "placed", `expected status placed, got ${data.status}`);
      check(data.reasons.length === 0, `expected no reasons, got [${data.reasons.join(", ")}]`);
    } else {
      check(data.status === "pending_approval", `expected pending_approval, got ${data.status}`);
      check(
        data.reasons.length === 1 && data.reasons[0] === "SPEND_OVER_LIMIT",
        `expected reasons [SPEND_OVER_LIMIT], got [${data.reasons.join(", ")}]`,
      );
      check(data.approvalUrl !== null, "pending order has no approvalUrl");
      console.log(`     approvalUrl ${data.approvalUrl}`);
    }
    console.log(`     order ${data.orderId} ${data.status}`);
    return data;
  });

  let proposalVersion = order.proposalVersion;
  if (scenario === 2) {
    await step("pending", async () => {
      const { data } = await call("GET", "/api/orders/pending", PendingListSchema);
      const listed = data.orders.find((o) => o.orderId === order.orderId);
      check(listed !== undefined, "the order is not in the pending list");
      check(
        listed.reasons.length === 1 && listed.reasons[0] === "SPEND_OVER_LIMIT",
        `expected reasons [SPEND_OVER_LIMIT], got [${listed.reasons.join(", ")}]`,
      );
      proposalVersion = listed.proposalVersion;
    });
    await step("approve", async () => {
      const body = request(DecideApprovalRequestSchema, { proposalVersion, decision: "approve" });
      const { data } = await call(
        "POST",
        `/api/orders/${encodeURIComponent(order.orderId)}/decision`,
        OrderSchema,
        body,
      );
      check(data.status === "placed", `expected status placed after approval, got ${data.status}`);
    });
  }

  await step("status", async () => {
    const { data } = await call(
      "GET",
      `/api/orders/${encodeURIComponent(order.orderId)}`,
      OrderSchema,
    );
    const events = data.audit.map((a) => a.event);
    console.log(`     audit ${events.join(", ")}`);
    check(data.status === "placed", `expected status placed, got ${data.status}`);
    if (scenario === 1)
      check(
        isSubsequence(S1_AUDIT, events),
        `expected audit events ${S1_AUDIT.join(", ")} in order`,
      );
  });
}

interface S4Line {
  readonly label: string;
  readonly name: string;
  readonly productId: string;
  readonly quantity: Quantity;
}

interface Quoted {
  readonly offerIds: string[];
  readonly lines: { productId: string; quantity: Quantity; gross: number }[];
}

const fifth = (quantity: Quantity): Quantity => ({
  value: Math.ceil(quantity.value / 5),
  unit: quantity.unit,
});

// Use the same quantities as seeded history for each product.
async function s4Lines(call: Call, demo: DemoProducts): Promise<S4Line[]> {
  const { s3, s3Substitute } = demo;
  if (s3 === null || s3Substitute === undefined)
    throw new StepFailure(
      "setup",
      "Scenario 4 needs s3 and s3Substitute in imported demo metadata.",
    );
  const inputs = [
    { label: "s1", productId: demo.s1.productId, quantity: demo.s1.quantity },
    { label: "s3", productId: s3.productId, quantity: fifth(s3.quantity) },
    { label: "s3 substitute", productId: s3Substitute.productId, quantity: fifth(s3.quantity) },
  ];
  if (new Set(inputs.map((line) => line.productId)).size !== 3)
    throw new StepFailure("setup", "Scenario 4 needs distinct s1, s3 and s3Substitute products.");
  return step("product facts", async () => {
    const body = request(FactsRequestSchema, {
      productIds: inputs.map((line) => line.productId),
      hard: HARD,
    });
    const { data } = await call("POST", "/api/catalog/facts", FactsResultSchema, body);
    return inputs.map((line) => {
      const product = data.products.find((item) => item.productId === line.productId);
      check(product !== undefined, `no catalog facts for ${line.label}`);
      check(product.name.trim().length > 0, `no searchable name for ${line.label}`);
      return {
        label: line.label,
        name: product.name,
        productId: line.productId,
        quantity: line.quantity,
      };
    });
  });
}

const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.015;

async function quote(
  call: Call,
  name: string,
  lines: { productId: string; quantity: Quantity }[],
  demo: DemoProducts,
): Promise<Quoted> {
  return step(name, async () => {
    const body = request(OffersRequestSchema, {
      deliverBy: demo.requestedDate,
      paymentTerms: "invoice",
      hard: HARD,
      soft: [],
      lines,
    });
    const { data } = await call("POST", "/api/offers", OffersResultSchema, body);
    const offers = lines.map((line) => {
      const offer = data.offers.find((o) => o.claims.productId === line.productId);
      const omitted = data.omitted.find((o) => o.productId === line.productId);
      check(
        offer !== undefined,
        `no offer for ${line.productId} (omitted: ${omitted?.reason ?? "no reason"})`,
      );
      check(
        offer.precheck?.decision === "auto",
        `expected pre-check auto for ${line.productId}, got ${offer.precheck?.decision ?? "none"} [${offer.precheck?.reasons.join(", ") ?? ""}]`,
      );
      return offer;
    });
    console.log(
      `     line totals ${offers.map((o) => o.claims.total.gross).join(" + ")} EUR gross`,
    );
    return {
      offerIds: offers.map((o) => o.offerId),
      lines: offers.map((o) => ({
        productId: o.claims.productId,
        quantity: o.claims.quantity,
        gross: o.claims.total.gross,
      })),
    };
  });
}

async function placeAll(
  call: Call,
  name: string,
  quoted: Quoted,
  originalRequest: string,
): Promise<Order> {
  return step(name, async () => {
    const body = request(PlaceOrderRequestSchema, {
      offers: quoted.offerIds,
      idempotencyKey: `demo-smoke-${crypto.randomUUID()}`,
      originalRequest,
    });
    const { status, data } = await call("POST", "/api/orders", OrderSchema, body);
    check(status === 201, `expected HTTP 201, got ${status}`);
    const validate = (order: Order) => {
      check(order.lines.length === 3, `expected one order with 3 lines, got ${order.lines.length}`);
      for (const [index, expected] of quoted.lines.entries()) {
        const line = order.lines.find((item) => item.offerId === quoted.offerIds[index]);
        check(line !== undefined, `missing quoted line ${index + 1}`);
        check(line.claims.productId === expected.productId, `wrong product on line ${index + 1}`);
        check(
          line.claims.quantity.value === expected.quantity.value &&
            line.claims.quantity.unit === expected.quantity.unit,
          `wrong quantity on line ${index + 1}`,
        );
        check(
          sameMoney(line.claims.total.gross, expected.gross),
          `wrong total on line ${index + 1}`,
        );
      }
      const sum = quoted.lines.reduce((total, line) => total + line.gross, 0);
      check(sameMoney(order.total.gross, sum), "order total does not match the quoted lines");
    };
    validate(data);
    const stored = await call(
      "GET",
      `/api/orders/${encodeURIComponent(data.orderId)}`,
      OrderSchema,
    );
    validate(stored.data);
    check(stored.data.status === data.status, "stored order status differs from placement");
    check(
      JSON.stringify(stored.data.reasons) === JSON.stringify(data.reasons),
      "stored order reasons differ from placement",
    );
    console.log(`     order ${data.orderId} ${data.status}, 3 lines`);
    return data;
  });
}

async function runScenario4(call: Call, reset: boolean, demo: DemoProducts) {
  await prepare(call, reset);
  const lines = await s4Lines(call, demo);
  const originalRequest = `Order ${lines
    .map((line) => `${line.quantity.value} ${line.quantity.unit} of ${line.name}`)
    .join(", ")} for ${demo.requestedDate}.`;

  const mandate = await step("mandate", async () => {
    const { data } = await call("GET", "/api/mandates/current", StoredMandateSchema);
    return data.mandate;
  });

  const shortlist: { productId: string; quantity: Quantity }[] = [];
  for (const line of lines)
    shortlist.push(
      await step(`search ${line.label}`, async () => {
        const body = request(SearchRequestSchema, {
          deliverBy: demo.requestedDate,
          paymentTerms: "invoice",
          hard: HARD,
          soft: [],
          terms: [line.name],
          quantity: line.quantity,
          originalRequest,
        });
        const { data } = await call("POST", "/api/catalog/search", SearchResultSchema, body);
        const found = data.candidates.find((c) => c.productId === line.productId);
        check(found !== undefined, `the ${line.label} product is not among the candidates`);
        check(found.orderQuantity !== null, `the ${line.label} product has no orderQuantity`);
        return { productId: found.productId, quantity: found.orderQuantity };
      }),
    );

  const initial = await quote(call, "fixture offers", shortlist, demo);
  const s1 = lines.find((line) => line.label === "s1");
  check(s1 !== undefined, "the s1 product is missing");
  const s1Quote = initial.lines.find((line) => line.productId === s1.productId);
  check(s1Quote !== undefined, "the s1 quote is missing");
  const baseTotal = initial.lines.reduce((total, line) => total + line.gross, 0);
  const limit = Math.floor((baseTotal + s1Quote.gross / 2) * 100) / 100;
  check(limit > baseTotal, "the s1 increment is too small to set a fixture limit");
  check(
    limit < mandate.limits.maxOrderTotal.value,
    "the fixture limit would not tighten the mandate",
  );
  check(
    initial.lines.every((line) => line.gross < limit),
    "a base line is not under the fixture limit",
  );
  await step("register fixture mandate", async () => {
    const body = request(RegisterMandateRequestSchema, {
      limits: {
        ...mandate.limits,
        maxOrderTotal: { ...mandate.limits.maxOrderTotal, value: limit },
      },
      standingConstraints: mandate.standingConstraints,
      exp: mandate.exp,
    });
    const { status, data } = await call("POST", "/api/mandates", StoredMandateSchema, body);
    check(status === 201, `expected HTTP 201, got ${status}`);
    check(data.mandate.limits.maxOrderTotal.value === limit, "fixture limit was not registered");
    console.log(`     fixture order limit ${limit} EUR gross`);
  });

  // The new mandate version invalidates the initial offers.
  const quoted = await quote(call, "offers", shortlist, demo);
  check(
    quoted.lines.every((line) => line.gross < limit),
    "a base line is not under the fixture limit",
  );
  check(
    quoted.lines.reduce((total, line) => total + line.gross, 0) < limit,
    "the base quoted total is not under the fixture limit",
  );
  const placed = await placeAll(call, "place", quoted, originalRequest);
  await step("placed under the limit", async () => {
    check(placed.status === "placed", `expected status placed, got ${placed.status}`);
    check(placed.reasons.length === 0, `expected no reasons, got [${placed.reasons.join(", ")}]`);
    check(placed.total.gross < limit, `the order total is not under the ${limit} EUR limit`);
  });

  // Keep both limited-stock s3 products unchanged.
  console.log("     double s1; keep s3 and its substitute unchanged");
  const scaled = await quote(
    call,
    "offers at scale",
    shortlist.map((line) => ({
      productId: line.productId,
      quantity: {
        value: line.quantity.value * (line.productId === s1.productId ? 2 : 1),
        unit: line.quantity.unit,
      },
    })),
    demo,
  );
  check(
    scaled.lines.every((line) => line.gross < limit),
    "a scaled line is not under the spend limit",
  );
  check(
    scaled.lines.reduce((total, line) => total + line.gross, 0) > limit,
    "the scaled quoted total is not over the spend limit",
  );
  const scaledRequest = `Order ${scaled.lines
    .map((line) => {
      const original = lines.find((item) => item.productId === line.productId);
      check(original !== undefined, `no original product for ${line.productId}`);
      return `${line.quantity.value} ${line.quantity.unit} of ${original.name}`;
    })
    .join(", ")} for ${demo.requestedDate}.`;
  const pending = await placeAll(call, "place at scale", scaled, scaledRequest);
  await step("total over the limit", async () => {
    check(
      pending.status === "pending_approval",
      `expected pending_approval, got ${pending.status}`,
    );
    check(
      pending.reasons.length === 1 && pending.reasons[0] === "SPEND_OVER_LIMIT",
      `expected reasons [SPEND_OVER_LIMIT], got [${pending.reasons.join(", ")}]`,
    );
    check(pending.total.gross > limit, `the order total is not over the ${limit} EUR limit`);
    console.log(`     approvalUrl ${pending.approvalUrl ?? "none"}`);
  });
}

async function main() {
  const { scenario, baseUrl: flag, reset, databaseEnv } = parseArgs(process.argv.slice(2));
  let baseUrl = flag ?? Bun.env["PUBLIC_BASE_URL"];
  if (!baseUrl) {
    await loadRuntime();
    baseUrl = `http://127.0.0.1:${process.env["PORT"]}`;
  }
  const db = openDb(await demoDatabaseUrl(baseUrl, databaseEnv));
  let demo: DemoProducts | null;
  try {
    demo = await readDemoProducts(db);
  } finally {
    await closeDb(db);
  }
  if (!demo) throw new Error("Demo products are not configured in the catalogue database.");
  try {
    const base = baseUrl.replace(/\/$/, "");
    const call = makeClient(base);
    console.log(`scenario ${scenario} against ${base}`);
    if (scenario === 4) await runScenario4(call, reset, demo);
    else await runScenario(scenario, call, reset, demo);
    console.log(`scenario ${scenario} passed`);
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    console.error(`FAIL step ${error.stepName}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
