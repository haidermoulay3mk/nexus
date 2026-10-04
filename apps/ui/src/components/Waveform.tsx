import { useEffect, useRef } from "react";
import { useVoiceStore } from "../state/useVoiceStore";

const BARS = 48;

/** Mirrored-bar mic waveform (canvas). Live while listening, flatline on standby. */
export function Waveform({ width = 220, height = 36 }: { width?: number; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<number[]>(new Array(BARS).fill(0));
  const raf = useRef(0);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = width * dpr;
    el.height = height * dpr;
    ctx.scale(dpr, dpr);

    const draw = () => {
      const { holding, micLevel, state } = useVoiceStore.getState();
      const live = holding || state === "listening";
      history.current.push(live ? micLevel : 0);
      if (history.current.length > BARS) history.current.shift();

      ctx.clearRect(0, 0, width, height);
      const barW = width / BARS;
      const mid = height / 2;
      history.current.forEach((v, i) => {
        const h = Math.max(1, v * (height * 0.92));
        const x = i * barW;
        const alpha = 0.25 + v * 0.75;
        ctx.fillStyle = live ? `rgba(255,140,66,${alpha})` : "rgba(122,115,107,0.35)";
        ctx.fillRect(x + barW * 0.25, mid - h / 2, barW * 0.5, h);
      });
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [width, height]);

  return <canvas ref={canvas} style={{ width, height }} />;
}
