import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const relativeModulePattern = /(\b(?:from\s*|import\s*\(\s*|import\s+))(["'])(\.\.?\/[^"']+)\2/g;

function outputRelativePath(sourceRelativePath) {
  return sourceRelativePath.replace(/\.(?:[cm]?[jt]sx?|jsx)$/i, ".mjs");
}

function resolveRelativeSource(sourceRoot, fromRelativePath, specifier) {
  const base = normalize(join(dirname(fromRelativePath), specifier));
  const candidates = sourceExtensions.map((extension) => `${base}${extension}`);
  candidates.push(...sourceExtensions.map((extension) => join(base, `index${extension}`)));
  return candidates.find((candidate) => existsSync(join(sourceRoot, candidate)));
}

export async function loadWorkflowModule(relativePath) {
  const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sourceRoot = join(serviceRoot, "src");
  const rootRelativePath = join("ui", relativePath);
  const dir = mkdtempSync(join(serviceRoot, ".admin-ui-workflow-"));
  const compiled = new Set();

  function compileModule(sourceRelativePath) {
    if (compiled.has(sourceRelativePath)) {
      return;
    }
    compiled.add(sourceRelativePath);
    const source = readFileSync(join(sourceRoot, sourceRelativePath), "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      },
    }).outputText;
    const outputRelative = outputRelativePath(sourceRelativePath);
    const rewritten = transpiled.replace(relativeModulePattern, (match, prefix, quote, specifier) => {
      const targetRelative = resolveRelativeSource(sourceRoot, sourceRelativePath, specifier);
      if (targetRelative === undefined) {
        return match;
      }
      compileModule(targetRelative);
      let outputSpecifier = relative(dirname(outputRelative), outputRelativePath(targetRelative)).replace(/\\/g, "/");
      if (!outputSpecifier.startsWith(".")) {
        outputSpecifier = `./${outputSpecifier}`;
      }
      return `${prefix}${quote}${outputSpecifier}${quote}`;
    });
    const outputPath = join(dir, outputRelative);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rewritten, "utf8");
  }

  compileModule(rootRelativePath);
  try {
    return await import(pathToFileURL(join(dir, outputRelativePath(rootRelativePath))).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
