import { z } from "zod";
import { ARTICLE_NUMBER, MAX_CHOSEN_ARTICLES } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { sessionRoute } from "@/server/api";
import { lookupArticles } from "@/server/servicenow/knowledge";
import { requireConnection, resolveConnection } from "@/server/services/connections";

const SYS_ID = /^[0-9a-f]{32}$/;

const lookupSchema = z.object({
  kbIds: z.array(z.string().regex(SYS_ID, "Invalid knowledge base")).min(1, "Pick at least one knowledge base").max(25),
  refs: z
    .array(
      z
        .string()
        .trim()
        .transform((ref) => (/^[0-9a-f]{32}$/i.test(ref) ? ref.toLowerCase() : ref))
        .refine((ref) => SYS_ID.test(ref) || ARTICLE_NUMBER.test(ref), "Not an article number"),
    )
    .min(1, "Paste at least one article number")
    .max(MAX_CHOSEN_ARTICLES, `Paste at most ${formatNumber(MAX_CHOSEN_ARTICLES)} article numbers at a time`),
});

export const POST = sessionRoute<z.infer<typeof lookupSchema>, { id: string }>(
  { operation: "connections.lookupArticles", body: lookupSchema },
  async ({ actor, params, body }) => {
    const row = await requireConnection(actor, params.id);
    return lookupArticles(resolveConnection(row), { kbIds: body.kbIds, refs: body.refs }, actor.log);
  },
);
