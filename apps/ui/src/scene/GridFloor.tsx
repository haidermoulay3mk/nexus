import { Grid } from "@react-three/drei";

/** Perspective grid floor — amber hairlines fading into the void. */
export function GridFloor() {
  return (
    <Grid
      position={[0, -1.6, 0]}
      args={[24, 24]}
      cellSize={0.5}
      cellThickness={0.4}
      cellColor="#2a2018"
      sectionSize={2.5}
      sectionThickness={0.8}
      sectionColor="#c56a2c"
      fadeDistance={16}
      fadeStrength={2.5}
      infiniteGrid
    />
  );
}
