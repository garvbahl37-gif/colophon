/** Downloads and loads any locally-routed models so no request pays the cold start. */
import "./env";
import { config } from "../lib/config";
import { warmLocalModels } from "../lib/ai/local";
import { parseSpec } from "../lib/ai/providers";

const local = Object.entries(config.models).filter(([, s]) => parseSpec(s).backend === "local");

if (local.length === 0) {
  console.log("No locally-routed models. Nothing to warm.");
} else {
  console.log(`Warming ${local.map(([stage, s]) => `${stage}=${parseSpec(s).id}`).join(", ")}`);
  const t = Date.now();
  await warmLocalModels(config.models.embed, config.models.rerank);
  console.log(`\x1b[32m✓\x1b[0m Ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
