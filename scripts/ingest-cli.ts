/** Ingest files or URLs from the terminal: pnpm ingest ./docs/*.md https://example.com */
import "./env";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { sql } from "../lib/db/client";
import { ingestFile, ingestUrl } from "../lib/ingest/pipeline";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: pnpm ingest <file|url> [...]");
  process.exit(1);
}

for (const target of targets) {
  const started = Date.now();
  try {
    const result = target.startsWith("http")
      ? await ingestUrl(target)
      : await ingestFile(await readFile(target), basename(target));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      result.duplicate
        ? `\x1b[33m=\x1b[0m ${result.title} already indexed (${result.chunkCount} chunks)`
        : `\x1b[32m✓\x1b[0m ${result.title} — ${result.chunkCount} chunks in ${secs}s`,
    );
  } catch (error) {
    console.error(`\x1b[31m✗\x1b[0m ${target}: ${(error as Error).message}`);
  }
}
await sql.end();
