export function validateAudit(raw: string, exitCode: number): number {
  if (exitCode !== 0 && exitCode !== 1)
    throw new Error(`bun audit failed with exit code ${exitCode}`);
  const report: unknown = JSON.parse(raw);
  if (!report || typeof report !== "object" || Array.isArray(report))
    throw new Error("Invalid audit report");
  let findings = 0;
  let blocking = 0;
  for (const [name, advisories] of Object.entries(report)) {
    if (!name || !Array.isArray(advisories) || advisories.length === 0)
      throw new Error("Invalid audit advisories");
    for (const advisory of advisories) {
      if (
        !advisory ||
        typeof advisory !== "object" ||
        Array.isArray(advisory) ||
        !["low", "moderate", "high", "critical"].includes(advisory.severity) ||
        !(
          (typeof advisory.id === "string" && advisory.id.length > 0) ||
          (typeof advisory.id === "number" && Number.isSafeInteger(advisory.id) && advisory.id > 0)
        ) ||
        typeof advisory.title !== "string" ||
        !advisory.title ||
        typeof advisory.url !== "string" ||
        !advisory.url
      )
        throw new Error("Invalid audit advisory");
      findings++;
      if (advisory.severity === "high" || advisory.severity === "critical") blocking++;
    }
  }
  if ((exitCode === 0) !== (findings === 0))
    throw new Error("Audit exit code disagrees with report");
  return blocking;
}

if (import.meta.main) {
  try {
    const exitCode = Number(process.argv[3]);
    const blocking = validateAudit(await Bun.file(process.argv[2] ?? "").text(), exitCode);
    if (blocking) throw new Error(`bun audit found ${blocking} high or critical advisories`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
