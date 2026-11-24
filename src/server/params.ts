import { z } from "zod";

/** `?kb=id1,id2`: the knowledge bases the article pickers work on. */
export const kbIdsParam = z
  .string()
  .max(25 * 33)
  .transform((value) => value.split(",").filter(Boolean))
  .pipe(z.array(z.string().regex(/^[0-9a-f]{32}$/, "Invalid knowledge base")).min(1, "Pick at least one knowledge base").max(25));
