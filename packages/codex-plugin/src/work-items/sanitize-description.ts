import sanitizeHtml from "sanitize-html";

export const MAX_SANITIZED_DESCRIPTION_BYTES = 256 * 1024;

const allowedTags = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "code",
  "pre",
  "a",
];

export interface SanitizedDescription {
  html?: string;
  truncated: boolean;
}

export function sanitizeDescription(input: string): SanitizedDescription {
  if (!input.trim()) return { html: undefined, truncated: false };

  const html = sanitizeHtml(input, {
    allowedTags,
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemesByTag: { a: ["https"] },
    transformTags: {
      a: (_tagName, attributes) => {
        const href = attributes.href;
        const attribs: Record<string, string> = href?.toLowerCase().startsWith("https://")
          ? { href, target: "_blank", rel: "noreferrer" }
          : {};
        return {
          tagName: "a",
          attribs,
        };
      },
    },
  }).trim();

  if (!html) return { html: undefined, truncated: false };
  if (Buffer.byteLength(html, "utf8") <= MAX_SANITIZED_DESCRIPTION_BYTES) {
    return { html, truncated: false };
  }

  const escapedText = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  });
  const wrapperBytes = Buffer.byteLength("<p>…</p>", "utf8");
  const boundedText = truncateUtf8(escapedText, MAX_SANITIZED_DESCRIPTION_BYTES - wrapperBytes)
    .replace(/&[^;]*$/, "");
  return { html: `<p>${boundedText}…</p>`, truncated: true };
}

function truncateUtf8(value: string, maximumBytes: number) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
