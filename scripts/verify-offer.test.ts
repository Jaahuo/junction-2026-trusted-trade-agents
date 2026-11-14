import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTHeaderParameters } from "jose";
import { fileURLToPath } from "node:url";

test("verifies offers using the issuer's published discovery and JWKS", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = "fictional-offer-key";
  const paths: string[] = [];
  const jwksPath = "/keys/fictional-offers.json";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, runningServer) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const base = `http://127.0.0.1:${runningServer.port}`;
      if (path === "/.well-known/trusted-trade.json") {
        // Discovery and JWKS shapes recorded 2026-11-14; identifiers and keys are invented.
        return Response.json({
          endpoint: base,
          mcp: `${base}/mcp`,
          jwksUri: `${base}${jwksPath}`,
          openapi: `${base}/api/discovery/openapi.json`,
          skill: `${base}/skills/trusted-trade-ordering/SKILL.md`,
          authorization: null,
        });
      }
      if (path === jwksPath) {
        return Response.json({
          keys: [
            {
              kty: "EC",
              crv: "P-256",
              x: publicJwk.x,
              y: publicJwk.y,
              kid,
              alg: "ES256",
              use: "sig",
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const now = Math.floor(Date.now() / 1000);
  const claims = { offerId: "fictional-offer", customer: "fictional-customer", total: 42 };
  const sign = (
    payload: Record<string, unknown>,
    header: JWTHeaderParameters = { alg: "ES256", kid, typ: "offer+jwt" },
  ) => new SignJWT(payload).setProtectedHeader(header).sign(privateKey);
  const run = async (token: string) => {
    const script = fileURLToPath(new URL("./verify-offer.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, script, base, token], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  try {
    const payload = { ...claims, iss: base, iat: now, exp: now + 3600 };
    const token = await sign(payload);
    const success = await run(token);
    expect(success.exitCode).toBe(0);
    expect(JSON.parse(success.stdout)).toEqual({ issuer: base, keyId: kid, claims: payload });
    expect(paths).toEqual(["/.well-known/trusted-trade.json", jwksPath]);

    const [header, , signature] = token.split(".");
    const alteredPayload = Buffer.from(JSON.stringify({ ...payload, total: 43 })).toString(
      "base64url",
    );
    const changed = await run(`${header}.${alteredPayload}.${signature}`);
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr).toMatch(/signature/i);

    const expired = await run(await sign({ ...payload, iat: now - 7200, exp: now - 3600 }));
    expect(expired.exitCode).not.toBe(0);
    expect(expired.stderr).toMatch(/expir/i);

    const cases: Array<[string, RegExp]> = [
      [await sign({ ...payload, iss: "https://other.example" }), /iss.*claim/i],
      [await sign({ ...claims, iss: base, iat: now }), /exp.*claim/i],
      [await sign(payload, { alg: "ES256", kid, typ: "JWT" }), /typ/i],
      [await sign(payload, { alg: "ES256", typ: "offer+jwt" }), /kid/i],
      [
        await sign(payload, { alg: "ES256", kid: "unknown-key", typ: "offer+jwt" }),
        /no applicable key/i,
      ],
    ];
    for (const [invalid, reason] of cases) {
      const result = await run(invalid);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(reason);
    }
  } finally {
    await server.stop(true);
  }
});
