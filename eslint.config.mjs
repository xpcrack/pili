import { defineConfig, globalIgnores } from "eslint/config";

// Minimal eslint: Next is no longer the runtime. Prefer tsc --noEmit for types.
const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    ".worktrees/**",
    "node_modules/**",
  ]),
]);

export default eslintConfig;
