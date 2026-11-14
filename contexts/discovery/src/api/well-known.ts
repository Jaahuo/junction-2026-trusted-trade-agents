import {
  APPROVAL_REASONS,
  GUARDRAILS,
  MODEL_TOOLS,
  PAYMENT_TERMS,
  REASON_TEXT,
  REJECT_REASONS,
  VIEW_TOOLS,
  VIEWS,
} from "@app/contract";

/** The SPEC-014 discovery document. Every URL is absolute under `baseUrl`. */
export const discoveryDocument = (baseUrl: string) => ({
  endpoint: baseUrl,
  mcp: `${baseUrl}/mcp`,
  jwksUri: `${baseUrl}/.well-known/jwks.json`,
  openapi: `${baseUrl}/api/discovery/openapi.json`,
  skill: `${baseUrl}/skills/trusted-trade-ordering/SKILL.md`,
  authorization: null,
  guardrails: GUARDRAILS,
  paymentTerms: PAYMENT_TERMS,
  reasonCodes: [
    ...APPROVAL_REASONS.map((code) => ({ code, outcome: "approval", text: REASON_TEXT[code] })),
    ...REJECT_REASONS.map((code) => ({ code, outcome: "reject", text: REASON_TEXT[code] })),
  ],
  tools: { model: MODEL_TOOLS, view: VIEW_TOOLS },
  views: VIEWS,
});
