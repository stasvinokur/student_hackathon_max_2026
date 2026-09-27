import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// organic.css against what reads it: MAX UI must read every token the file sets for it (a token MAX UI renamed or never
// had would leave a colour of MAX), the styles of the app must read only --o- tokens the file sets, and the semantic
// pairs must keep the contrast the file promises, in both themes.

const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const organic = read(join(import.meta.dirname, 'organic.css'));
const maxUi = read(createRequire(import.meta.url).resolve('@maxhub/max-ui/dist/styles.css'));

/** The custom properties set by the rule with exactly this selector. */
function block(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(organic)?.[1];
  if (body === undefined) throw new Error(`no rule ${selector} in organic.css`);
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

const light = block(':root');
const dark = new Map([...light, ...block(":root[data-theme='dark']")]);

/** The colour of a token as [r, g, b] in 0…1, var() followed to the end. */
function rgb(theme: Map<string, string>, name: string): number[] {
  let value = theme.get(name);
  for (let m; value && (m = /^var\((--o-[\w-]+)\)$/.exec(value)); ) value = theme.get(m[1]!);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value ?? '')?.[1];
  if (!hex) throw new Error(`${name} is no opaque hex colour: ${value}`);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

function contrast(theme: Map<string, string>, a: string, b: string): number {
  const luminance = (name: string) => {
    const [r, g, b] = rgb(theme, name).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('organic.css', () => {
  it('sets for MAX UI only tokens MAX UI reads', () => {
    const names = [...block(':root .organic').keys()];
    expect(names.length).toBeGreaterThan(40);
    // `var(--name` then `)` or `,`: --button-secondary must not pass on --button-secondary-contrast.
    expect(names.filter((name) => !new RegExp(`var\\(${name}[,)]`).test(maxUi))).toEqual([]);
  });

  it('sets on MAX UI components only the inner properties of theirs MAX UI reads', () => {
    // The styles of the app may set a --MaxUi- property of a component (the overlay of a pressed row): one MAX UI
    // renamed or never had would leave its colour silently.
    const files = (readdirSync(import.meta.dirname, { recursive: true }) as string[]).filter((file) => file.endsWith('.css'));
    const names = [...new Set(files.flatMap((file) => [...read(join(import.meta.dirname, file)).matchAll(/(--MaxUi-[\w-]+)\s*:/g)].map(([, name]) => name!)))];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !new RegExp(`var\\(${name}[,)]`).test(maxUi))).toEqual([]);
  });

  it('sets every --o- token the styles of the app read, and the dark theme only re-sets them', () => {
    const files = (readdirSync(import.meta.dirname, { recursive: true }) as string[]).filter((file) => file.endsWith('.css'));
    const missing = files.flatMap((file) =>
      [...read(join(import.meta.dirname, file)).matchAll(/var\((--o-[\w-]+)/g)].map(([, name]) => name!).filter((name) => !light.has(name)).map((name) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
    expect([...block(":root[data-theme='dark']").keys()].filter((name) => !light.has(name))).toEqual([]);
  });

  // [text or icon, the fill under it, the least contrast]: 4.5:1 for text, 3:1 for icons and the boundaries of controls.
  const TEXT = 4.5;
  const UI = 3;
  const PAIRS: [string, string, number][] = [
    ...['--o-bg', '--o-surface', '--o-card-fill', '--o-card-fill-hover', '--o-button-fill', '--o-button-fill-hover', '--o-button-fill-pressed', '--o-sage-soft'].map(
      (fill): [string, string, number] => ['--o-text', fill, TEXT],
    ),
    ['--o-bg', '--o-text', TEXT], // the current section, a pill of text colour
    ...['--o-bg', '--o-surface', '--o-card-fill'].map((fill): [string, string, number] => ['--o-secondary-text', fill, TEXT]),
    ...['--o-bg', '--o-surface', '--o-card-fill', '--o-card-fill-hover', '--o-sage-soft'].map((fill): [string, string, number] => ['--o-muted-text', fill, TEXT]),
    ...['--o-bg', '--o-surface', '--o-card-fill', '--o-accent-soft'].map((fill): [string, string, number] => ['--o-accent-text', fill, TEXT]),
    ...['--o-bg', '--o-card-fill', '--o-sage-soft', '--o-rank-fill'].map((fill): [string, string, number] => ['--o-sage-text', fill, TEXT]),
    ...['--o-bg', '--o-card-fill', '--o-amber-soft'].map((fill): [string, string, number] => ['--o-amber-text', fill, TEXT]),
    ...['--o-accent-fill', '--o-accent-fill-hover', '--o-accent-fill-pressed'].map((fill): [string, string, number] => ['--o-accent-on-fill', fill, TEXT]),
    ['--o-sage-on-fill', '--o-sage-fill', TEXT],
    ...['--o-bg', '--o-card-fill', '--o-card-fill-hover'].flatMap((fill): [string, string, number][] => [
      ['--o-muted-icon', fill, UI],
      ['--o-control-border', fill, UI],
      ['--o-focus-border', fill, UI],
    ]),
    ['--o-focus-border', '--o-surface', UI], // the focus of a section, on the track of the sections
    ['--o-text', '--o-hero-fill', TEXT], // the hero of the route over its disc
    ['--o-secondary-text', '--o-hero-fill', TEXT],
    ['--o-sage-fill', '--o-track-fill', UI], // the fill of a progress bar on its track
    ['--o-sage-fill', '--o-bg', UI], // the arc of the readiness ring, between the ground and its inner disc
    ['--o-accent-fill', '--o-bg', UI],
  ];

  it.each([
    ['light', light],
    ['dark', dark],
  ])('keeps the semantic pairs readable in the %s theme', (_name, theme) => {
    const low = PAIRS.map(([fg, bg, least]) => ({ pair: `${fg} on ${bg}`, ratio: Math.round(contrast(theme, fg, bg) * 100) / 100, least })).filter(
      ({ ratio, least }) => ratio < least,
    );
    expect(low).toEqual([]);
  });
});
