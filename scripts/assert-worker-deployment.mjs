// Parses the sanitized Worker deployment evidence that capture-worker-deployment-transition.mjs
// records before and after a deploy. It accepts only the exact sanitized shape for one known Worker.
const safeIdentity = /^[A-Za-z0-9_-]{1,128}$/u;
const versionIdentity = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const allowedWorkers = new Set(["backend", "admin", "portal", "backup"]);

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
