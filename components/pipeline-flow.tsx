/**
 * The pipeline, running.
 *
 * A question enters, splits into the two retrieval arms, rejoins at fusion,
 * narrows through the cross-encoder, and leaves as a cited answer. The dashes
 * travel along each connector and every node lights as the signal reaches it,
 * so the drawing reads as a process rather than a diagram of one.
 *
 * Pure SVG and CSS — no JavaScript, no state, nothing on the main thread. It
 * is a server component for the same reason.
 */

interface Node {
  x: number;
  y: number;
  w: number;
  label: string;
  sub?: string;
  tone: "fg" | "jade" | "amber" | "muted";
  /** Where in the 5.4s cycle this node lights up. */
  delay: number;
}

const NODES: Node[] = [
  { x: 8, y: 96, w: 118, label: "Question", tone: "fg", delay: 0 },
  { x: 208, y: 24, w: 150, label: "Vector", sub: "meaning", tone: "jade", delay: 0.5 },
  { x: 208, y: 168, w: 150, label: "Lexical", sub: "exact wording", tone: "amber", delay: 0.5 },
  { x: 440, y: 96, w: 122, label: "Fuse", sub: "by rank", tone: "muted", delay: 1.1 },
  { x: 616, y: 96, w: 132, label: "Rerank", sub: "cross-encoder", tone: "muted", delay: 1.7 },
  { x: 802, y: 96, w: 118, label: "Answer", sub: "cited", tone: "fg", delay: 2.3 },
];

const TONE = {
  fg: "var(--color-fg)",
  jade: "var(--color-jade)",
  amber: "var(--color-amber)",
  muted: "var(--color-fg-2)",
} as const;

/** Connectors, each carrying its own travelling dash. */
const EDGES: { d: string; tone: keyof typeof TONE; delay: number }[] = [
  { d: "M126 125 C 170 125, 172 52, 208 52", tone: "jade", delay: 0 },
  { d: "M126 125 C 170 125, 172 196, 208 196", tone: "amber", delay: 0 },
  { d: "M358 52 C 400 52, 404 125, 440 125", tone: "jade", delay: 0.55 },
  { d: "M358 196 C 400 196, 404 125, 440 125", tone: "amber", delay: 0.55 },
  { d: "M562 125 H 616", tone: "muted", delay: 1.1 },
  { d: "M748 125 H 802", tone: "muted", delay: 1.7 },
];

export function PipelineFlow({ className = "" }: { className?: string }) {
  return (
    <figure className={className}>
      <svg
        viewBox="0 8 928 234"
        className="w-full"
        role="img"
        aria-label="A question splits into a vector search and a lexical search, which are fused by rank, narrowed by a cross-encoder, and returned as a cited answer."
      >
        {EDGES.map((e, i) => (
          <g key={i}>
            {/* Static rail, so the path reads even with motion disabled. */}
            <path d={e.d} fill="none" stroke={TONE[e.tone]} strokeWidth="1" opacity="0.22" />
            <path
              className="pipe-flow"
              d={e.d}
              fill="none"
              stroke={TONE[e.tone]}
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.85"
              style={{ animationDelay: `${e.delay}s` }}
            />
          </g>
        ))}

        {NODES.map((n) => {
          const h = n.sub ? 58 : 52;
          const colour = TONE[n.tone];
          return (
            <g key={n.label} className="pipe-node" style={{ animationDelay: `${n.delay}s` }}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={h}
                fill="var(--color-bg)"
                stroke={colour}
                strokeWidth="1.5"
              />
              <text
                x={n.x + n.w / 2}
                y={n.sub ? n.y + 25 : n.y + h / 2 + 5}
                textAnchor="middle"
                fill={colour}
                fontSize="15"
                fontWeight="700"
                fontFamily="var(--font-archivo), Helvetica, sans-serif"
              >
                {n.label}
              </text>
              {n.sub && (
                <text
                  x={n.x + n.w / 2}
                  y={n.y + 44}
                  textAnchor="middle"
                  fill="var(--color-fg-3)"
                  fontSize="11"
                  fontFamily="var(--font-jetbrains), monospace"
                >
                  {n.sub}
                </text>
              )}
            </g>
          );
        })}

        {/* The signal arriving at the answer. */}
        <circle
          className="pipe-pulse"
          cx={861}
          cy={125}
          r={7}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="1.5"
          style={{ animationDelay: "2.3s" }}
        />
      </svg>
    </figure>
  );
}
