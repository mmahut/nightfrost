import { Buffer as BufferPolyfill } from 'buffer';

// A few SCALE codec packages use Node's Buffer as a global. Vite bundles the
// browser implementation, but does not install it on globalThis automatically.
type BrowserGlobals = typeof globalThis & { Buffer: typeof BufferPolyfill };

(globalThis as BrowserGlobals).Buffer = BufferPolyfill;
