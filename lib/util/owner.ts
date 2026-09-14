import { cookies } from "next/headers";
import { nanoid } from "nanoid";

/**
 * Who this browser is, for the purpose of keeping corpora apart.
 *
 * The deployment has no accounts and should not grow them to solve this: what
 * is actually needed is that one visitor's documents are not readable,
 * searchable or deletable by the next, and an opaque per-browser id does that
 * without asking anyone to sign up.
 *
 * The cookie is httpOnly, so page scripts cannot read it and an injected script
 * cannot exfiltrate it. It is not a credential and must never be treated as
 * one: it survives exactly as long as the browser keeps it, anyone holding it
 * is that owner, and clearing cookies means losing access to your own
 * documents. That is the honest boundary of a design with no sign-in — good
 * enough to stop documents leaking between visitors, not a substitute for
 * authentication on anything that genuinely requires it.
 */

const COOKIE = "colophon_owner";
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Shape an id must have to be believed, so a hand-edited cookie cannot inject. */
const VALID = /^[A-Za-z0-9_-]{16,64}$/;

export async function currentOwner(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && VALID.test(existing)) return existing;

  const id = nanoid(24);
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  });
  return id;
}
