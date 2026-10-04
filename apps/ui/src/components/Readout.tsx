import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { fmtCompact, fmtInt } from "../lib/format";

interface ReadoutProps {
  value: number;
  /** "compact" → 140K style; "full" → 3,225 style */
  mode?: "compact" | "full";
  className?: string;
  style?: React.CSSProperties;
}

/** Count-up numeral (tabular, monospaced) that animates on value change. */
export function Readout({ value, mode = "compact", className, style }: ReadoutProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  const reduced = useReducedMotion();
  const fmt = mode === "compact" ? fmtCompact : fmtInt;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced || prev.current === value) {
      el.textContent = fmt(value);
      prev.current = value;
      return;
    }
    const controls = animate(prev.current, value, {
      duration: 0.9,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = fmt(v);
      },
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, reduced, fmt]);

  return (
    <span ref={ref} className={`hud-num ${className ?? ""}`} style={style}>
      {fmt(value)}
    </span>
  );
}
