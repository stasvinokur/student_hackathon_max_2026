import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRulesPack, type PackIssue, type RulesPack } from '@otkryvay/core';
import { parse as parseYaml } from 'yaml';

/** Directory of the @otkryvay/content workspace package (works in dev and in the deployed image). */
export const CONTENT_DIR = dirname(fileURLToPath(import.meta.resolve('@otkryvay/content/package.json')));

export class PackLoadError extends Error {
  constructor(
    readonly packId: string,
    readonly issues: PackIssue[],
  ) {
    super(`Rules pack "${packId}" is invalid:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'PackLoadError';
  }
}

async function readYaml(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, 'utf8'));
}

/** Reads content/<packId>/pack.yaml and validates it. Throws PackLoadError: an invalid pack is never loaded. */
export async function loadRulesPack(packId: string, contentDir: string = CONTENT_DIR): Promise<RulesPack> {
  const raw = await readYaml(join(contentDir, packId, 'pack.yaml'));
  const result = parseRulesPack(raw);
  if (!result.ok) throw new PackLoadError(packId, result.issues);
  return result.pack;
}

/** Reads content/<packId>/fixtures.yaml (reference profiles and expected routes). */
export async function loadPackFixtures(packId: string, contentDir: string = CONTENT_DIR): Promise<unknown> {
  return readYaml(join(contentDir, packId, 'fixtures.yaml'));
}
