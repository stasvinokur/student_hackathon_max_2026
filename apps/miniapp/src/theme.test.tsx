import { useColorScheme } from '@maxhub/max-ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './theme.js';

// The light and the dark theme: the one of MAX (the colour scheme of the system) until the user picks one, then the
// pick, kept on the device. index.html marks the page before the app loads, and must pick what the app picks.

/** The colour scheme of the system; set() changes it and tells the listeners, as the system does. */
function system(initial: 'light' | 'dark') {
  let dark = initial === 'dark';
  type Listener = (event: { matches: boolean }) => void;
  const listeners = new Set<Listener>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query === '(prefers-color-scheme: dark)' && dark;
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, listener: Listener) => {
          if (query === '(prefers-color-scheme: dark)') listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  return {
    set(scheme: 'light' | 'dark') {
      dark = scheme === 'dark';
      act(() => listeners.forEach((listener) => listener({ matches: dark })));
    },
  };
}

function denyStorage() {
  const denied = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
}

/** What the app sees: the scheme MAX UI gives its components (the map takes it) and the switch of the theme. */
function Probe() {
  const { scheme, toggle } = useTheme();
  return (
    <>
      <output data-testid="max-ui">{useColorScheme()}</output>
      <button type="button" onClick={toggle}>
        {scheme}
      </button>
    </>
  );
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

/** The scheme of MAX UI, checked against the one of the switch: the two never part. */
function shown(): string {
  const scheme = screen.getByTestId('max-ui').textContent;
  expect(screen.getByRole('button').textContent).toBe(scheme);
  return scheme;
}

const toggle = () => userEvent.click(screen.getByRole('button'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the theme', () => {
  it('follows the system until a theme is chosen', async () => {
    const scheme = system('dark');
    renderTheme();
    expect(shown()).toBe('dark');
    scheme.set('light');
    expect(shown()).toBe('light');
    scheme.set('dark');
    expect(shown()).toBe('dark');
    // Nothing is stored until the user picks: a device that follows MAX keeps following it.
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('keeps the chosen theme on the device and over the system', async () => {
    const scheme = system('light');
    renderTheme();
    await toggle();
    expect(shown()).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    scheme.set('dark');
    scheme.set('light');
    expect(shown()).toBe('dark');
    cleanup();

    // The next launch takes the pick, whatever the system says.
    renderTheme();
    expect(shown()).toBe('dark');
    scheme.set('dark');
    await toggle();
    expect(shown()).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    cleanup();

    renderTheme();
    expect(shown()).toBe('light');
  });

  it('ignores unknown stored values and storage that throws', async () => {
    system('dark');
    for (const stored of ['Dark', 'auto', '"light"', ' light', '']) {
      localStorage.setItem('theme', stored);
      renderTheme();
      expect(shown(), stored).toBe('dark');
      cleanup();
    }

    // Storage refused (a private mode, an embedded browser): the system scheme, and a pick lasts the session.
    localStorage.clear();
    denyStorage();
    renderTheme();
    expect(shown()).toBe('dark');
    await toggle();
    expect(shown()).toBe('light');
    await toggle();
    expect(shown()).toBe('dark');
  });

  it('marks the page with data-theme', async () => {
    const scheme = system('light');
    renderTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    scheme.set('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await toggle();
    expect(document.documentElement.dataset.theme).toBe('light');
    cleanup();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('dresses MAX UI in Organic, in the scheme of the theme', async () => {
    system('light');
    const root = renderTheme().container.firstElementChild!;
    // The colour scheme of MAX UI, by the class of its root (the names are hashed: MaxUI_colorScheme_light__Woo).
    const scheme = () => [...root.classList].filter((name) => name.startsWith('MaxUI_colorScheme_'));
    expect(root.classList).toContain('organic');
    expect(scheme()).toEqual([expect.stringMatching(/^MaxUI_colorScheme_light(__|$)/)]);
    await toggle();
    expect(root.classList).toContain('organic');
    expect(scheme()).toEqual([expect.stringMatching(/^MaxUI_colorScheme_dark(__|$)/)]);
  });

  it('is asked for inside its provider only', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });
});

describe('the boot script of index.html', () => {
  const html = readFileSync(join(import.meta.dirname, '../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const inline = scripts.filter(([, attributes]) => !/\bsrc=/.test(attributes!));

  it('runs before the bridge of MAX, a classic script of its own', () => {
    expect(inline).toHaveLength(1);
    const [boot] = inline;
    expect(boot![1]!.trim()).toBe('');
    const bridge = scripts.find(([, attributes]) => attributes!.includes('max-web-app.js'));
    // A slow st.max.ru must not keep the page in the wrong colours.
    expect(boot!.index).toBeLessThan(bridge!.index);
  });

  it('picks the same theme as the provider', () => {
    const run = new Function(inline[0]![2]!) as () => void;
    for (const systemScheme of ['light', 'dark'] as const) {
      for (const stored of [null, 'light', 'dark', 'auto', 'refused'] as const) {
        const label = `${stored} on a ${systemScheme} system`;
        system(systemScheme);
        if (stored === 'refused') denyStorage();
        else if (stored !== null) localStorage.setItem('theme', stored);

        run();
        const booted = document.documentElement.dataset.theme;
        delete document.documentElement.dataset.theme;
        renderTheme();
        expect(booted, label).toBe(stored === 'light' || stored === 'dark' ? stored : systemScheme);
        expect(booted, label).toBe(shown());
        expect(document.documentElement.dataset.theme, label).toBe(booted);

        cleanup();
        vi.restoreAllMocks();
        localStorage.clear();
      }
    }
  });
});
