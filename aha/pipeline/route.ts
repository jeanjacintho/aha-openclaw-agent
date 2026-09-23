export const ROLES = ["founder", "produto", "marketing", "engenharia"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

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
    case "other":
      return ["founder"];
    default:
      return [];
  }
}
