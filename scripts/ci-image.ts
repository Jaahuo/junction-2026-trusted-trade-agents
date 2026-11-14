import { $ } from "bun";

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

const digestPattern = /^sha256:[0-9a-f]{64}$/;

const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && !Array.isArray(value) && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const archiveMember = async (archive: string, name: string): Promise<Uint8Array> => {
  const result = await $`tar -xOf ${archive} ${name}`.nothrow().quiet();
  if (result.exitCode !== 0) throw new Error(`Image archive has no ${name}`);
  return result.stdout;
};

const verifiedBlob = async (archive: string, digest: unknown): Promise<Uint8Array> => {
  if (typeof digest !== "string" || !digestPattern.test(digest))
    throw new Error("Invalid image archive digest");
  const blob = await archiveMember(archive, `blobs/sha256/${digest.slice(7)}`);
  const actual = `sha256:${new Bun.CryptoHasher("sha256").update(blob).digest("hex")}`;
  if (actual !== digest) throw new Error(`Image archive blob ${digest} has digest ${actual}`);
  return blob;
};

/**
 * The config digest of the single image in an OCI image archive. Docker's classic image store
 * reports it as the image Id; the containerd store reports the manifest digest instead, so
 * delivery compares this value, which every store and registry agree on.
 */
export async function archiveConfigDigest(archive: string): Promise<string> {
  const index: unknown = JSON.parse(
    new TextDecoder().decode(await archiveMember(archive, "index.json")),
  );
  const manifests = field(index, "manifests");
  if (!Array.isArray(manifests) || manifests.length !== 1)
    throw new Error("Image archive must hold exactly one manifest");
  const manifest: unknown = JSON.parse(
    new TextDecoder().decode(await verifiedBlob(archive, field(manifests[0], "digest"))),
  );
  const config = field(field(manifest, "config"), "digest");
  await verifiedBlob(archive, config);
  if (typeof config !== "string") throw new Error("Invalid image config digest");
  return config;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "config-digest") {
      console.log(await archiveConfigDigest(process.argv[3] ?? ""));
    } else {
      const blocking = validateImageReport(await Bun.file(process.argv[2] ?? "").text());
      if (blocking) throw new Error(`Image contains ${blocking} high or critical vulnerabilities`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
