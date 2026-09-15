import "./env";
import type { Citation } from "../lib/retrieval/types";
import { createUIMessageStream } from "ai";
import { runColophon } from "../lib/retrieval/orchestrator";
import type { ColophonMode, ColophonUIMessage } from "../lib/ai/types";
import { sql } from "../lib/db/client";

const mode = (process.argv[2] as ColophonMode) ?? "agent";
const question = process.argv[3] ?? "How does the retry backoff differ from the circuit breaker timing?";

const messages: ColophonUIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: question }] },
];

let answer = "";
const t0 = Date.now();

const stream = createUIMessageStream<ColophonUIMessage>({
  execute: async ({ writer }) => {
    await runColophon({ question, messages, documentIds: null, ownerId: "cli", mode, writer });
  },
  onError: (e) => { console.error("\n[STREAM ERROR]", e instanceof Error ? e.message : e); return String(e); },
});

console.log(`\n\x1b[36m━━ ${mode.toUpperCase()} ━━\x1b[0m ${question}\n`);

/*
  The stream is a discriminated union whose members this script only reads
  loosely. Naming the shapes it actually touches keeps the checker useful
  without restating the SDK's whole message type for a debugging tool.
*/
interface StreamChunk {
  type: string;
  data?: {
    status?: string;
    stage?: string;
    label?: string;
    ms?: number;
    detail?: string;
    metrics?: Record<string, unknown>;
    supported?: boolean;
    citationDensity?: number;
    issues?: { claim: string; reason: string }[];
  } & Citation[];
  delta?: string;
}

for await (const chunk of stream as unknown as AsyncIterable<StreamChunk>) {
  if (chunk.type === "data-trace") {
    const d = chunk.data!;
    if (d.status !== "running") {
      const m = d.metrics ? Object.entries(d.metrics).map(([k, v]) => `${k}=${v}`).join(" ") : "";
      console.log(`  \x1b[2m${String(d.stage).padEnd(9)}\x1b[0m ${String(d.label).padEnd(46)} ${String(d.ms ?? "-").padStart(6)}ms  ${m}${d.detail ? ` \x1b[2m${d.detail}\x1b[0m` : ""}`);
    }
  }
  if (chunk.type === "text-delta") answer += chunk.delta ?? "";
  if (chunk.type === "data-citations") {
    console.log(`\n\x1b[36m── answer ──\x1b[0m\n${answer.trim()}\n`);
    console.log(`\x1b[36m── citations ──\x1b[0m`);
    for (const c of chunk.data as unknown as Citation[]) console.log(`  [${c.marker}] ${c.documentTitle} ${c.headingPath.join(" > ")}  score=${c.score.toFixed(3)}`);
  }
  if (chunk.type === "data-grounding") {
    const g = chunk.data!;
    console.log(`\n\x1b[36m── grounding ──\x1b[0m supported=${g.supported} density=${((g.citationDensity ?? 0)*100).toFixed(0)}% issues=${g.issues?.length ?? 0}`);
    for (const i of g.issues ?? []) console.log(`   ! ${i.claim} — ${i.reason}`);
  }
}
console.log(`\n\x1b[32mtotal ${((Date.now()-t0)/1000).toFixed(1)}s\x1b[0m`);
await sql.end();
