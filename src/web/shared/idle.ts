// Polls pause when nobody has touched the page for a while (free-tier Durable Object requests), and resume on input.
export const IDLE_MS = 5 * 60_000;

export class IdleWatch {
  private last: number;
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly limitMs: number = IDLE_MS,
  ) {
    this.last = now();
  }
  touch(): void {
    this.last = this.now();
  }
  idle(): boolean {
    return this.now() - this.last >= this.limitMs;
  }
}

export function watchIdle(limitMs = IDLE_MS): IdleWatch {
  const w = new IdleWatch(() => Date.now(), limitMs);
  const touch = () => w.touch();
  for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus"]) addEventListener(ev, touch, { passive: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) touch(); });
  return w;
}
