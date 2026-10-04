/**
 * CAIE (Cambridge International) syllabus data — Physics 9702, Mathematics
 * 9709, Computer Science 9618 — hard-coded so NO model ever has to remember
 * or invent it. Verify against the syllabus PDFs on cambridgeinternational.org
 * if CAIE restructures (they normally revise on ~3-year cycles).
 *
 * Levels: "AS" = first year, "AL" = second year (A2), "EITHER" = component
 * that can be taken in either year (Maths Mechanics / Stats 1).
 */

export type Level = "AS" | "AL" | "EITHER";

export interface PaperDef {
  /** official paper number, e.g. 2 in "Paper 22" (22 = paper 2, variant 2) */
  no: number;
  name: string;
  /** official maximum raw mark — used when the operator logs a bare score */
  marks: number;
  level: Level;
  /** which chapters this paper's score nudges (see engine.applyPaperNudge) */
  nudges: (ch: ChapterDef) => boolean;
}

export interface ChapterDef {
  /** stable id used in commands, e.g. "2" (physics) or "1.3" (maths) */
  id: string;
  title: string;
  level: Level;
  /** maths only: syllabus component the chapter belongs to (1..6) */
  component?: number;
}

export interface SubjectDef {
  code: string;
  name: string;
  aliases: string[];
  papers: PaperDef[];
  chapters: ChapterDef[];
}

const asLevel = (ch: ChapterDef) => ch.level === "AS";
const alLevel = (ch: ChapterDef) => ch.level === "AL";
const component = (n: number) => (ch: ChapterDef) => ch.component === n;

export const PHYSICS: SubjectDef = {
  code: "9702",
  name: "Physics",
  aliases: ["phy", "physics", "phys"],
  papers: [
    { no: 1, name: "Multiple Choice", marks: 40, level: "AS", nudges: asLevel },
    { no: 2, name: "AS Structured Questions", marks: 60, level: "AS", nudges: asLevel },
    { no: 3, name: "Advanced Practical Skills", marks: 40, level: "AS", nudges: () => false },
    { no: 4, name: "A Level Structured Questions", marks: 100, level: "AL", nudges: alLevel },
    {
      no: 5,
      name: "Planning, Analysis and Evaluation",
      marks: 30,
      level: "AL",
      nudges: () => false,
    },
  ],
  chapters: [
    { id: "1", title: "Physical quantities and units", level: "AS" },
    { id: "2", title: "Kinematics", level: "AS" },
    { id: "3", title: "Dynamics", level: "AS" },
    { id: "4", title: "Forces, density and pressure", level: "AS" },
    { id: "5", title: "Work, energy and power", level: "AS" },
    { id: "6", title: "Deformation of solids", level: "AS" },
    { id: "7", title: "Waves", level: "AS" },
    { id: "8", title: "Superposition", level: "AS" },
    { id: "9", title: "Electricity", level: "AS" },
    { id: "10", title: "D.C. circuits", level: "AS" },
    { id: "11", title: "Particle physics", level: "AS" },
    { id: "12", title: "Motion in a circle", level: "AL" },
    { id: "13", title: "Gravitational fields", level: "AL" },
    { id: "14", title: "Temperature", level: "AL" },
    { id: "15", title: "Ideal gases", level: "AL" },
    { id: "16", title: "Thermodynamics", level: "AL" },
    { id: "17", title: "Oscillations", level: "AL" },
    { id: "18", title: "Electric fields", level: "AL" },
    { id: "19", title: "Capacitance", level: "AL" },
    { id: "20", title: "Magnetic fields", level: "AL" },
    { id: "21", title: "Alternating currents", level: "AL" },
    { id: "22", title: "Quantum physics", level: "AL" },
    { id: "23", title: "Nuclear physics", level: "AL" },
    { id: "24", title: "Medical physics", level: "AL" },
    { id: "25", title: "Astronomy and cosmology", level: "AL" },
  ],
};

export const MATHS: SubjectDef = {
  code: "9709",
  name: "Mathematics",
  aliases: ["math", "maths", "mathematics"],
  papers: [
    { no: 1, name: "Pure Mathematics 1", marks: 75, level: "AS", nudges: component(1) },
    { no: 2, name: "Pure Mathematics 2", marks: 50, level: "AS", nudges: component(2) },
    { no: 3, name: "Pure Mathematics 3", marks: 75, level: "AL", nudges: component(3) },
    { no: 4, name: "Mechanics", marks: 50, level: "EITHER", nudges: component(4) },
    { no: 5, name: "Probability & Statistics 1", marks: 50, level: "EITHER", nudges: component(5) },
    { no: 6, name: "Probability & Statistics 2", marks: 50, level: "AL", nudges: component(6) },
  ],
  chapters: [
    { id: "1.1", title: "Quadratics", level: "AS", component: 1 },
    { id: "1.2", title: "Functions", level: "AS", component: 1 },
    { id: "1.3", title: "Coordinate geometry", level: "AS", component: 1 },
    { id: "1.4", title: "Circular measure", level: "AS", component: 1 },
    { id: "1.5", title: "Trigonometry", level: "AS", component: 1 },
    { id: "1.6", title: "Series", level: "AS", component: 1 },
    { id: "1.7", title: "Differentiation", level: "AS", component: 1 },
    { id: "1.8", title: "Integration", level: "AS", component: 1 },
    { id: "2.1", title: "Algebra (P2)", level: "AS", component: 2 },
    { id: "2.2", title: "Logarithmic and exponential functions (P2)", level: "AS", component: 2 },
    { id: "2.3", title: "Trigonometry (P2)", level: "AS", component: 2 },
    { id: "2.4", title: "Differentiation (P2)", level: "AS", component: 2 },
    { id: "2.5", title: "Integration (P2)", level: "AS", component: 2 },
    { id: "2.6", title: "Numerical solution of equations (P2)", level: "AS", component: 2 },
    { id: "3.1", title: "Algebra (P3)", level: "AL", component: 3 },
    { id: "3.2", title: "Logarithmic and exponential functions (P3)", level: "AL", component: 3 },
    { id: "3.3", title: "Trigonometry (P3)", level: "AL", component: 3 },
    { id: "3.4", title: "Differentiation (P3)", level: "AL", component: 3 },
    { id: "3.5", title: "Integration (P3)", level: "AL", component: 3 },
    { id: "3.6", title: "Numerical solution of equations (P3)", level: "AL", component: 3 },
    { id: "3.7", title: "Vectors", level: "AL", component: 3 },
    { id: "3.8", title: "Differential equations", level: "AL", component: 3 },
    { id: "3.9", title: "Complex numbers", level: "AL", component: 3 },
    { id: "4.1", title: "Forces and equilibrium", level: "EITHER", component: 4 },
    { id: "4.2", title: "Kinematics of motion in a straight line", level: "EITHER", component: 4 },
    { id: "4.3", title: "Momentum", level: "EITHER", component: 4 },
    { id: "4.4", title: "Newton's laws of motion", level: "EITHER", component: 4 },
    { id: "4.5", title: "Energy, work and power", level: "EITHER", component: 4 },
    { id: "5.1", title: "Representation of data", level: "EITHER", component: 5 },
    { id: "5.2", title: "Permutations and combinations", level: "EITHER", component: 5 },
    { id: "5.3", title: "Probability", level: "EITHER", component: 5 },
    { id: "5.4", title: "Discrete random variables", level: "EITHER", component: 5 },
    { id: "5.5", title: "The normal distribution", level: "EITHER", component: 5 },
    { id: "6.1", title: "The Poisson distribution", level: "AL", component: 6 },
    { id: "6.2", title: "Linear combinations of random variables", level: "AL", component: 6 },
    { id: "6.3", title: "Continuous random variables", level: "AL", component: 6 },
    { id: "6.4", title: "Sampling and estimation", level: "AL", component: 6 },
    { id: "6.5", title: "Hypothesis tests", level: "AL", component: 6 },
  ],
};

export const CS: SubjectDef = {
  code: "9618",
  name: "Computer Science",
  aliases: ["cs", "compsci", "computerscience"],
  papers: [
    { no: 1, name: "Theory Fundamentals", marks: 75, level: "AS", nudges: asLevel },
    {
      no: 2,
      name: "Fundamental Problem-solving and Programming",
      marks: 75,
      level: "AS",
      nudges: asLevel,
    },
    { no: 3, name: "Advanced Theory", marks: 75, level: "AL", nudges: alLevel },
    { no: 4, name: "Practical", marks: 75, level: "AL", nudges: alLevel },
  ],
  chapters: [
    { id: "1", title: "Information representation", level: "AS" },
    { id: "2", title: "Communication", level: "AS" },
    { id: "3", title: "Hardware", level: "AS" },
    { id: "4", title: "Processor fundamentals", level: "AS" },
    { id: "5", title: "System software", level: "AS" },
    { id: "6", title: "Security, privacy and data integrity", level: "AS" },
    { id: "7", title: "Ethics and ownership", level: "AS" },
    { id: "8", title: "Databases", level: "AS" },
    { id: "9", title: "Algorithm design and problem-solving", level: "AS" },
    { id: "10", title: "Data types and structures", level: "AS" },
    { id: "11", title: "Programming", level: "AS" },
    { id: "12", title: "Software development", level: "AS" },
    { id: "13", title: "Data representation (A2)", level: "AL" },
    { id: "14", title: "Communication and internet technologies (A2)", level: "AL" },
    { id: "15", title: "Hardware and virtual machines (A2)", level: "AL" },
    { id: "16", title: "System software (A2)", level: "AL" },
    { id: "17", title: "Security (A2)", level: "AL" },
    { id: "18", title: "Artificial intelligence", level: "AL" },
    { id: "19", title: "Computational thinking and problem-solving (A2)", level: "AL" },
    { id: "20", title: "Further programming", level: "AL" },
  ],
};

export const SUBJECTS: SubjectDef[] = [PHYSICS, MATHS, CS];

/** Resolve "9702" / "phy" / "PHYSICS" → SubjectDef, or null. */
export function resolveSubject(token: string): SubjectDef | null {
  const t = token.trim().toLowerCase();
  return SUBJECTS.find((s) => s.code === t || s.aliases.includes(t)) ?? null;
}

export function paperByNo(subject: SubjectDef, no: number): PaperDef | null {
  return subject.papers.find((p) => p.no === no) ?? null;
}

export function chapterById(subject: SubjectDef, id: string): ChapterDef | null {
  const t = id.trim().toLowerCase();
  return subject.chapters.find((c) => c.id.toLowerCase() === t) ?? null;
}
