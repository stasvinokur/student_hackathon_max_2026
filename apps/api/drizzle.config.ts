import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shell/db/schema.ts',
  out: './drizzle',
});
