import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRulesPack, PackLoadError } from './load.js';

async function packDir(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'otkryvay-pack-'));
  await mkdir(join(dir, 'demo'));
  await writeFile(join(dir, 'demo', 'pack.yaml'), yaml);
  return dir;
}

const manifest = `
manifest:
  id: demo
  version: 1.0.0
  title: Demo
  region: { code: kazan, name: Казань }
  industry: coffee
  checked_at: 2026-09-18
  cities: [kazan]
`;

describe('loadRulesPack', () => {
  it('loads a valid YAML pack', async () => {
    const dir = await packDir(`${manifest}
actions:
  - id: open-account
    title: Открыть счёт
    lane: support
    duration_days: 1
    why: Удобно принимать оплату
    do_now: Выбрать банк
    done_when: Счёт открыт
    kind: recommendation
`);
    const pack = await loadRulesPack('demo', dir);
    expect(pack.actions.map((a) => a.id)).toEqual(['open-account']);
  });

  it('refuses to load a pack with a critical card without a source', async () => {
    const dir = await packDir(`${manifest}
actions:
  - id: register-business
    title: Зарегистрировать ИП
    lane: critical
    duration_days: 5
    why: w
    do_now: d
    done_when: x
    kind: test_data
`);
    const error = await loadRulesPack('demo', dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackLoadError);
    expect((error as PackLoadError).message).toContain('actions[register-business].source.url');
  });
});
