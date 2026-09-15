"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The landing entrance.
 *
 * A title card, not a loading screen — nothing is actually being fetched, so
 * pretending otherwise would be a lie told with a spinner. It states what the
 * word means, which is the one piece of context that makes the rest of the page
 * land, and then gets out of the way.
 *
 * Rules it follows, because an intro that ignores them is an obstacle:
 *  - Once per session. Returning from /app does not replay it.
 *  - Skippable by any key, click, or scroll, immediately.
 *  - Absent entirely under prefers-reduced-motion.
 *  - Under two seconds unattended.
 *
 * Animation is CSS on opacity and transform only, so it composites off the
 * main thread and the page behind it keeps hydrating while it plays.
 */

const SEEN_KEY = "colophon.introSeen";
const DURATION = 2600;

export function LandingIntro() {
  const [state, setState] = useState<"hidden" | "playing" | "leaving">("hidden");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      /* private browsing: play it, just do not remember */
    }
    if (reduced || seen) return;

    // Whether this plays is a fact about the browser (session storage, motion
    // preference) and cannot be known during the server's render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("playing");

    // The flag is written when the intro ENDS, not when it starts. Writing it up
    // front means a double-invoked effect (StrictMode, and any future remount)
    // reads its own flag on the second pass, returns early, and leaves the card
    // on screen with no timer left to take it down.
    const pending = timers.current;
    const dismiss = () => {
      try {
        sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* private browsing: it plays again next navigation, which is survivable */
      }
      setState((s) => (s === "playing" ? "leaving" : s));
      timers.current.push(setTimeout(() => setState("hidden"), 620));
    };

    timers.current.push(setTimeout(dismiss, DURATION));

    // Any intent to interact ends it at once. An intro you cannot escape is
    // not cinematic, it is in the way.
    const skip = () => dismiss();
    window.addEventListener("keydown", skip, { once: true });
    window.addEventListener("pointerdown", skip, { once: true });
    window.addEventListener("wheel", skip, { once: true, passive: true });

    return () => {
      // Captured now: by the time this runs, timers.current may be a different
      // array than the one this effect actually filled.
      pending.forEach(clearTimeout);
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("wheel", skip);
    };
  }, []);

  if (state === "hidden") return null;

  return (
    <div
      aria-hidden
      className={`intro fixed inset-0 z-[100] flex flex-col justify-between bg-bg px-6 py-10 sm:px-12 sm:py-14 ${
        state === "leaving" ? "intro-leaving" : ""
      }`}
    >
      <div className="flex flex-1 items-center">
        <h1 className="display text-[clamp(2.75rem,15vw,12rem)] leading-[0.86]">
          {"COLOPHON".split("").map((ch, i) => (
            <span key={i} className="intro-letter inline-block" style={{ animationDelay: `${i * 46}ms` }}>
              {ch}
            </span>
          ))}
        </h1>
      </div>

      <div className="intro-foot">
        {/* The rule draws itself, then the definition arrives under it. */}
        <div className="intro-rule h-0.5 w-full origin-left bg-rule" />
        <p className="mt-5 max-w-[60ch] text-small leading-relaxed text-fg-2 sm:text-base">
          <span className="font-bold text-fg">col·o·phon</span>
          <span className="mono mx-2 text-micro text-fg-3">/ˈkɒləfən/</span>
          the note at the end of a book stating how it was made — the press, the
          paper, the typeface.
        </p>
        <p className="label mt-4">Press any key to continue</p>
      </div>
    </div>
  );
}
