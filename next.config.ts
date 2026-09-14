import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js writes AGENTS.md / CLAUDE.md by default; this project does not
  // want them in version control.
  agentRules: false,
  // Transformers.js loads native ONNX bindings and resolves model weights at
  // runtime. Bundling it breaks both, so it stays external to the server build.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
