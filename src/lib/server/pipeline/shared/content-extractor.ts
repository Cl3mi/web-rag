/**
 * Content Extractor Service
 *
 * Uses @mozilla/readability for article extraction
 * and Turndown for HTML to Markdown conversion.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

export interface ExtractedContent {
  /** Page title */
  title: string | null;
  /** Plain text content */
  textContent: string;
  /** Markdown formatted content */
  markdownContent: string;
  /** Content excerpt/summary */
  excerpt: string | null;
  /** Word count */
  wordCount: number;
  /** Whether content contains code blocks */
  hasCodeBlocks: boolean;
  /** Detected language (basic detection) */
  language: string | null;
  /** Main content HTML (cleaned) */
  contentHtml: string | null;
}

export interface ExtractorOptions {
  /** Include images in markdown */
  includeImages?: boolean;
  /** Include links in markdown */
  includeLinks?: boolean;
  /** Preserve code blocks */
  preserveCodeBlocks?: boolean;
  /** Maximum content length (0 = unlimited) */
  maxLength?: number;
}

// Configure Turndown
function createTurndownService(options: ExtractorOptions = {}): TurndownService {
  const {
    includeImages = false,
    includeLinks = true,
    preserveCodeBlocks = true,
  } = options;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  // Handle code blocks
  if (preserveCodeBlocks) {
    turndown.addRule('codeBlock', {
      filter: ['pre'],
      replacement: (content, node) => {
        const element = node as HTMLElement;
        const codeElement = element.querySelector('code');
        const code = codeElement ? codeElement.textContent : element.textContent;
        const lang = codeElement?.className?.match(/language-(\w+)/)?.[1] || '';
        return `\n\n\`\`\`${lang}\n${code?.trim()}\n\`\`\`\n\n`;
      },
    });
  }

  // Handle images
  if (!includeImages) {
    turndown.addRule('removeImages', {
      filter: 'img',
      replacement: () => '',
    });
  }

  // Handle links
  if (!includeLinks) {
    turndown.addRule('removeLinks', {
      filter: 'a',
      replacement: (content) => content,
    });
  }

  // Handle tables (preserve them)
  turndown.addRule('tables', {
    filter: ['table'],
    replacement: (content, node) => {
      const element = node as HTMLElement;
      return '\n\n' + convertTableToMarkdown(element) + '\n\n';
    },
  });

  return turndown;
}

/**
 * Convert HTML table to Markdown table
 */
function convertTableToMarkdown(table: HTMLElement): string {
  const rows: string[][] = [];

  // Extract rows
  const htmlRows = table.querySelectorAll('tr');
  htmlRows.forEach((row) => {
    const cells: string[] = [];
    const htmlCells = row.querySelectorAll('th, td');
    htmlCells.forEach((cell) => {
      cells.push((cell.textContent || '').trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
    });
    if (cells.length > 0) {
      rows.push(cells);
    }
  });

  if (rows.length === 0) return '';

  // Build markdown table
  const lines: string[] = [];
  const maxCols = Math.max(...rows.map((r) => r.length));

  // Header row
  if (rows.length > 0) {
    const header = rows[0].map((cell) => cell || ' ').concat(Array(maxCols - rows[0].length).fill(' '));
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |');

    // Data rows
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i].concat(Array(maxCols - rows[i].length).fill(' '));
      lines.push('| ' + row.join(' | ') + ' |');
    }
  }

  return lines.join('\n');
}

/**
 * Extract content from HTML
 */
export function extractContent(
  html: string,
  url?: string,
  options: ExtractorOptions = {}
): ExtractedContent {
  const { maxLength = 0 } = options;

  // Parse HTML
  const dom = new JSDOM(html, {
    url,
    contentType: 'text/html',
  });
  const document = dom.window.document;

  // Remove unwanted elements
  const selectorsToRemove = [
    'script',
    'style',
    'noscript',
    'iframe',
    'nav',
    'footer',
    'header',
    '.advertisement',
    '.ads',
    '.sidebar',
    '.comments',
    '.social-share',
  ];

  selectorsToRemove.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  });

  // Use Readability to extract main content
  const reader = new Readability(document, {
    charThreshold: 100,
  });

  const article = reader.parse();

  // Get title from article or fallback to document title
  const title = article?.title || document.title || null;

  // Get content HTML
  let contentHtml = article?.content || document.body?.innerHTML || '';

  // Convert to markdown
  const turndown = createTurndownService(options);

  // Create a new DOM for the content to convert
  const contentDom = new JSDOM(contentHtml);
  const markdownContent = turndown.turndown(contentDom.window.document.body);

  // Get plain text
  let textContent = article?.textContent || '';
  if (!textContent) {
    // Fallback: extract text from content HTML
    textContent = contentDom.window.document.body.textContent || '';
  }

  // Clean up text content
  textContent = textContent
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  // Apply max length if specified
  if (maxLength > 0 && textContent.length > maxLength) {
    textContent = textContent.slice(0, maxLength) + '...';
  }

  // Count words
  const wordCount = textContent.split(/\s+/).filter((w) => w.length > 0).length;

  // Check for code blocks
  const hasCodeBlocks = markdownContent.includes('```') || html.includes('<code') || html.includes('<pre');

  // Basic language detection (very simple)
  const language = detectLanguage(textContent);

  // Get excerpt
  const excerpt = article?.excerpt || textContent.slice(0, 200) + (textContent.length > 200 ? '...' : '');

  return {
    title,
    textContent,
    markdownContent,
    excerpt,
    wordCount,
    hasCodeBlocks,
    language,
    contentHtml: article?.content || null,
  };
}

/**
 * Very basic language detection based on common words
 */
function detectLanguage(text: string): string | null {
  const lowerText = text.toLowerCase();

  // Count language-specific words
  const englishWords = ['the', 'and', 'is', 'are', 'was', 'were', 'have', 'has', 'this', 'that'];
  const germanWords = ['der', 'die', 'das', 'und', 'ist', 'sind', 'haben', 'hat', 'diese', 'dieser'];

  let englishCount = 0;
  let germanCount = 0;

  for (const word of englishWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    englishCount += (lowerText.match(regex) || []).length;
  }

  for (const word of germanWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    germanCount += (lowerText.match(regex) || []).length;
  }

  if (englishCount > germanCount * 2) return 'en';
  if (germanCount > englishCount * 2) return 'de';
  if (englishCount > germanCount) return 'en';
  if (germanCount > englishCount) return 'de';

  return null;
}

/**
 * Extract content from multiple HTML documents
 */
export function extractContentBatch(
  documents: Array<{ html: string; url?: string }>,
  options: ExtractorOptions = {}
): ExtractedContent[] {
  return documents.map((doc) => extractContent(doc.html, doc.url, options));
}

/**
 * Create a hash of content for deduplication
 */
export function hashContent(content: string): string {
  // Simple hash using native crypto
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Convert to hex string and pad
  const hexHash = Math.abs(hash).toString(16).padStart(8, '0');

  // Also include length for uniqueness
  return `${hexHash}-${content.length.toString(16)}`;
}

/**
 * Create SHA-256 hash (async, uses Web Crypto API)
 */
export async function hashContentSha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);

  // Use Node.js crypto
  const { createHash } = await import('crypto');
  const hash = createHash('sha256').update(data).digest('hex');

  return hash;
}
