import { cpus, totalmem } from "node:os";
import type { CapabilityProfile, ModelTier, VisualTier } from "@nexus/core";

/**
 * First-launch hardware probe → Model Tier + Visual Tier.
 *
 * Target baseline: 16GB RAM / integrated-or-modest GPU → `balanced` (7B)
 * with automatic `lite` (3B) fallback on latency (see ollama.ts), and
 * Visual Tier `medium` (reduced particles, bloom optional).
 */

async function probeVramMb(): Promise<number | null> {
  // NVIDIA path — free, present on machines with an NVIDIA GPU.
  try {
    const proc = Bun.spawn(
      ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit === 0) {
      const first = out.trim().split("\n")[0];
      const mb = Number(first);
      if (Number.isFinite(mb) && mb > 0) return Math.round(mb);
    }
  } catch {
    // nvidia-smi absent — integrated / AMD GPU; treat as unknown.
  }
  return null;
}

export function tiersFor(
  ramMb: number,
  vramMb: number | null,
): {
  modelTier: ModelTier;
  visualTier: VisualTier;
} {
  let modelTier: ModelTier;
  if (ramMb >= 48_000 && (vramMb ?? 0) >= 15_000) modelTier = "max";
  else if (ramMb >= 14_000) modelTier = "balanced";
  else modelTier = "lite";

  let visualTier: VisualTier;
  if ((vramMb ?? 0) >= 8_000) visualTier = "high";
  else if (ramMb >= 14_000) visualTier = "medium";
  else visualTier = "low";

  return { modelTier, visualTier };
}

export async function probeCapability(): Promise<CapabilityProfile> {
  const ramMb = Math.round(totalmem() / (1024 * 1024));
  const vramMb = await probeVramMb();
  const cpuCores = Math.max(1, cpus().length);
  const { modelTier, visualTier } = tiersFor(ramMb, vramMb);
  return {
    modelTier,
    visualTier,
    ramMb,
    vramMb,
    cpuCores,
    probedAt: new Date().toISOString(),
  };
}
