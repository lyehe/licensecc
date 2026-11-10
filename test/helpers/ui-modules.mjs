import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";

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

// One compiled graph preserves module identities such as React contexts and proof symbols.
export async function loadUiModules(serviceRoot, relativePaths) {
  const root = resolve(serviceRoot);
  const sourceRoot = join(root, "src");
  const dir = mkdtempSync(join(root, ".ui-modules-"));
  const compiled = new Set();

  function compileModule(sourceRelativePath) {
    if (compiled.has(sourceRelativePath)) return;
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
      if (targetRelative === undefined) return match;
      compileModule(targetRelative);
      let outputSpecifier = relative(dirname(outputRelative), outputRelativePath(targetRelative)).replace(/\\/g, "/");
      if (!outputSpecifier.startsWith(".")) outputSpecifier = `./${outputSpecifier}`;
      return `${prefix}${quote}${outputSpecifier}${quote}`;
    });
    const outputPath = join(dir, outputRelative);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rewritten, "utf8");
  }

  try {
    relativePaths.forEach(compileModule);
    return await Promise.all(relativePaths.map((path) => import(pathToFileURL(join(dir, outputRelativePath(path))).href)));
  } finally {
    if (dirname(resolve(dir)) !== root) throw new Error("UI test output escaped its service root");
    rmSync(dir, { recursive: true, force: true });
  }
}
