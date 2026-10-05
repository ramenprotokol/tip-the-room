import type { SignHost, SignView } from "./sign";

/** Test and debug hooks every page publishes on window.__marquee (see reference/v2/README.md). */
export interface MarqueeHooks {
  page: string;
  ready: boolean;
  views: SignView[];
  host?: SignHost | null;
}

declare global {
  interface Window {
    __marquee: MarqueeHooks;
  }
}

export {};
