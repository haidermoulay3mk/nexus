import type { Transition, Variants } from "motion/react";

/** Standard HUD easing — quick, precise, no bounce. */
export const easeHud: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

/** Result card mount/exit: fade + scale from 0.96 (brackets draw separately). */
export const cardVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: easeHud },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.16 } },
};

/** Corner bracket draw-in. */
export const bracketVariants: Variants = {
  hidden: { scaleX: 0, scaleY: 0, opacity: 0 },
  visible: {
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    transition: { duration: 0.28, ease: "easeOut" },
  },
};

/** Panel stagger for boot sequence. */
export const panelBoot: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.05 * i, ...easeHud },
  }),
};
