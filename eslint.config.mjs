import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import globals from "globals";

const sourceFiles = [
  "packages/*/src/**/*.{js,mjs,ts,tsx}",
  "services/cloudflare-licensing-backend/src/**/*.{js,mjs,ts,tsx}",
  "services/cloudflare-license-admin/src/**/*.{js,mjs,ts,tsx}",
  "services/cloudflare-customer-portal/src/**/*.{js,mjs,ts,tsx}",
  "services/cloudflare-d1-backup/src/**/*.{js,mjs,ts,tsx}",
  "scripts/**/*.{js,mjs,ts,tsx}",
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-worker/**",
      "**/.wrangler/**",
      "build/**",
      "doc/_build/**",
      "doc/_doxygen/**",
      "extern/**",
    ],
  },
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      // TypeScript owns unused-name and undefined-symbol diagnostics.  Enabling
      // the core variants here would double-report types and Worker bindings.
      "no-unused-vars": "off",
      "no-undef": "off",
      // Type-only imports are deliberately allowed separately.  This preserves
      // `import type` erasure while still rejecting duplicate runtime imports.
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "import/no-duplicates": "error",
      "import/first": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-duplicate-enum-values": "error",
      "@typescript-eslint/no-dupe-class-members": "error",
    },
  },
  {
    files: [
      "services/cloudflare-license-admin/src/ui/**/*.{jsx,tsx}",
      "services/cloudflare-customer-portal/src/ui/**/*.{jsx,tsx}",
    ],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react/jsx-key": "error",
      "react/no-unknown-property": "error",
      "react/react-in-jsx-scope": "off",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
