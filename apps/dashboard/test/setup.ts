import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia — lib/useMediaQuery.ts needs a minimal
// stub so shell/grid component tests don't throw on mount.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom doesn't implement ResizeObserver — @tanstack/react-virtual (M3
// inbox/ThreadList.tsx) observes the scroll container's size to compute
// virtualized row positions. A no-op stub is enough for tests: they assert
// on rendered content/behavior, not real layout measurement.
if (typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement scrollIntoView — cmdk (M3 inbox/CommandPalette.tsx)
// calls it on the selected item when keyboard-navigating the palette list.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
