// @ts-check
import prettierConfig from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config({
  ignores: ["dist/**", "node_modules/**", "coverage/**"],
  extends: [tseslint.configs.recommended, prettierConfig],
  files: ["src/**/*.ts", "tests/**/*.ts"],
  languageOptions: {
    parserOptions: {
      // Type-aware lint stays on the TypeScript 6 API (`typescript` -> @typescript/typescript6).
      // TypeScript 7 (`@typescript/native`) has no compiler API yet, so `tsc` and ESLint cannot share one package.
      // Remove this split when typescript-eslint supports the stable TypeScript 7 API: one `"typescript": "^7"`.
      project: ["./tsconfig.json", "./tsconfig.test.json"],
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/explicit-function-return-type": [
      "error",
      { allowExpressions: true, allowTypedFunctionExpressions: true },
    ],
    "@typescript-eslint/consistent-type-imports": [
      "error",
      { prefer: "type-imports" },
    ],
    "@typescript-eslint/no-import-type-side-effects": "error",

    "no-console": "warn",
  },
});
