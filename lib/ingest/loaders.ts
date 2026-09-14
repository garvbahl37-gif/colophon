import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import matter from "gray-matter";

export type SourceType = "pdf" | "docx" | "markdown" | "text" | "html" | "url";

export interface LoadedDocument {
  title: string;
  sourceType: SourceType;
  /** Normalised to Markdown-ish text so one chunker handles every format. */
  text: string;
  /** Present for paginated formats; maps a char offset to its page. */
  pageBreaks?: number[];
  metadata: Record<string, unknown>;
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function extFor(filename: string) {
  return filename.toLowerCase().split(".").pop() ?? "";
}

function titleFrom(filename: string, text: string) {
  const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (firstHeading && firstHeading.length < 120) return firstHeading;
  return filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Untitled";
}

async function loadPdf(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text: pages, totalPages } = await extractText(pdf, { mergePages: false });

  // Track where each page begins so chunks can carry a page number for citations.
  const pageBreaks: number[] = [];
  let offset = 0;
  const parts: string[] = [];
  for (const page of pages as string[]) {
    pageBreaks.push(offset);
    const cleaned = normalisePdfText(page);
    parts.push(cleaned);
    offset += cleaned.length + 2;
  }

  return {
    title: titleFrom(filename, ""),
    sourceType: "pdf",
    text: parts.join("\n\n"),
    pageBreaks,
    metadata: { pages: totalPages },
  };
}

/**
 * PDF text extraction produces hard-wrapped lines and hyphen-split words.
 * Rejoining them matters a lot: a chunk that reads "authen-\ntication" tokenises
 * badly for the lexical arm and embeds badly for the dense arm.
 */
function normalisePdfText(raw: string): string {
  return raw
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/([^\n.!?:;])\n(?=[a-z(])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function loadDocx(buffer: Buffer, filename: string): Promise<LoadedDocument> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const text = turndown.turndown(html);
  return {
    title: titleFrom(filename, text),
    sourceType: "docx",
    text,
    metadata: {},
  };
}

function loadHtml(html: string, filename: string, url?: string): LoadedDocument {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, iframe, svg, form").remove();
  const pageTitle = $("title").first().text().trim();
  const root = $("article").length ? $("article") : $("main").length ? $("main") : $("body");
  const text = turndown.turndown(root.html() ?? "");
  return {
    title: pageTitle || titleFrom(filename, text),
    sourceType: url ? "url" : "html",
    text,
    metadata: url ? { url } : {},
  };
}

function loadMarkdown(raw: string, filename: string): LoadedDocument {
  const { data, content } = matter(raw);
  return {
    title: (data.title as string) || titleFrom(filename, content),
    sourceType: "markdown",
    text: content,
    metadata: data ?? {},
  };
}

export async function loadFile(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<LoadedDocument> {
  const ext = extFor(filename);
  if (ext === "pdf" || mimeType === "application/pdf") return loadPdf(buffer, filename);
  if (ext === "docx" || mimeType?.includes("wordprocessingml"))
    return loadDocx(buffer, filename);

  const raw = buffer.toString("utf8");
  if (ext === "html" || ext === "htm") return loadHtml(raw, filename);
  if (ext === "md" || ext === "mdx" || ext === "markdown") return loadMarkdown(raw, filename);
  return {
    title: titleFrom(filename, raw),
    sourceType: "text",
    text: raw,
    metadata: {},
  };
}

export async function loadUrl(url: string): Promise<LoadedDocument> {
  const res = await fetch(url, {
    headers: { "user-agent": "ColophonRAG/1.0 (+document ingestion)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "";
  const filename = new URL(url).pathname.split("/").pop() || new URL(url).hostname;

  if (contentType.includes("application/pdf")) {
    const doc = await loadPdf(Buffer.from(await res.arrayBuffer()), filename);
    return { ...doc, sourceType: "url", metadata: { ...doc.metadata, url } };
  }
  const body = await res.text();
  if (contentType.includes("text/html")) return loadHtml(body, filename, url);
  return {
    title: filename,
    sourceType: "url",
    text: body,
    metadata: { url },
  };
}
