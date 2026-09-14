"use client";

import { useEffect, useState } from "react";

/**
 * Claims the shared sample corpus for this browser.
 *
 * The key lives in the URL fragment rather than the query string. A fragment is
 * never sent to the server, so it stays out of the platform's access log, out of
 * any proxy in between, and out of the Referer header — the three places a
 * one-time secret in a URL quietly outlives its one use. The browser reads it
 * locally and posts it, which also keeps the owner cookie attached, and that
 * cookie is the entire point: only this browser can make this claim.
 */
export default function AdoptPage() {
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [result, setResult] = useState<{ claimed: number; titles: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    setKey(hash.get("key") ?? "");
    // Drop it from the address bar so it does not sit in a shared screen or a
    // bookmark after it has been used.
    if (hash.get("key")) history.replaceState(null, "", window.location.pathname);
  }, []);

  async function claim() {
    setState("working");
    setMessage(null);
    try {
      const res = await fetch("/api/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("failed");
        setMessage("That key was not accepted, or the claim has already been closed.");
        return;
      }
      setResult(data);
      setState("done");
    } catch (error) {
      setState("failed");
      setMessage((error as Error).message);
    }
  }

  return (
    <main className="shell-app min-h-dvh bg-bg px-6 py-16 sm:px-12">
      <div className="mx-auto max-w-[52rem]">
        <p className="label">One-time claim</p>
        <h1 className="mt-3 text-h2 leading-[1.06] font-extrabold tracking-[-0.03em] text-fg">
          Make the sample corpus private to this browser.
        </h1>
        <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-fg-2">
          The documents currently shipped with this instance are readable by every visitor. Claiming
          them assigns them to this browser, after which no one else can list, search or delete
          them.
        </p>
        <p className="mt-3 max-w-[58ch] text-small leading-relaxed text-fg-3">
          Access is then tied to this browser&rsquo;s cookie. Clearing cookies or switching browsers
          makes them unreachable, including to you — there is no account to fall back on.
        </p>

        {state === "done" && result ? (
          <div className="card mt-8 px-5 py-4">
            <p className="text-small text-fg">
              {result.claimed} documents are now private to this browser.
            </p>
            <ul className="mt-3 space-y-1">
              {result.titles.map((t) => (
                <li key={t} className="mono truncate text-micro text-fg-3">
                  {t}
                </li>
              ))}
            </ul>
            <a href="/app" className="btn btn-primary btn-md mt-5">
              Back to Colophon
            </a>
          </div>
        ) : (
          <div className="mt-8">
            <button
              type="button"
              onClick={() => void claim()}
              disabled={!key || state === "working"}
              className="btn btn-primary btn-lg"
            >
              {state === "working" ? "Claiming…" : "Claim these documents"}
            </button>
            {!key && (
              <p className="mt-3 text-small text-alert">
                No key in this link. Open the full claim URL, including everything after the #.
              </p>
            )}
            {message && <p className="mt-3 text-small text-alert">{message}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
