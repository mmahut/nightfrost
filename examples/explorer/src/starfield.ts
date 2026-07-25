// Starfield + drifting frost particles behind the dashboard hero.
// Respects prefers-reduced-motion by rendering a single static frame.

interface Star {
  x: number; // 0..1
  y: number;
  r: number;
  phase: number;
  speed: number;
}

interface Flake {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  a: number;
}

export function mountStarfield(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const stars: Star[] = Array.from({ length: 140 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.4 + Math.random() * 1.1,
    phase: Math.random() * Math.PI * 2,
    speed: 0.3 + Math.random() * 0.9,
  }));
  const flakes: Flake[] = Array.from({ length: 26 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.8 + Math.random() * 1.8,
    vx: (Math.random() - 0.5) * 0.012,
    vy: 0.006 + Math.random() * 0.014,
    a: 0.12 + Math.random() * 0.25,
  }));

  let raf = 0;
  let running = true;
  let w = 0;
  let h = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function isLight(): boolean {
    const t = document.documentElement.dataset.theme;
    if (t === 'light') return true;
    if (t === 'dark') return false;
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  function draw(tMs: number) {
    const light = isLight();
    ctx!.clearRect(0, 0, w, h);
    const starColor = light ? '37, 110, 138' : '219, 231, 240';
    const flakeColor = light ? '37, 110, 138' : '143, 208, 228';
    const t = tMs / 1000;
    for (const s of stars) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.phase + t * s.speed));
      ctx!.fillStyle = `rgba(${starColor}, ${(light ? 0.28 : 0.75) * tw})`;
      ctx!.beginPath();
      ctx!.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx!.fill();
    }
    for (const f of flakes) {
      ctx!.fillStyle = `rgba(${flakeColor}, ${light ? f.a * 0.5 : f.a})`;
      ctx!.beginPath();
      ctx!.arc(f.x * w, f.y * h, f.r, 0, Math.PI * 2);
      ctx!.fill();
    }
  }

  function step(f: Flake, dt: number) {
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.y > 1.02) {
      f.y = -0.02;
      f.x = Math.random();
    }
    if (f.x > 1.02) f.x = -0.02;
    if (f.x < -0.02) f.x = 1.02;
  }

  let last = performance.now();
  function frame(now: number) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    for (const f of flakes) step(f, dt);
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  const onResize = () => {
    resize();
    if (reduced.matches) draw(0);
  };
  window.addEventListener('resize', onResize);
  resize();

  if (reduced.matches) {
    draw(0); // static frame
  } else {
    raf = requestAnimationFrame(frame);
  }

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  };
}
