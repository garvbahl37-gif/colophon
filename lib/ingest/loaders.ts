import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import matter from "gray-matter";
import { safeFetch } from "@/lib/util/safe-fetch";

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

  const text = parts.join("\n\n");

  return {
    title: pdfTitle(pdf, text, filename),
    sourceType: "pdf",
    text,
    pageBreaks,
    metadata: { pages: totalPages },
  };
}

/**
 * Names a PDF from its own contents rather than its filename.
 *
 * Exports and downloads are routinely named with a UUID or `document(3)`, and
 * that string then becomes the document title, the citation breadcrumb, and
 * part of every embedded chunk — so a meaningless filename degrades retrieval,
 * not just the sidebar. The embedded Title metadata is preferred, then the
 * first line that actually looks like a heading, and only then the filename.
 */
function pdfTitle(pdf: unknown, text: string, filename: string): string {
  const meta = (pdf as { _pdfInfo?: { Title?: string } })?._pdfInfo?.Title?.trim();
  if (meta && meta.length > 3 && meta.length < 120) return meta;

  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 8 && l.length < 120 && /[a-z]/i.test(l));
  if (firstLine) return firstLine.replace(/^#+\s*/, "");

  // A filename that is just a UUID or hex blob tells the reader nothing.
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  if (/^[0-9a-f\s-]{16,}$/i.test(stem)) return "Untitled PDF";
  return stem || "Untitled PDF";
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
  // safeFetch, not fetch: this address comes from whoever called the API, and
  // the body ends up readable through the chat endpoint. See lib/util/safe-fetch.
  const { body, contentType, finalUrl } = await safeFetch(url);
  const filename = new URL(finalUrl).pathname.split("/").pop() || new URL(finalUrl).hostname;

  if (contentType.includes("application/pdf")) {
    const doc = await loadPdf(body, filename);
    return { ...doc, sourceType: "url", metadata: { ...doc.metadata, url: finalUrl } };
  }

  const text = body.toString("utf8");
  if (contentType.includes("text/html")) return loadHtml(text, filename, finalUrl);
  return {
    title: filename,
    sourceType: "url",
    text,
    metadata: { url: finalUrl },
  };
}
