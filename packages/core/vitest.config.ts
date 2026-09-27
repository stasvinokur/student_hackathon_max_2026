import { defineConfig } from 'vitest/config';

// Tests run against @otkryvay/core sources (export condition "source"), no core build required.
// Vitest executes Node tests in the SSR environment, which has its own resolve conditions.
const conditions = ['source', 'import', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
});
