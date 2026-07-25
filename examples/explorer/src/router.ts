// Minimal hash router: "#/block/123", "#/tx/<hash>", "#/address/<hex>", ...

export type Cleanup = () => void;
export type PageRenderer = (root: HTMLElement, param: string) => Cleanup | void | Promise<Cleanup | void>;

interface Route {
  pattern: RegExp;
  render: PageRenderer;
}

const routes: Route[] = [];
let outlet: HTMLElement | null = null;
let cleanup: Cleanup | null = null;
let generation = 0;

export function route(pattern: RegExp, render: PageRenderer): void {
  routes.push({ pattern, render });
}

export function navigate(hash: string): void {
  if (location.hash === hash) dispatch();
  else location.hash = hash;
}

async function dispatch(): Promise<void> {
  if (!outlet) return;
  const gen = ++generation;
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const hash = location.hash.replace(/^#/, '') || '/';
  const match = routes.find((r) => r.pattern.test(hash));
  outlet.replaceChildren();
  outlet.scrollTop = 0;
  window.scrollTo(0, 0);
  if (!match) return;
  const param = decodeURIComponent(hash.match(match.pattern)?.[1] ?? '');
  const result = await match.render(outlet, param);
  if (gen === generation && typeof result === 'function') cleanup = result;
  else if (typeof result === 'function') result(); // page changed while loading
}

export function startRouter(target: HTMLElement): void {
  outlet = target;
  window.addEventListener('hashchange', () => void dispatch());
  void dispatch();
}
