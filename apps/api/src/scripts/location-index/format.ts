// Text helpers of the pipeline's logs and report.

const NBSP = String.fromCharCode(0xa0);

/** Texts of the core keep numbers with their units by no-break spaces; plain spaces read better in a terminal. */
export function plain(text: string): string {
  return text.split(NBSP).join(' ');
}

/**
 * One line of text that came from outside (an Overpass error page, a remark): control characters and marks of
 * the direction of writing — a hostile mirror could move the cursor or recolour the terminal with them — become
 * spaces, runs of spaces one.
 */
export function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
