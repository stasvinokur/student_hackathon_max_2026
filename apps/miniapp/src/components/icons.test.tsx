import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as icons from './icons.js';

// The Lucide icons of the app: decoration beside a text that says the same, never announced and never focused.

afterEach(cleanup);

describe('icons', () => {
  it.each(Object.entries(icons))('%s is a hidden stroke drawing on the 24 × 24 grid of Lucide', (_name, Icon) => {
    const svg = render(<Icon />).container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2.75');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
    expect(svg.children.length).toBeGreaterThan(0);
  });

  it('takes a size and a class', () => {
    const svg = render(<icons.Check size={16} className="done" />).container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('class')).toBe('done');
  });
});
