import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWideScreen, useWideScreen, WIDE_QUERY } from './wide.js';

// The size of the iframe as the browser tells it: every matchMedia() gives a list of its own, as in a browser, which
// keeps the listeners added to it.

type Listener = (event: Event) => void;

function iframe(initial: 'narrow' | 'wide', { supportsHas = true } = {}) {
  let wide = initial === 'wide';
  const lists: Set<Listener>[] = [];
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const listeners = new Set<Listener>();
    lists.push(listeners);
    return {
      get matches() {
        return query === WIDE_QUERY && wide;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
  vi.spyOn(CSS, 'supports').mockImplementation((condition: string) => supportsHas && condition === 'selector(:has(*))');
  return {
    /** Widens or narrows the iframe. The event tells nothing of the size: the hook is to ask the browser again. */
    set(next: 'narrow' | 'wide') {
      wide = next === 'wide';
      act(() => lists.forEach((listeners) => listeners.forEach((listener) => listener(new Event('change')))));
    },
    /** How many listeners the lists still hold. */
    listening: () => lists.reduce((count, listeners) => count + listeners.size, 0),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useWideScreen', () => {
  it('follows the size of the iframe, asking the browser again at every change', () => {
    const size = iframe('narrow');
    const { result } = renderHook(() => useWideScreen());
    expect(result.current).toBe(false);

    size.set('wide');
    expect(result.current).toBe(true);
    size.set('narrow');
    expect(result.current).toBe(false);
  });

  it('stays narrow without :has(), which the wide layout needs, even where the query matches', () => {
    iframe('wide', { supportsHas: false });
    expect(renderHook(() => useWideScreen()).result.current).toBe(false);
    expect(CSS.supports).toHaveBeenCalledWith('selector(:has(*))');
    // A browser without CSS.supports at all keeps one column as well.
    vi.stubGlobal('CSS', undefined);
    expect(isWideScreen()).toBe(false);
  });

  it('stops listening to the size of the iframe when the screen goes', () => {
    const size = iframe('wide');
    const { result, unmount } = renderHook(() => useWideScreen());
    expect(result.current).toBe(true);
    expect(size.listening()).toBe(1);

    unmount();
    // Removed from the very list it was added to.
    expect(size.listening()).toBe(0);
  });
});
