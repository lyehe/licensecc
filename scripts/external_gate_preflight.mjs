import { fileURLToPath } from "node:url";
import {
  EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS,
} from "./release_gate_contract.mjs";

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/external_gate_preflight.mjs [--json]

Checks whether the environment contains the required staging inputs for the
Cloudflare Access admin and R2 restore release drills. Secret values are never
printed.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 2; index < argv.length; ++index) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function envHasValue(env, name) {
  return typeof env[name] === "string" && env[name] !== "";
}

function envTruthy(env, name) {
  return /^(1|true|yes|on)$/i.test(String(env[name] ?? ""));
}

function envSatisfiesVariable(env, variable) {
  return variable.truthy === true ? envTruthy(env, variable.name) : envHasValue(env, variable.name);
}

function describeVariable(env, variable) {
  return {
    name: variable.name,
    present: envSatisfiesVariable(env, variable),
    secret: variable.secret === true,
    truthy: variable.truthy === true,
  };
}

function analyzeExternalGateEnv(env = process.env) {
  const gates = EXTERNAL_GATE_GROUPS.map((group) => {
    const required = group.required.map((variable) => describeVariable(env, variable));
    const credential_alternatives = (group.credential_alternatives ?? [])
      .map((variable) => describeVariable(env, variable));
    const optional = group.optional.map((variable) => describeVariable(env, variable));
    const missing = required.filter((variable) => !variable.present).map((variable) => variable.name);
    if (credential_alternatives.length > 0 && !credential_alternatives.some((variable) => variable.present)) {
      missing.push(credential_alternatives.map((variable) => variable.name).join(" or "));
    }
    return {
      id: group.id,
      label: group.label,
      ready: missing.length === 0,
      missing,
      required,
      credential_alternatives,
      optional,
    };
  });
  const missing = gates.flatMap((gate) => gate.missing);
  return {
    ok: missing.length === 0,
    ready: missing.length === 0,
    missing,
    gates,
  };
}

function printHuman(result) {
  if (result.ready) {
    console.log("external release gate inputs are present");
  } else {
    console.log("external release gate inputs are incomplete");
  }
  for (const gate of result.gates) {
    console.log(`\n${gate.label}: ${gate.ready ? "ready" : "missing inputs"}`);
    for (const variable of gate.required) {
      const secrecy = variable.secret ? " secret" : "";
      console.log(`  required${secrecy} ${variable.name}: ${variable.present ? "present" : "missing"}`);
    }
    if (gate.credential_alternatives.length > 0) {
      console.log("  credential alternatives:");
      for (const variable of gate.credential_alternatives) {
        const secrecy = variable.secret ? " secret" : "";
        console.log(`    alternative${secrecy} ${variable.name}: ${variable.present ? "present" : "missing"}`);
      }
    }
    for (const variable of gate.optional) {
      const secrecy = variable.secret ? " secret" : "";
      console.log(`  optional${secrecy} ${variable.name}: ${variable.present ? "present" : "missing"}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv);
  const result = analyzeExternalGateEnv();
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  if (!result.ready) {
    process.exit(1);
  }
}

export {
  EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS,
  analyzeExternalGateEnv,
  parseArgs,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
