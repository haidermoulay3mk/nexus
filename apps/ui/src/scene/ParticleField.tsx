import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useRunStore } from "../state/useRunStore";

interface ParticleFieldProps {
  count: number;
  reducedMotion: boolean;
}

/**
 * The Nexus core: an amber particle nebula. Slow rotation + per-particle
 * sinusoidal drift; pulses larger and hotter while runs are active, then
 * calms back down. All math is O(n) per frame with no allocations.
 */
export function ParticleField({ count, reducedMotion }: ParticleFieldProps) {
  const points = useRef<THREE.Points>(null);
  const group = useRef<THREE.Group>(null);
  const energy = useRef(0); // 0 idle → 1 fully excited
  const lastPulse = useRef(0);

  const { positions, seeds, colors, sizes } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const inner = new THREE.Color("#ffd9a8");
    const outer = new THREE.Color("#c56a2c");
    for (let i = 0; i < count; i++) {
      // Dense core with a soft falloff shell (cube-root radial distribution
      // biased inward for the "data cathedral" look).
      const r = 1.6 * Math.cbrt(Math.random()) * (0.55 + 0.45 * Math.random());
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.85;
      positions[i * 3 + 2] = r * Math.cos(phi);
      seeds[i] = Math.random() * Math.PI * 2;
      const t = Math.min(1, r / 1.6);
      const c = inner.clone().lerp(outer, t);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      sizes[i] = 0.5 + Math.random();
    }
    return { positions, seeds, colors, sizes };
  }, [count]);

  const basePositions = useMemo(() => positions.slice(), [positions]);

  useFrame((state, delta) => {
    const g = group.current;
    const p = points.current;
    if (!g || !p) return;

    // Activity → energy envelope
    const { anyActive, activityPulse } = useRunStore.getState();
    if (activityPulse !== lastPulse.current) {
      lastPulse.current = activityPulse;
      energy.current = 1;
    }
    const target = anyActive ? 0.65 : 0;
    energy.current += (target - energy.current) * Math.min(1, delta * 1.2);

    const t = state.clock.elapsedTime;
    if (!reducedMotion) {
      g.rotation.y = t * 0.03;
      g.rotation.x = Math.sin(t * 0.05) * 0.06;

      // per-particle drift
      const attr = p.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const drift = 0.02 + energy.current * 0.05;
      for (let i = 0; i < count; i++) {
        const s = seeds[i] ?? 0;
        arr[i * 3] = (basePositions[i * 3] ?? 0) + Math.sin(t * 0.4 + s) * drift;
        arr[i * 3 + 1] = (basePositions[i * 3 + 1] ?? 0) + Math.cos(t * 0.3 + s * 1.7) * drift;
        arr[i * 3 + 2] = (basePositions[i * 3 + 2] ?? 0) + Math.sin(t * 0.35 + s * 0.9) * drift;
      }
      attr.needsUpdate = true;
    }

    // pulse scale + brightness with energy
    const scale = 1 + energy.current * 0.12;
    g.scale.setScalar(scale);
    const mat = p.material as THREE.PointsMaterial;
    mat.opacity = 0.55 + energy.current * 0.4;
    mat.size = 0.02 + energy.current * 0.012;
  });

  return (
    <group ref={group}>
      <points ref={points}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
          <bufferAttribute attach="attributes-size" args={[sizes, 1]} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          transparent
          opacity={0.55}
          size={0.02}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
