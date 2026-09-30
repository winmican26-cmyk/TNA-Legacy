import js from '@eslint/js';
import tseslint from 'typescript-eslint';
// TNA Client Control Center & Assurance UI v0.1 (Volume 13): the web frontend (`apps/tna-control-center
// -web`) is a separate Vite/React/browser TypeScript project with its own `tsconfig.json` (DOM lib, JSX,
// bundler resolution) — it is not part of this repo's single Node-targeted `tsc` project, and linting it
// here would need a browser/React-aware config this pass does not add. It is checked instead via its own
// `npm run typecheck`/`npm run build` (wired into `smoke:control-center:v01`). Documented gap, not silent.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.npm-cache/**', 'data/**', 'apps/tna-control-center-web/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Honor the codebase's existing "intentionally unused" convention: a leading underscore marks a
    // binding kept only to destructure-omit a field (e.g. `const { approverRole: _ar, ...req } = request`
    // strips `approverRole` before forwarding `req`). The recommended preset does not enable this
    // ignore-pattern by default; enabling it is the standard, idiomatic way to make that convention lint
    // clean without reshaping the many call sites that already use it. Behavior is unchanged.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
);
