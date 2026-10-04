import type { VisualTier } from "@nexus/core";
import { Canvas, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useEffect, useMemo } from "react";
import { useRunStore } from "../state/useRunStore";
import { useSystemStore } from "../state/useSystemStore";
import { GridFloor } from "./GridFloor";
import { ParticleField } from "./ParticleField";

const PARTICLES: Record<VisualTier, number> = {
  low: 1_500,
  medium: 4_500,
  high: 9_000,
};

/**
 * Idle throttle: when no run is active we drop to ~12fps via manual
 * invalidation (frameloop="demand") — the nebula still breathes but the
 * GPU rests. Any active run switches to a full 60fps loop.
 */
function IdleThrottle({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (active) return; // frameloop="always" handles it
    const id = setInterval(() => invalidate(), 83);
    return () => clearInterval(id);
  }, [active, invalidate]);
  return null;
}

/** Fullscreen background scene behind the HUD grid. */
export function NexusScene() {
  const visualTier = useSystemStore((s) => s.capability?.visualTier ?? "medium");
  const anyActive = useRunStore((s) => s.anyActive);
  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const bloomOn = visualTier !== "low" && !reducedMotion;

  return (
    <div className="fixed inset-0 z-0" aria-hidden>
      <Canvas
        frameloop={anyActive ? "always" : "demand"}
        camera={{ position: [0, 0.4, 4.6], fov: 42 }}
        gl={{ antialias: false, powerPreference: "low-power" }}
        dpr={visualTier === "high" ? [1, 2] : 1}
      >
        <color attach="background" args={["#0A0705"]} />
        <fog attach="fog" args={["#0A0705", 6, 14]} />
        <IdleThrottle active={anyActive} />
        <ParticleField count={PARTICLES[visualTier]} reducedMotion={reducedMotion} />
        <GridFloor />
        {bloomOn && (
          <EffectComposer>
            <Bloom
              intensity={anyActive ? 1.1 : 0.55}
              luminanceThreshold={0.12}
              luminanceSmoothing={0.8}
              mipmapBlur
            />
          </EffectComposer>
        )}
      </Canvas>
    </div>
  );
}
