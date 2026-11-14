export function validateImageReport(raw: string): number {
  const report: unknown = JSON.parse(raw);
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !("Results" in report) ||
    !Array.isArray(report.Results)
  )
    throw new Error("Invalid Trivy report");
  const results: unknown[] = report.Results;
  let os = false;
  let node = false;
  let blocking = 0;
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid Trivy result");
    if (
      !("Class" in item) ||
      typeof item.Class !== "string" ||
      !("Type" in item) ||
      typeof item.Type !== "string" ||
      !("Target" in item) ||
      typeof item.Target !== "string"
    )
      throw new Error("Invalid Trivy result identity");
    const packages = "Packages" in item ? item.Packages : undefined;
    if (packages !== undefined && !Array.isArray(packages))
      throw new Error("Invalid package inventory");
    if (Array.isArray(packages) && packages.length > 0) {
      if (item.Class === "os-pkgs") os = true;
      if (
        item.Class === "lang-pkgs" &&
        item.Type === "node-pkg" &&
        packages.some(
          (pkg: unknown) =>
            pkg !== null &&
            typeof pkg === "object" &&
            "FilePath" in pkg &&
            typeof pkg.FilePath === "string" &&
            pkg.FilePath.includes("node_modules/.bun/"),
        )
      )
        node = true;
    }
    const vulnerabilities = "Vulnerabilities" in item ? item.Vulnerabilities : undefined;
    if (vulnerabilities !== undefined && !Array.isArray(vulnerabilities))
      throw new Error("Invalid vulnerabilities");
    for (const vulnerability of vulnerabilities ?? []) {
      if (!vulnerability || typeof vulnerability !== "object" || Array.isArray(vulnerability))
        throw new Error("Invalid vulnerability");
      if (!("Severity" in vulnerability)) throw new Error("Missing vulnerability severity");
      const severity = vulnerability.Severity;
      if (
        typeof severity !== "string" ||
        !["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)
      )
        throw new Error("Invalid vulnerability severity");
      if (severity === "HIGH" || severity === "CRITICAL") blocking++;
    }
  }
  if (!os || !node)
    throw new Error("Trivy did not inventory OS packages and installed .bun Node packages");
  return blocking;
}

if (import.meta.main) {
  try {
    const blocking = validateImageReport(await Bun.file(process.argv[2] ?? "").text());
    if (blocking) throw new Error(`Image contains ${blocking} high or critical vulnerabilities`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
