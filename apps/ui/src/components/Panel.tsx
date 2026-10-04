import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { bracketVariants } from "../design/motion";

interface PanelProps {
  title?: string;
  titleRight?: ReactNode;
  children: ReactNode;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  /** hide the frame chrome (for bare containers) */
  frameless?: boolean;
}

const BR = "var(--bracket-size)";

function Bracket({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  const base: CSSProperties = {
    position: "absolute",
    width: BR,
    height: BR,
    borderColor: "var(--accent)",
    borderStyle: "solid",
    borderWidth: 0,
    opacity: 0.85,
  };
  const map: Record<typeof pos, CSSProperties> = {
    tl: { top: -1, left: -1, borderTopWidth: 1, borderLeftWidth: 1, transformOrigin: "top left" },
    tr: {
      top: -1,
      right: -1,
      borderTopWidth: 1,
      borderRightWidth: 1,
      transformOrigin: "top right",
    },
    bl: {
      bottom: -1,
      left: -1,
      borderBottomWidth: 1,
      borderLeftWidth: 1,
      transformOrigin: "bottom left",
    },
    br: {
      bottom: -1,
      right: -1,
      borderBottomWidth: 1,
      borderRightWidth: 1,
      transformOrigin: "bottom right",
    },
  };
  return <motion.span aria-hidden variants={bracketVariants} style={{ ...base, ...map[pos] }} />;
}

/**
 * The signature Nexus surface: hairline border, warm panel fill, four
 * accent corner brackets that draw in on mount.
 */
export function Panel({
  title,
  titleRight,
  children,
  active,
  className,
  style,
  frameless,
}: PanelProps) {
  const reduced = useReducedMotion();
  if (frameless) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.section
      initial={reduced ? "visible" : "hidden"}
      animate="visible"
      className={`relative ${className ?? ""}`}
      style={{
        background: "color-mix(in srgb, var(--bg-panel) 82%, transparent)",
        border: "1px solid var(--line-hairline)",
        borderRadius: "var(--radius)",
        boxShadow: active ? "var(--glow), inset 0 0 24px rgba(255,140,66,0.05)" : "none",
        backdropFilter: "blur(2px)",
        transition: "box-shadow 300ms ease",
        ...style,
      }}
    >
      <Bracket pos="tl" />
      <Bracket pos="tr" />
      <Bracket pos="bl" />
      <Bracket pos="br" />
      {title !== undefined && (
        <header className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
          <h2
            className="hud-label whitespace-nowrap"
            style={{ color: active ? "var(--accent)" : undefined }}
          >
            <span style={{ color: "var(--accent-deep)", marginRight: 6 }}>◆</span>
            {title}
          </h2>
          {titleRight}
        </header>
      )}
      <div className="px-3 pb-2">{children}</div>
    </motion.section>
  );
}
