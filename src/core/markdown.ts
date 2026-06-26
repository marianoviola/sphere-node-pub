// Minimal Markdown -> HTML renderer for the human reading surface.
//
// Deliberately small and dependency-free (the node ships zero runtime deps and
// runs on Workers). It covers exactly the `content.md` conventions the project
// documents: an H1 title, `##`+ headings, paragraphs, bold/italic, inline code,
// fenced code blocks with a language tag, links, images, ordered/unordered
// lists, blockquotes, and horizontal rules. It is NOT a full CommonMark engine;
// anything outside that subset degrades to escaped text rather than failing.
//
// Security: all text is HTML-escaped, and link/image URLs are scheme-checked so
// `javascript:`/`data:` URLs cannot smuggle script into the page. Pure: no I/O,
// no Cloudflare imports.

/**
 * Approximate word count of a Markdown body, for the human surface's meta lines
 * ("1,240 w", "6 min read"). Fenced code and the common Markdown punctuation are
 * stripped before counting so syntax doesn't inflate the number. Not exact, and
 * not meant to be — it only drives a rounded reading estimate.
 */
export function countWords(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()!|]/g, " ");
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

/** Escape the five HTML-significant characters. Safe for both text and attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allow only relative, http(s), and mailto URLs through. Anything with another
 * scheme (notably `javascript:` and `data:`) collapses to "#". The input is
 * already HTML-escaped, so this only inspects the scheme.
 */
function safeUrl(escapedUrl: string): string {
  const url = escapedUrl.trim();
  if (/^(https?:|mailto:|#|\/|\.|[^:]+$)/i.test(url)) return url;
  return "#";
}

/** Apply inline formatting to a single already-HTML-escaped run of text. */
function formatEscaped(escaped: string): string {
  let out = escaped;
  // Images before links (links would otherwise eat the `!` prefix's target).
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, url, title) => {
    const t = title ? ` title="${title}"` : "";
    return `<img src="${safeUrl(url)}" alt="${alt}"${t}>`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, text, url, title) => {
    const t = title ? ` title="${title}"` : "";
    return `<a href="${safeUrl(url)}"${t}>${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  return out;
}

/** Render an inline run: protect code spans, then escape and format the rest. */
function renderInline(raw: string): string {
  const parts: string[] = [];
  let i = 0;
  let buf = "";
  while (i < raw.length) {
    if (raw[i] === "`") {
      const close = raw.indexOf("`", i + 1);
      if (close !== -1) {
        parts.push(formatEscaped(escapeHtml(buf)));
        buf = "";
        parts.push(`<code>${escapeHtml(raw.slice(i + 1, close))}</code>`);
        i = close + 1;
        continue;
      }
    }
    buf += raw[i];
    i++;
  }
  parts.push(formatEscaped(escapeHtml(buf)));
  return parts.join("");
}

/**
 * Render a Markdown document to an HTML fragment string (no surrounding
 * document; the caller wraps it in a page template).
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let para: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${renderInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      const items = listItems.map((it) => `<li>${renderInline(it)}</li>`).join("");
      blocks.push(`<${listType}>${items}</${listType}>`);
      listType = null;
      listItems = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      flushAll();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence
      const cls = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      blocks.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushAll();
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      blocks.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushAll();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listItems.push(ul[1]!);
      i++;
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listItems.push(ol[1]!);
      i++;
      continue;
    }

    flushList();
    para.push(line.trim());
    i++;
  }

  flushAll();
  return blocks.join("\n");
}
