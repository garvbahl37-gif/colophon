import { ToolLoopAgent, stepCountIs } from "ai";
import { config } from "@/lib/config";
import { generateModel } from "@/lib/ai/models";
import { ANSWER_SYSTEM } from "@/lib/ai/prompts";
import { createRagTools, type ToolContext } from "./tools";

export const AGENT_INSTRUCTIONS = `${ANSWER_SYSTEM}

RETRIEVAL STRATEGY

You control your own retrieval. You have no knowledge of the corpus until you search it, so search before you assert anything about its contents.

- Search first, always, unless the message is a greeting or is about you rather than about the documents.
- One search is enough for a single-fact question. Do not pad a simple question with redundant searches.
- Decompose before you search, not after. A comparison needs one search per side. A multi-part question needs one search per part. Issue them as separate searchCorpus calls.
- Phrase queries the way a document would phrase the answer, not the way the user asked. "Why is it slow?" retrieves nothing; "performance bottleneck latency profiling" retrieves the section.
- When a search returns nothing useful, change vocabulary rather than repeating yourself. Try the domain term, the acronym, the error string, the product name. If two reformulations fail, call listDocuments and check whether the corpus covers the topic at all.
- Use readSection when a passage is obviously on-topic but truncated mid-explanation, or when the number, table, or definition you need clearly sits just outside it.
- Stop searching once you can answer. Extra searches cost the user time and add nothing.

WHEN SEARCH FAILS

If a tool returns failed: true, retrieval itself is broken. That is not the same as the corpus lacking an answer. Say that search is unavailable and quote the error. Never substitute "the sources do not cover this" for "I could not search" — the first is a claim about the documents and the second is a claim about the system, and reporting the wrong one sends the reader to the wrong conclusion.

BEFORE YOU ANSWER

Check that every claim you are about to make traces to a passage you actually retrieved. If part of the question went unanswered by the corpus, answer the part you can support and say plainly which part the sources do not cover. Never fill a gap from your own knowledge - an incomplete grounded answer is correct; a complete invented one is a failure.`;

export function createRagAgent(ctx: ToolContext) {
  return new ToolLoopAgent({
    model: generateModel(),
    instructions: AGENT_INSTRUCTIONS,
    tools: createRagTools(ctx),
    // Enough headroom for decompose -> search -> reformulate -> read -> answer,
    // with a hard ceiling so a confused loop cannot run up a bill.
    stopWhen: stepCountIs(Math.max(4, config.retrieval.maxHops * 3 + 2)),
    temperature: 0.2,
  });
}
