export type AutonomyLevel = "L0" | "L1" | "L2";

export function autonomyLevel(about: string | null | undefined): AutonomyLevel {
  if ((about ?? "").startsWith("competitor:")) return "L0";
  return "L1";
}
