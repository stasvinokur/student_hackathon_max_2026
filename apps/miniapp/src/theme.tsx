import { MaxUI, useSystemColorScheme } from '@maxhub/max-ui';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Moon, Sun } from './components/icons.js';

// The light and the dark theme. The MAX bridge tells no theme, and the MAX clients follow the system, so the app follows
// the colour scheme of the system until the user picks a theme with the switch; the pick is kept on the device and wins
// over the system from then on. A script in index.html marks the page with the same theme (data-theme, which styles.css
// colours the page by) before the app loads, so a dark device never shows a light first frame. It runs before the
// bridge of MAX, as a slow st.max.ru must not keep the page in the wrong colours, and is not minified: keep its storage
// key and its check in step with THEME_KEY and readTheme(), which theme.test.tsx checks by running it.

type Scheme = 'light' | 'dark';

/** Where the pick is kept in local storage; the boot script of index.html reads it too. */
const THEME_KEY = 'theme';

/** The theme picked on this device, or null: none picked, a value the app does not know, or storage refused. */
function readTheme(): Scheme | null {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function saveTheme(scheme: Scheme): void {
  try {
    window.localStorage.setItem(THEME_KEY, scheme);
  } catch {
    // Storage refused: the pick lasts until the app closes.
  }
}

interface Theme {
  scheme: Scheme;
  /** Picks the other theme and keeps it on the device. */
  toggle: () => void;
}

const ThemeContext = createContext<Theme | null>(null);

/**
 * Gives MAX UI the theme (with a scheme of its own MaxUI stops listening to the system; useColorScheme(), which the map
 * reads, answers it) and marks the page with it: data-theme on <html> for the styles of the app and the page under it.
 * The class «organic» dresses MAX UI in the design system of the app: organic.css sets its tokens on that class from
 * the Organic ones, which data-theme themes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState(readTheme);
  const system = useSystemColorScheme({ listenChanges: true });
  const scheme = chosen ?? system;

  const toggle = useCallback(() => {
    const next = scheme === 'dark' ? 'light' : 'dark';
    setChosen(next);
    saveTheme(next);
  }, [scheme]);
  const theme = useMemo(() => ({ scheme, toggle }), [scheme, toggle]);

  // Before the paint, in the commit that recolours MAX UI: the page and the app never show two themes.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = scheme;
    return () => {
      delete root.dataset.theme;
    };
  }, [scheme]);

  return (
    <ThemeContext value={theme}>
      <MaxUI colorScheme={scheme} className="organic">
        {children}
      </MaxUI>
    </ThemeContext>
  );
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme() needs a <ThemeProvider> above it');
  return theme;
}

/**
 * The switch of the theme, beside the sections: a toggle button «Тёмная тема», pressed in the dark theme. Its icon shows
 * the theme on screen (the sun in the light one, the moon in the dark one), as aria-pressed tells it and as the sections
 * beside it mark the one on screen; a tap, as on any toggle, gives the other one. `onToggle` comes first (the haptic
 * of MAX), then the theme changes.
 */
export function ThemeToggle({ onToggle }: { onToggle?: () => void }) {
  const { scheme, toggle } = useTheme();
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Тёмная тема"
      aria-pressed={scheme === 'dark'}
      onClick={() => {
        onToggle?.();
        toggle();
      }}
    >
      {scheme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}
