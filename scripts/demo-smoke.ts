// Proves demo scenarios 1, 2 and 4 against a running server through the SPEC-003 REST routes.
// Scenario 4 is the multi-product request (#127): one sentence, one order with three lines.
// Usage: bun scripts/demo-smoke.ts --scenario 1|2|4 [--base-url <url>] [--no-reset]
// It prints step names, HTTP statuses, order ids and audit event names only, never product data.
import {
  DecideApprovalRequestSchema,
  DemoProductsSchema,
  ErrorEnvelopeSchema,
  OffersRequestSchema,
  OffersResultSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  SearchRequestSchema,
  SearchResultSchema,
  StoredMandateSchema,
  type DemoProducts,
  type Order,
  type Quantity,
} from "../packages/contract/src/index.ts";
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
    `${message}\nUsage: bun scripts/demo-smoke.ts --scenario 1|2|4 [--base-url <url>] [--no-reset]`,
  );
  process.exit(2);
}

function parseArgs(args: string[]) {
  let scenario: Scenario | undefined;
  let baseUrl: string | undefined;
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
    } else if (arg === "--no-reset") reset = false;
    else usage(`Unknown argument: ${arg}`);
  }
  if (scenario === undefined) usage("Missing --scenario.");
  return { scenario, baseUrl, reset };
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

  const token = await step("offers", async () => {
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
    return offer.token;
  });

  const order = await step("place", async () => {
    const body = request(PlaceOrderRequestSchema, {
      offers: [token],
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

const S4_REQUEST =
  "Order lactose-free semi-skimmed milk, lactose-free milk drink and plain soya yoghurt for Monday.";

interface S4Line {
  readonly label: string;
  readonly terms: string[];
  readonly productId: string;
  readonly quantity: Quantity;
}

interface Quoted {
  readonly tokens: string[];
  readonly grossByLine: number[];
}

const fifth = (quantity: Quantity): Quantity => ({
  value: Math.ceil(quantity.value / 5),
  unit: quantity.unit,
});

// The three history products of the seed, at the quantities the seed history holds, so each line
// alone passes every check and only the order total can trip the spend limit.
function s4Lines(demo: DemoProducts): S4Line[] {
  const { s3 } = demo;
  if (s3 === null) throw new StepFailure("setup", "data/demo-products.json has no s3 product");
  return [
    { label: "milk", terms: ["milk"], productId: demo.s1.productId, quantity: demo.s1.quantity },
    {
      label: "milk drink",
      terms: ["milk drink"],
      productId: demo.s2.productId,
      quantity: fifth(demo.s2.quantity),
    },
    { label: "soya", terms: ["soya"], productId: s3.productId, quantity: fifth(s3.quantity) },
  ];
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
      tokens: offers.map((o) => o.token),
      grossByLine: offers.map((o) => o.claims.total.gross),
    };
  });
}

async function placeAll(call: Call, name: string, quoted: Quoted): Promise<Order> {
  return step(name, async () => {
    const body = request(PlaceOrderRequestSchema, {
      offers: quoted.tokens,
      idempotencyKey: `demo-smoke-${crypto.randomUUID()}`,
      originalRequest: S4_REQUEST,
    });
    const { status, data } = await call("POST", "/api/orders", OrderSchema, body);
    check(status === 201, `expected HTTP 201, got ${status}`);
    check(data.lines.length === 3, `expected one order with 3 lines, got ${data.lines.length}`);
    const sum = quoted.grossByLine.reduce((a, b) => a + b, 0);
    check(
      sameMoney(data.total.gross, sum),
      `expected order total ${sum.toFixed(2)} gross, got ${data.total.gross}`,
    );
    console.log(
      `     order ${data.orderId} ${data.status}, 3 lines, ${data.total.gross} EUR gross`,
    );
    return data;
  });
}

async function runScenario4(call: Call, reset: boolean, demo: DemoProducts) {
  const lines = s4Lines(demo);
  await prepare(call, reset);

  const limit = await step("mandate", async () => {
    const { data } = await call("GET", "/api/mandates/current", StoredMandateSchema);
    const max = data.mandate.limits.maxOrderTotal.value;
    console.log(`     order limit ${max} EUR gross`);
    return max;
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
          terms: line.terms,
          quantity: line.quantity,
          originalRequest: S4_REQUEST,
        });
        const { data } = await call("POST", "/api/catalog/search", SearchResultSchema, body);
        const found = data.candidates.find((c) => c.productId === line.productId);
        check(found !== undefined, `the ${line.label} product is not among the candidates`);
        check(found.orderQuantity !== null, `the ${line.label} product has no orderQuantity`);
        return { productId: found.productId, quantity: found.orderQuantity };
      }),
    );

  const quoted = await quote(call, "offers", shortlist, demo);
  const placed = await placeAll(call, "place", quoted);
  await step("placed under the limit", async () => {
    check(placed.status === "placed", `expected status placed, got ${placed.status}`);
    check(placed.reasons.length === 0, `expected no reasons, got [${placed.reasons.join(", ")}]`);
    check(placed.total.gross <= limit, `the order total is over the ${limit} EUR limit`);
  });

  // Scale every line by the same factor: each line stays under the limit, the total goes over it.
  const sum = quoted.grossByLine.reduce((a, b) => a + b, 0);
  const factor = Math.floor(limit / sum) + 1;
  const largest = Math.max(...quoted.grossByLine) * factor;
  if (largest >= limit)
    throw new StepFailure(
      "scale",
      `a ${factor}x line costs ${largest.toFixed(2)} EUR, not under the ${limit} EUR limit`,
    );
  console.log(`     scale every line by ${factor}`);
  const scaled = await quote(
    call,
    "offers at scale",
    shortlist.map((line) => ({
      productId: line.productId,
      quantity: { value: line.quantity.value * factor, unit: line.quantity.unit },
    })),
    demo,
  );
  const pending = await placeAll(call, "place at scale", scaled);
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
  const { scenario, baseUrl: flag, reset } = parseArgs(process.argv.slice(2));
  let baseUrl = flag ?? Bun.env["PUBLIC_BASE_URL"];
  if (!baseUrl) {
    await loadRuntime();
    baseUrl = `http://127.0.0.1:${process.env["PORT"]}`;
  }
  const demo = DemoProductsSchema.parse(await Bun.file(`${ROOT}/data/demo-products.json`).json());
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
