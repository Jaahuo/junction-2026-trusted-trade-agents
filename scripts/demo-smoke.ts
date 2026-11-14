// Proves demo scenarios 1 and 2 against a running server through the SPEC-003 REST routes.
// Usage: bun scripts/demo-smoke.ts --scenario 1|2 [--base-url <url>] [--no-reset] [--database-env NAME]
// It prints step names, HTTP statuses, order ids and audit event names only, never product data.
import { readDemoProducts } from "../contexts/catalog/src/api/index.ts";
import { closeDb, openDb } from "../packages/server-kit/src/index.ts";
import {
  DecideApprovalRequestSchema,
  ErrorEnvelopeSchema,
  OffersRequestSchema,
  OffersResultSchema,
  OrderSchema,
  PendingListSchema,
  PlaceOrderRequestSchema,
  SearchRequestSchema,
  SearchResultSchema,
  type DemoProducts,
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
    `${message}\nUsage: bun scripts/demo-smoke.ts --scenario 1|2 [--base-url <url>] [--no-reset] [--database-env NAME]`,
  );
  process.exit(2);
}

function parseArgs(args: string[]) {
  let scenario: 1 | 2 | undefined;
  let baseUrl: string | undefined;
  let databaseEnv: string | undefined;
  let reset = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scenario") {
      const value = args[++i];
      if (value !== "1" && value !== "2") usage("--scenario must be 1 or 2.");
      scenario = value === "1" ? 1 : 2;
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

async function runScenario(scenario: 1 | 2, baseUrl: string, reset: boolean, demo: DemoProducts) {
  const call = makeClient(baseUrl);
  const target = scenario === 1 ? demo.s1 : demo.s2;
  const terms = { deliverBy: demo.requestedDate, paymentTerms: "invoice", hard: HARD, soft: [] };
  console.log(`scenario ${scenario} against ${baseUrl}`);

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
    await runScenario(scenario, baseUrl.replace(/\/$/, ""), reset, demo);
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
