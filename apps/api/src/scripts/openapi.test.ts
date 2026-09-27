import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildOpenApiYaml } from './openapi-spec.js';

const OPENAPI = new URL('../../../../openapi.yaml', import.meta.url);

describe('openapi.yaml', () => {
  it('is up to date with the route schemas (run `pnpm --filter @otkryvay/api openapi` to refresh)', async () => {
    const committed = await readFile(OPENAPI, 'utf8');
    expect(committed).toBe(await buildOpenApiYaml());
  });

  it('reads the same with a YAML 1.1 parser, which takes a bare off or n for a boolean', async () => {
    const committed = await readFile(OPENAPI, 'utf8');
    expect(parse(committed, { version: '1.1' })).toEqual(parse(committed));
  });
});
