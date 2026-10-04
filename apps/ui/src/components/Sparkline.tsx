import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface SparklineProps {
  series: number[];
  width?: number;
  height?: number;
}

/**
 * Featherweight uPlot sparkline: no axes, no legend, amber stroke, subtle
 * area fill. Draws in left-to-right via a clip-path animation on mount.
 */
export function Sparkline({ series, width = 120, height = 26 }: SparklineProps) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const xs = series.map((_, i) => i);
    const data: uPlot.AlignedData = [xs, series];
    if (plot.current) {
      plot.current.setData(data);
      return;
    }
    plot.current = new uPlot(
      {
        width,
        height,
        legend: { show: false },
        cursor: { show: false },
        select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        axes: [{ show: false }, { show: false }],
        scales: { x: { time: false } },
        series: [
          {},
          {
            stroke: "#F0A868",
            width: 1.25,
            fill: "rgba(240,168,104,0.07)",
            points: { show: false },
          },
        ],
      },
      data,
      el,
    );
    return () => {
      plot.current?.destroy();
      plot.current = null;
    };
  }, [series, width, height]);

  return (
    <div
      ref={host}
      style={{
        width,
        height,
        animation: "spark-in 900ms ease-out both",
      }}
      className="[&_.u-over]:!cursor-default"
    >
      <style>{`@keyframes spark-in { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@media (prefers-reduced-motion: reduce) { @keyframes spark-in { from { clip-path: inset(0 0 0 0); } } }`}</style>
    </div>
  );
}
