import { useEffect } from "react";
import { StatusBar } from "./components/StatusBar";
import { AIWire } from "./hud/AIWire";
import { AudioIO } from "./hud/AudioIO";
import { CommandDeck } from "./hud/CommandDeck";
import { CommandPalette } from "./hud/CommandPalette";
import { Directives } from "./hud/Directives";
import { DocumentTrail } from "./hud/DocumentTrail";
import { PrimaryDirective } from "./hud/PrimaryDirective";
import { CardStage } from "./hud/ResultCard";
import { SetupNotice } from "./hud/SetupNotice";
import { SystemVitals } from "./hud/SystemVitals";
import { bootstrap } from "./lib/bootstrap";
import { NexusScene } from "./scene/NexusCore";

/**
 * The NEXUS HUD.
 *
 *  ┌──────────────────── status rail ────────────────────┐
 *  │ vitals │        nebula + cards + primary     │ deck  │
 *  │ direct │                                     │ audio │
 *  │ docs   │                                     │ wire  │
 *  └──────────────────────────────────────────────────────┘
 */
export default function App() {
  useEffect(() => {
    void bootstrap();
  }, []);

  return (
    <div className="scanlines vignette h-full flex flex-col relative">
      <NexusScene />

      <StatusBar />

      <main className="relative z-10 flex-1 min-h-0 grid grid-cols-[260px_1fr_270px] gap-3 px-4 pb-4">
        {/* left column */}
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
          <SystemVitals />
          <Directives />
          <DocumentTrail />
        </div>

        {/* center stage */}
        <div className="relative min-h-0">
          <CardStage />
          <SetupNotice />
          <div className="absolute inset-x-0 bottom-6 flex justify-center pointer-events-none">
            <PrimaryDirective />
          </div>
        </div>

        {/* right column */}
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
          <CommandDeck />
          <AudioIO />
          <AIWire />
        </div>
      </main>

      <CommandPalette />
    </div>
  );
}
