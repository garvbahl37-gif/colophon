/**
 * Next.js loads .env.local automatically; plain tsx scripts do not, and
 * `dotenv/config` only reads `.env`. Every script imports this first so the
 * CLI and the server see exactly the same configuration.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
