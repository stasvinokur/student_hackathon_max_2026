import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Modules that perform I/O or belong to the imperative shell.
// The functional core (packages/core) must never import them.
const SHELL_ONLY_MODULES = [
  'fs',
  'fs/promises',
  'net',
  'http',
  'https',
  'http2',
  'child_process',
  'dgram',
  'dns',
  'tls',
  'worker_threads',
  'cluster',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'backlog/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/miniapp/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Test data of the core (tinyLocationIndex…) must never reach the API or the mini-app bundle.
    files: ['apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.*'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@otkryvay/core/testing', message: 'Test data of the core: import it only in *.test.* files.' }] },
      ],
      // no-restricted-imports does not see import(): a lazy chunk must not load the test data either.
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value='@otkryvay/core/testing']",
          message: 'Test data of the core: import it only in *.test.* files.',
        },
      ],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: SHELL_ONLY_MODULES.flatMap((name) => [
            { name, message: 'Functional core must stay free of I/O — move this to the shell (apps/*).' },
            { name: `node:${name}`, message: 'Functional core must stay free of I/O — move this to the shell (apps/*).' },
          ]),
          patterns: [
            {
              group: ['@otkryvay/api', '@otkryvay/api/*', '@otkryvay/miniapp', '@otkryvay/miniapp/*', '**/apps/**'],
              message: 'Core must not depend on the shell: dependencies point from apps/* to core only.',
            },
            {
              group: ['@maxhub/*', 'fastify', 'fastify/*', '@fastify/*', 'drizzle-orm', 'drizzle-orm/*', 'pg', 'postgres', 'react', 'react-dom'],
              message: 'SDKs, web frameworks, DB drivers and UI belong to the shell (apps/*), not to the functional core.',
            },
          ],
        },
      ],
    },
  },
);
