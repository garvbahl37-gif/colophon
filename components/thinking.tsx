"use client";

/**
 * What the reader looks at while eight stages run.
 *
 * This was the word "Searching…", which is wrong twice over: the pipeline is
 * usually not searching — it spends most of its time planning, reranking or
 * generating — and a static line gives no sign that anything is still
 * happening. On a provider that serialises requests, thirty seconds of work and
 * thirty seconds of a hung request look identical.
 *
 * So: the same red block the composer uses for a caret, marching across a short
 * track. Deliberately wordless. The trace panel beside it already names every
 * stage with its real latency, and repeating that here in prose made the
 * interface narrate itself twice while saying less than the panel does.
 *
 * Wordless is not silent. Screen readers get a live region that says the work is
 * in progress, because an animation conveys nothing to someone who cannot see it.
 */
export function Thinking() {
  return (
    <div className="flex items-center" role="status">
      <span aria-hidden className="flex items-end gap-[3px]">
        <i className="think-cell" />
        <i className="think-cell" />
        <i className="think-cell" />
        <i className="think-cell" />
        <i className="think-cell" />
      </span>
      <span className="sr-only">Working on your question</span>
    </div>
  );
}
