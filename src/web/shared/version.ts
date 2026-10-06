// Show versions look like "e<eventSeq>.l<logSeq>". Edge-cached reads can return an older one than a response we already applied.
const FORMAT = /^e(\d+)\.l(\d+)$/;

/** Positive when `a` is newer than `b`, negative when older, 0 when equal. A version in an unknown format counts as newer. */
export function compareVersion(a: string, b: string): number {
  if (a === b) return 0;
  const x = FORMAT.exec(a);
  const y = FORMAT.exec(b);
  if (!x || !y) return 1;
  return Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]);
}
