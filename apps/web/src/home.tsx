import { Card, CardTitle, PageHeader } from "@app/ui";
import { Link } from "wouter";

export function Home() {
  return (
    <>
      <PageHeader
        title="Home"
        description="Valio Aimo helps food-service buyers' agents order within buyer limits, with human approval for exceptions."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Approvals</CardTitle>
          <p className="mb-3 text-muted">Review exceptions that need a buyer approver.</p>
          <Link href="/approvals" className="text-primary underline hover:text-primary-hover">
            View approvals
          </Link>
        </Card>
        <Card>
          <CardTitle>Agent activity</CardTitle>
          <p className="mb-3 text-muted">See agent activity as a wholesaler.</p>
          <Link href="/activity" className="text-primary underline hover:text-primary-hover">
            View agent activity
          </Link>
        </Card>
      </div>
      <section className="mt-4" aria-labelledby="contract-heading">
        <h2 id="contract-heading" className="mb-3 text-lg font-semibold">
          Contract
        </h2>
        <ul className="flex flex-col gap-2">
          <li>
            <a
              className="break-all text-primary underline hover:text-primary-hover"
              href="/.well-known/trusted-trade.json"
            >
              Trusted trade discovery
            </a>
          </li>
          <li>
            <a
              className="break-all text-primary underline hover:text-primary-hover"
              href="/api/discovery/openapi.json"
            >
              OpenAPI specification
            </a>
          </li>
          <li>
            <a
              className="break-all text-primary underline hover:text-primary-hover"
              href="/.well-known/jwks.json"
            >
              JSON Web Key Set
            </a>
          </li>
          <li>
            <a
              className="break-all text-primary underline hover:text-primary-hover"
              href="/skills/trusted-trade-ordering/SKILL.md"
            >
              Trusted trade ordering skill
            </a>
          </li>
        </ul>
      </section>
    </>
  );
}
