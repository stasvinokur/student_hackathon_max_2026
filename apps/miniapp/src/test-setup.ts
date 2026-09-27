import { afterEach } from 'vitest';

// jsdom lacks a few browser APIs that UI libraries probe on mount.
// window.scrollTo exists but only reports "not implemented"; the app scrolls on every screen change.
window.scrollTo = () => {};
// jsdom has no layout, and no scrollIntoView either.
Element.prototype.scrollIntoView ??= () => {};

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Every test starts on a fresh device: no theme picked, no settings stored, the page not marked. Within a test the
// storage lasts, as it does across launches. Runs after the hooks of the test file (they run in reverse order), so
// after their cleanup(), which unmounts the app.
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
