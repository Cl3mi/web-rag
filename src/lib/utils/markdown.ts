import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  breaks: true, // single newline → <br>
  gfm: true,    // GitHub-flavored markdown
});

/**
 * Parse markdown to HTML and sanitize for safe `{@html}` rendering.
 *
 * Only sanitizes in the browser — chat messages are rendered client-side after
 * user interaction, so SSR never reaches the sanitize call. The guard avoids
 * needing a Node-side DOM (jsdom) just for an unused code path.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text ?? '', { async: false }) as string;
  if (typeof window === 'undefined') return html;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
