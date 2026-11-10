export const VERSION_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
export const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

// The name and code fields are part of the existing sanitized rollback error contract.
export class SafeRollbackError extends Error {
  constructor(code, message, { worker } = {}) {
    super(message);
    this.name = "SafeRollbackError";
    this.code = code;
    this.worker = worker;
  }
}

function fail(code, message, worker) {
  throw new SafeRollbackError(code, message, worker ? { worker } : undefined);
}

function asTimestamp(value, code, worker) {
  if (typeof value !== "string" || value.length > 64) fail(code, "Wrangler returned an invalid deployment timestamp.", worker);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code, "Wrangler returned an invalid deployment timestamp.", worker);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function strictJson(stdout, code, worker) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") === 0 || Buffer.byteLength(stdout, "utf8") > 1024 * 1024 || stdout.includes("\0")) {
    fail(code, "Wrangler returned malformed JSON.", worker);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail(code, "Wrangler returned malformed JSON.", worker);
  }
}

export function parseVersionView(stdout, expectedVersionId, worker) {
  const parsed = strictJson(stdout, "MALFORMED_VERSION_JSON", worker);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.id !== expectedVersionId || !parsed.metadata || typeof parsed.metadata !== "object" || Array.isArray(parsed.metadata)) {
    fail("INVALID_VERSION_RESPONSE", "Wrangler did not validate the requested Worker version.", worker);
  }
  const created = asTimestamp(parsed.metadata.created_on, "INVALID_VERSION_RESPONSE", worker);
  return Object.freeze({ version_id: expectedVersionId, created_on: created.iso });
}

export function parseDeploymentList(stdout, worker) {
  const parsed = strictJson(stdout, "MALFORMED_DEPLOYMENT_JSON", worker);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) {
    fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned no valid deployments.", worker);
  }
  const deployments = parsed.map((deployment) => {
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment) || !Array.isArray(deployment.versions) || deployment.versions.length === 0 || deployment.versions.length > 2) {
      fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned a malformed deployment.", worker);
    }
    if (typeof deployment.id !== "string" || !DEPLOYMENT_ID_PATTERN.test(deployment.id)) {
      fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned an invalid deployment identity.", worker);
    }
    const created = asTimestamp(deployment.created_on, "INVALID_DEPLOYMENT_RESPONSE", worker);
    const versions = deployment.versions.map((version) => {
      if (!version || typeof version !== "object" || Array.isArray(version) || !VERSION_ID_PATTERN.test(version.version_id) || typeof version.percentage !== "number" || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100) {
        fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned a malformed deployment version.", worker);
      }
      return Object.freeze({ version_id: version.version_id, percentage: version.percentage });
    }).sort((left, right) => left.version_id.localeCompare(right.version_id));
    const totalPercentage = versions.reduce((total, version) => total + version.percentage, 0);
    if (Math.abs(totalPercentage - 100) > 0.000001) fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned an invalid traffic allocation.", worker);
    return {
      milliseconds: created.milliseconds,
      identity: Object.freeze({ deployment_id: deployment.id, created_on: created.iso, versions }),
    };
  });
  deployments.sort((left, right) => left.milliseconds - right.milliseconds || left.identity.deployment_id.localeCompare(right.identity.deployment_id));
  return deployments.at(-1).identity;
}
