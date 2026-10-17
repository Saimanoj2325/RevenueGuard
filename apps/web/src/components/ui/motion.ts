'use client';
import { useEffect, useRef, useState } from 'react';

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Animated number: counts from the previous value to the new one with ease-out (~900ms). `flash` toggles on each change. */
export function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(target);
  const [flash, setFlash] = useState(0);
  const from = useRef(target);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; from.current = target; setV(target); return; }
    if (from.current === target) return;
    const start = from.current;
    from.current = target;
    setFlash((f) => f + 1);
    if (prefersReducedMotion()) { setV(target); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(Math.round(start + (target - start) * e));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return { value: v, flash };
}
