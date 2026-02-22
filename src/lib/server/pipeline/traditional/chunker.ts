/**
 * Semantic Chunker for Traditional Pipeline
 *
 * Intelligent text chunking that:
 * - Respects document structure (headings, paragraphs)
 * - Preserves tables as complete units
 * - Uses semantic boundaries for splitting
 * - Falls back to fixed-size for unstructured text
 */

import { encode } from 'gpt-tokenizer';
import { CHUNKING_CONFIG } from '$lib/config/database';

export interface Chunk {
  content: string;
  contentMarkdown: string;
  index: number;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  chunkType: 'text' | 'table' | 'mixed';
  hasTable: boolean;
  pageNumber?: number;
  sectionTitle?: string;
  tokenCount: number;
  startChar: number;
  endChar: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlap?: number;
  preserveTables?: boolean;
  minChunkSize?: number;
}

const defaultOptions: Required<ChunkOptions> = {
  maxTokens: CHUNKING_CONFIG.maxTokens,
  overlap: CHUNKING_CONFIG.overlap,
  preserveTables: CHUNKING_CONFIG.preserveTables,
  minChunkSize: CHUNKING_CONFIG.minChunkSize,
};

/**
 * Count tokens using GPT tokenizer
 */
export function countTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    // Fallback to character-based estimation
    return Math.ceil(text.length / CHUNKING_CONFIG.charsPerToken);
  }
}

/**
 * Extract table positions from text
 */
function extractTableRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = text.split('\n');

  let inTable = false;
  let tableStart = 0;
  let currentPos = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = line.trim().startsWith('|') && line.trim().endsWith('|');

    if (isTableLine && !inTable) {
      inTable = true;
      tableStart = currentPos;
    } else if (!isTableLine && inTable) {
      inTable = false;
      ranges.push({ start: tableStart, end: currentPos - 1 });
    }

    currentPos += line.length + 1; // +1 for newline
  }

  if (inTable) {
    ranges.push({ start: tableStart, end: text.length - 1 });
  }

  return ranges;
}

/**
 * Main chunking function
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...defaultOptions, ...options };

  // Clean text
  const cleanText = text.replace(/\r\n/g, '\n').trim();

  if (!cleanText) return [];

  // Extract table ranges
  const tableRanges = extractTableRanges(cleanText);
  const tablePositions = new Set<number>();

  for (const range of tableRanges) {
    for (let i = range.start; i <= range.end; i++) {
      tablePositions.add(i);
    }
  }

  // Build segments (text and tables)
  const segments: Array<{
    content: string;
    isTable: boolean;
    startPos: number;
    endPos: number;
  }> = [];

  let currentText = '';
  let currentStart = 0;
  let inTable = false;
  let tableStart = 0;

  for (let i = 0; i < cleanText.length; i++) {
    const isInTable = tablePositions.has(i);

    if (isInTable && !inTable) {
      // Starting a table
      if (currentText.trim()) {
        segments.push({
          content: currentText,
          isTable: false,
          startPos: currentStart,
          endPos: i - 1,
        });
      }
      currentText = '';
      tableStart = i;
      inTable = true;
    } else if (!isInTable && inTable) {
      // Ending a table
      const tableContent = cleanText.slice(tableStart, i);
      if (tableContent.trim()) {
        segments.push({
          content: tableContent,
          isTable: true,
          startPos: tableStart,
          endPos: i - 1,
        });
      }
      currentStart = i;
      currentText = '';
      inTable = false;
    }

    if (!inTable) {
      currentText += cleanText[i];
    }
  }

  // Handle remaining content
  if (inTable) {
    const tableContent = cleanText.slice(tableStart);
    if (tableContent.trim()) {
      segments.push({
        content: tableContent,
        isTable: true,
        startPos: tableStart,
        endPos: cleanText.length - 1,
      });
    }
  } else if (currentText.trim()) {
    segments.push({
      content: currentText,
      isTable: false,
      startPos: currentStart,
      endPos: cleanText.length - 1,
    });
  }

  // Now chunk each segment
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const segment of segments) {
    if (segment.isTable && opts.preserveTables) {
      const tableTokens = countTokens(segment.content);

      if (tableTokens <= opts.maxTokens * 2) {
        // Keep table as single chunk
        chunks.push(createChunk(
          segment.content,
          segment.content,
          chunkIndex++,
          'table',
          segment.startPos,
          segment.endPos
        ));
      } else {
        // Split large table by rows
        const tableChunks = splitLargeTable(
          segment.content,
          opts.maxTokens,
          segment.startPos,
          chunkIndex
        );
        for (const chunk of tableChunks) {
          chunks.push(chunk);
          chunkIndex++;
        }
      }
    } else {
      // Text segments use semantic chunking
      const textChunks = chunkTextSemantic(
        segment.content,
        opts.maxTokens,
        opts.overlap,
        opts.minChunkSize,
        segment.startPos,
        chunkIndex
      );
      for (const chunk of textChunks) {
        chunks.push(chunk);
        chunkIndex++;
      }
    }
  }

  // Filter out chunks that are too small
  return chunks.filter((chunk) => chunk.content.length >= opts.minChunkSize);
}

/**
 * Semantic text chunking
 */
function chunkTextSemantic(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  minSize: number,
  globalStartPos: number,
  startIndex: number
): Chunk[] {
  // Try splitting by paragraphs first
  const paragraphs = text.split(/\n\n+/);

  if (paragraphs.length > 1) {
    return chunkByParagraphs(
      paragraphs,
      maxTokens,
      overlapTokens,
      minSize,
      globalStartPos,
      startIndex
    );
  }

  // Try splitting by sentences
  const sentences = text.split(/(?<=[.!?])\s+/);

  if (sentences.length > 1) {
    return chunkBySentences(
      sentences,
      maxTokens,
      overlapTokens,
      minSize,
      globalStartPos,
      startIndex
    );
  }

  // Fall back to fixed-size chunking
  return chunkFixedSize(
    text,
    maxTokens,
    overlapTokens,
    minSize,
    globalStartPos,
    startIndex
  );
}

/**
 * Chunk by paragraphs
 */
function chunkByParagraphs(
  paragraphs: string[],
  maxTokens: number,
  overlapTokens: number,
  minSize: number,
  globalStartPos: number,
  startIndex: number
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentContent = '';
  let currentStart = globalStartPos;
  let chunkIndex = startIndex;
  let charPos = globalStartPos;

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) {
      charPos += para.length + 2;
      continue;
    }

    const potentialContent = currentContent + (currentContent ? '\n\n' : '') + trimmedPara;
    const potentialTokens = countTokens(potentialContent);

    if (potentialTokens > maxTokens && currentContent) {
      // Save current chunk
      if (currentContent.trim().length >= minSize) {
        chunks.push(createChunk(
          currentContent.trim(),
          currentContent.trim(),
          chunkIndex++,
          'text',
          currentStart,
          charPos - 1
        ));
      }

      // Start new chunk with overlap
      const overlap = getOverlapText(currentContent, overlapTokens);
      currentContent = overlap + (overlap ? '\n\n' : '') + trimmedPara;
      currentStart = charPos - overlap.length;
    } else {
      currentContent = potentialContent;
    }

    charPos += para.length + 2;
  }

  // Save remaining content
  if (currentContent.trim().length >= minSize) {
    chunks.push(createChunk(
      currentContent.trim(),
      currentContent.trim(),
      chunkIndex,
      'text',
      currentStart,
      charPos - 1
    ));
  }

  return chunks;
}

/**
 * Chunk by sentences
 */
function chunkBySentences(
  sentences: string[],
  maxTokens: number,
  overlapTokens: number,
  minSize: number,
  globalStartPos: number,
  startIndex: number
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentContent = '';
  let currentStart = globalStartPos;
  let chunkIndex = startIndex;
  let charPos = globalStartPos;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      charPos += sentence.length + 1;
      continue;
    }

    const potentialContent = currentContent + (currentContent ? ' ' : '') + trimmed;
    const potentialTokens = countTokens(potentialContent);

    if (potentialTokens > maxTokens && currentContent) {
      if (currentContent.trim().length >= minSize) {
        chunks.push(createChunk(
          currentContent.trim(),
          currentContent.trim(),
          chunkIndex++,
          'text',
          currentStart,
          charPos - 1
        ));
      }

      const overlap = getOverlapText(currentContent, overlapTokens);
      currentContent = overlap + (overlap ? ' ' : '') + trimmed;
      currentStart = charPos - overlap.length;
    } else {
      currentContent = potentialContent;
    }

    charPos += sentence.length + 1;
  }

  if (currentContent.trim().length >= minSize) {
    chunks.push(createChunk(
      currentContent.trim(),
      currentContent.trim(),
      chunkIndex,
      'text',
      currentStart,
      charPos - 1
    ));
  }

  return chunks;
}

/**
 * Fixed-size chunking as fallback
 */
function chunkFixedSize(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  minSize: number,
  globalStartPos: number,
  startIndex: number
): Chunk[] {
  const chunks: Chunk[] = [];
  const maxChars = maxTokens * CHUNKING_CONFIG.charsPerToken;
  const overlapChars = overlapTokens * CHUNKING_CONFIG.charsPerToken;

  let chunkIndex = startIndex;
  let pos = 0;

  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    let chunkEnd = end;

    // Try to break at word boundary
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > pos + maxChars * 0.5) {
        chunkEnd = lastSpace;
      }
    }

    const content = text.slice(pos, chunkEnd).trim();

    if (content.length >= minSize) {
      chunks.push(createChunk(
        content,
        content,
        chunkIndex++,
        'text',
        globalStartPos + pos,
        globalStartPos + chunkEnd - 1
      ));
    }

    // Move position with overlap
    pos = chunkEnd - overlapChars;
    if (pos <= 0 || pos === chunkEnd - overlapChars && chunkEnd === end) {
      pos = chunkEnd;
    }
  }

  return chunks;
}

/**
 * Split large table by rows
 */
function splitLargeTable(
  tableText: string,
  maxTokens: number,
  startPos: number,
  startIndex: number
): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = tableText.split('\n');

  // Find header rows
  const headerLines: string[] = [];
  let bodyStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    headerLines.push(lines[i]);
    if (lines[i].includes('---')) {
      bodyStartIndex = i + 1;
      break;
    }
    if (i >= 1) {
      bodyStartIndex = i;
      break;
    }
  }

  const header = headerLines.join('\n');
  const bodyLines = lines.slice(bodyStartIndex);

  let currentRows: string[] = [];
  let chunkIndex = startIndex;
  let charPos = startPos;

  for (const row of bodyLines) {
    const potentialContent = header + '\n' + [...currentRows, row].join('\n');
    const tokens = countTokens(potentialContent);

    if (tokens > maxTokens && currentRows.length > 0) {
      const content = header + '\n' + currentRows.join('\n');
      chunks.push(createChunk(
        content,
        content,
        chunkIndex++,
        'table',
        charPos,
        charPos + content.length - 1
      ));

      charPos += currentRows.join('\n').length + 1;
      currentRows = [row];
    } else {
      currentRows.push(row);
    }
  }

  if (currentRows.length > 0) {
    const content = header + '\n' + currentRows.join('\n');
    chunks.push(createChunk(
      content,
      content,
      chunkIndex,
      'table',
      charPos,
      charPos + content.length - 1
    ));
  }

  return chunks;
}

/**
 * Get overlap text from end of content
 */
function getOverlapText(content: string, overlapTokens: number): string {
  const overlapChars = overlapTokens * CHUNKING_CONFIG.charsPerToken;

  if (content.length <= overlapChars) return content;

  const startPos = content.length - overlapChars;
  const nextSpace = content.indexOf(' ', startPos);

  if (nextSpace !== -1 && nextSpace < content.length - 10) {
    return content.slice(nextSpace + 1);
  }

  return content.slice(startPos);
}

/**
 * Create a chunk with metadata
 */
function createChunk(
  content: string,
  markdown: string,
  index: number,
  type: 'text' | 'table' | 'mixed',
  startChar: number,
  endChar: number
): Chunk {
  const hasTable = markdown.includes('|') && markdown.includes('---');

  return {
    content,
    contentMarkdown: markdown,
    index,
    metadata: {
      chunkType: hasTable ? (type === 'text' ? 'mixed' : 'table') : type,
      hasTable,
      tokenCount: countTokens(content),
      startChar,
      endChar,
    },
  };
}

/**
 * Chunk text with section awareness (heading detection)
 */
export function chunkWithSections(
  text: string,
  options: ChunkOptions = {}
): Chunk[] {
  const chunks = chunkText(text, options);

  // Detect section titles for each chunk
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;

  for (const chunk of chunks) {
    const matches = [...chunk.content.matchAll(headingRegex)];
    if (matches.length > 0) {
      // Use the first heading as section title
      chunk.metadata.sectionTitle = matches[0][2];
    }
  }

  return chunks;
}
