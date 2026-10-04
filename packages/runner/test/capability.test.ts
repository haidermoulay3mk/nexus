import { describe, expect, test } from "bun:test";
import { tiersFor } from "../src/ai/capability";

describe("capability tiers", () => {
  test("16GB + integrated GPU → balanced model, medium visuals (the target baseline)", () => {
    const t = tiersFor(16_000, null);
    expect(t.modelTier).toBe("balanced");
    expect(t.visualTier).toBe("medium");
  });

  test("8GB laptop → lite everything", () => {
    const t = tiersFor(8_000, null);
    expect(t.modelTier).toBe("lite");
    expect(t.visualTier).toBe("low");
  });

  test("64GB + 24GB VRAM workstation → max model, high visuals", () => {
    const t = tiersFor(64_000, 24_000);
    expect(t.modelTier).toBe("max");
    expect(t.visualTier).toBe("high");
  });

  test("32GB + 8GB VRAM → balanced model, high visuals", () => {
    const t = tiersFor(32_000, 8_000);
    expect(t.modelTier).toBe("balanced");
    expect(t.visualTier).toBe("high");
  });
});
