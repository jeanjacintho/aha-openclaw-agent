export const ROLES = ["founder", "produto", "marketing", "engenharia"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// Spec §7: bug/security → engenharia (+ founder if high); feature_request/
// comparison → produto; praise/complaint/question → marketing; pricing/legal
// → founder. "Imprensa" is not a CATEGORIES value. Strong trends are not a
// category; they are attached to the founder digest only. `other` is not in
// the table, so it routes nowhere.
export function routeItem(c: { category: string; urgency?: string | null }): Role[] {
  const high = c.urgency === "high";
  switch (c.category) {
    case "bug":
    case "security":
      return high ? ["engenharia", "founder"] : ["engenharia"];
    case "feature_request":
    case "comparison":
      return ["produto"];
    case "praise":
    case "complaint":
    case "question":
      return ["marketing"];
    case "pricing":
    case "legal":
      return ["founder"];
    default:
      return [];
  }
}
