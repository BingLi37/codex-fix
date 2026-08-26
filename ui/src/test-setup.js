// jsdom lacks the observer APIs HeroUI's ScrollShadow relies on.
class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= StubObserver;
globalThis.IntersectionObserver ??= StubObserver;
globalThis.matchMedia ??= () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

// The tab indicator is a shared-element transition and queries running
// animations, which jsdom does not implement.
Element.prototype.getAnimations ??= () => [];
Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve(), addEventListener() {} });
