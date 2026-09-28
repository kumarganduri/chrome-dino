// Globals the vendored Chromium page code expects on window (set by Chrome's
// error page). Declared for type-checking only.
declare global {
  interface Window {
    errorPageController?: {
      trackEasterEgg(): void;
      updateEasterEggHighScore(score: number): void;
      resetEasterEggHighScore(): void;
    };
    initializeEasterEggHighScore?: (score: number) => void;
  }
  interface CSSStyleDeclaration {
    webkitAnimation: string;
  }
}
export {};
