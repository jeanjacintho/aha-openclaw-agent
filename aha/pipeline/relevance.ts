import { type Classification } from "../llm/schemas.ts";

export type Relevance = Pick<Classification, "relevant" | "confidence" | "reason">;

export function stateFromClassification(c: Classification): "relevant" | "irrelevant" {
  return c.relevant ? "relevant" : "irrelevant";
}
