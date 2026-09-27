// Generates openapi.yaml in the repository root (not in apps/api) from the route schemas, no database or bot needed:
//   pnpm --filter @otkryvay/api openapi
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildOpenApiYaml } from './openapi-spec.js';

const target = fileURLToPath(new URL('../../../../openapi.yaml', import.meta.url));
await writeFile(target, await buildOpenApiYaml());
console.log(`written ${target}`);
