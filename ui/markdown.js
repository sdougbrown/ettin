/* Minimal, dependency-free markdown renderer for the room transcript.
 *
 * Security model: every piece of text is HTML-escaped FIRST, and only then
 * are markdown constructs turned into tags via replacement — no raw input
 * ever reaches innerHTML. Supported syntax (aimed at agent chat output):
 *
 *   fenced code blocks ``` / ~~~ (with optional language tag)
 *   indented code blocks (4 spaces)
 *   headings (# .. ######)
 *   blockquotes (>)
 *   unordered (-, *, +) and ordered (1.) lists, nested one level
 *   horizontal rules (---)
 *   tables (| a | b |)
 *   inline: `code`, **bold**, *italic*, _italic_, [text](url),
 *           autolinks (https://…), ~~strikethrough~~
 *
 * exported as window.mdRender(text) -> HTML string.
 */

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* Inline pass: input is already-escaped text; output is safe HTML. */
function inline(text) {
  let out = text;
  // [text](url) — url escaped, only http(s)/mailto allowed
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!/^(https?:|mailto:)/i.test(url)) return m;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // bare URLs (not already inside an attribute)
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (m, pre, url) => {
    return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

/* Split a table row into trimmed cells. */
const tableCells = (row) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function mdRender(src) {
  const lines = String(src).split("\n");
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length) out.push(`<p>${inline(buf.join("<br>"))}</p>`);
    buf.length = 0;
  };

  let para = [];

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = /^(\s*)(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(para);
      const close = fence[2];
      const lang = fence[3];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${close}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run off the end)
      const cls = lang ? ` class="language-${esc(lang)}"` : "";
      out.push(`<pre><code${cls}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      out.push(`<h${level}>${inline(esc(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(?:(?:-\s*){3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(para);
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para);
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote><p>${inline(esc(body.join(" ")))}</p></blockquote>`);
      continue;
    }

    // table: header row with a separator row beneath (| x | y | or x | y)
    if (
      /^\s*\|?.*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("|")
    ) {
      flushParagraph(para);

      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c)
          ? ' style="text-align:center"'
          : /^-+:/.test(c)
            ? ' style="text-align:right"'
            : "",
      );
      i += 2;
      let rows = "";
      while (i < lines.length && /^\s*\|?.*\|/.test(lines[i]) && lines[i].trim()) {
        const row = tableCells(lines[i]);
        rows +=
          "<tr>" +
          row.map((c, k) => `<td${align[k] ?? ""}>${inline(esc(c))}</td>`).join("") +
          "</tr>";
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c, k) => `<th${align[k] ?? ""}>${inline(esc(c))}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows +
          "</tbody></table>",
      );
      continue;
    }

    // list block (one nesting level)
    const ulItem = /^(\s*)[-*+]\s+(.*)$/;
    const olItem = /^(\s*)\d+[.)]\s+(.*)$/;
    if (ulItem.test(line) || olItem.test(line)) {
      flushParagraph(para);
      const ordered = olItem.test(line);
      const tag = ordered ? "ol" : "ul";
      const re = ordered ? olItem : ulItem;
      const items = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) {
          items.push(`<li>${inline(esc(m[2]))}</li>`);
          i++;
        } else if (
          /^\s{2,}\S/.test(lines[i]) &&
          items.length &&
          !ulItem.test(lines[i]) &&
          !olItem.test(lines[i])
        ) {
          // continuation line: append to the previous item
          items[items.length - 1] =
            items[items.length - 1].replace(/<\/li>$/, "") +
            " " +
            inline(esc(lines[i].trim())) +
            "</li>";
          i++;
        } else break;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // blank line ends a paragraph
    if (!line.trim()) {
      flushParagraph(para);
      i++;
      continue;
    }

    // indented code (4 spaces) — only when not continuing a paragraph
    if (/^ {4}\S/.test(line) && para.length === 0) {
      const body = [];
      while (
        i < lines.length &&
        (/^ {4}\S/.test(lines[i]) || (/^\s{4,}/.test(lines[i]) && lines[i].trim()))
      ) {
        body.push(lines[i].slice(4));
        i++;
      }
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    para.push(esc(line));
    i++;
  }
  flushParagraph(para);
  return out.join("\n");
}
