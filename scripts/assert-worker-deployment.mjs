import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const safeIdentity = /^[A-Za-z0-9_-]{1,128}$/u;
const versionIdentity = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const maxInputBytes = 64 * 1024;
const allowedWorkers = new Set(["backend", "admin", "portal", "backup"]);

export function parseDeploymentAssertionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--expected-deployment-id" || argv[2] !== "--expected-version-id") {
    throw new Error("usage: node scripts/assert-worker-deployment.mjs --expected-deployment-id <id> --expected-version-id <uuid>");
  }
  const deploymentId = argv[1];
  const versionId = argv[3];
  if (!safeIdentity.test(deploymentId) || !versionIdentity.test(versionId)) {
    throw new Error("expected Worker deployment identities are invalid");
  }
  return Object.freeze({ deploymentId, versionId });
}

export function parseSanitizedDeployment(input, expectedWorker) {
  if (!allowedWorkers.has(expectedWorker)) throw new Error("expected Worker identity is invalid");
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("sanitized Worker deployment evidence is malformed");
  }
  const deployment = parsed?.deployment;
  const versions = deployment?.versions;
  if (
    parsed?.schema_version !== 1
    || parsed?.worker !== expectedWorker
    || !safeIdentity.test(deployment?.deployment_id ?? "")
    || typeof deployment?.created_on !== "string"
    || !Array.isArray(versions)
    || versions.length < 1
    || versions.length > 2
    || versions.some((version) => !versionIdentity.test(version?.version_id ?? "") || typeof version?.percentage !== "number" || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100)
    || Math.abs(versions.reduce((total, version) => total + version.percentage, 0) - 100) > 0.000001
  ) {
    throw new Error("sanitized Worker deployment evidence has an invalid shape");
  }
  return Object.freeze({
    schema_version: 1,
    worker: expectedWorker,
    deployment: Object.freeze({
      deployment_id: deployment.deployment_id,
      created_on: deployment.created_on,
      versions: Object.freeze(versions.map((version) => Object.freeze({ version_id: version.version_id, percentage: version.percentage }))),
    }),
  });
}

export function assertWorkerDeployment(input, expected) {
  const parsed = parseSanitizedDeployment(input, "backend");
  const deployment = parsed.deployment;
  const versions = deployment.versions;
  if (deployment.deployment_id !== expected.deploymentId || versions.length !== 1 || versions[0].percentage !== 100 || versions[0].version_id !== expected.versionId) {
    throw new Error("active Worker deployment does not match the approved capacity target");
  }
  return parsed;
}

async function readBoundedStandardInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxInputBytes) throw new Error("deployment evidence exceeded the bounded parser limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const expected = parseDeploymentAssertionArguments(process.argv.slice(2));
    const input = await readBoundedStandardInput();
    console.log(JSON.stringify(assertWorkerDeployment(input, expected)));
  } catch {
    console.error("Worker deployment could not be bound to the approved capacity target.");
    process.exitCode = 1;
  }
}
