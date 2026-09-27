import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The class names the markup sets against the stylesheets of the app: a rule deleted while a screen still uses its class
// leaves that screen unstyled without a failing test. The names come from the literals of the markup: className="…",
// and the quoted strings of a className={…} or innerClassNames={{ … }} expression (a ternary of two names, a template
// up to its first ${}). A name built at runtime (`mark--${state}`) or passed in (className={className}) is not seen.

const dir = import.meta.dirname;
const files = readdirSync(dir, { recursive: true }) as string[];
const read = (file: string) => readFileSync(join(dir, file), 'utf8');
const css = files
  .filter((file) => file.endsWith('.css'))
  .map((file) => read(file).replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

/** Classes no stylesheet of the app styles, on purpose: hooks for scripts and tests. None today. */
const UNSTYLED = new Set<string>([]);

function classNames(source: string): string[] {
  const names: string[] = [];
  for (const [, literal, expression] of source.matchAll(/(?:className|innerClassNames)=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    // A string compared to (task.status === 'done') is a value, not a name.
    const strings =
      literal !== undefined
        ? [literal]
        : [...expression!.matchAll(/([=!]==\s*)?'([^']*)'|`([^`$]*)/g)].filter(([, compared]) => !compared).map(([, , quoted, template]) => quoted ?? template!);
    names.push(...strings.flatMap((s) => s.split(/\s+/)).filter((name) => name && !name.endsWith('-')));
  }
  return names;
}

describe('class names', () => {
  it('styles every class the markup sets', () => {
    const used = files.filter((file) => file.endsWith('.tsx') && !file.includes('.test.')).flatMap((file) => classNames(read(file)).map((name) => ({ file, name })));
    expect(used.length).toBeGreaterThan(50);
    const unstyled = used.filter(({ name }) => !UNSTYLED.has(name) && !new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(css));
    expect(unstyled.map(({ file, name }) => `${file}: ${name}`)).toEqual([]);
  });
});
