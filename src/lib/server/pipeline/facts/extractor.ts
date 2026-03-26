/**
 * Facts Extractor
 *
 * Extracts atomic, standalone facts from text content.
 * Uses rule-based extraction with NLP techniques.
 *
 * Categories:
 * - SPEC: Specifications, technical details, parameters
 * - PROC: Procedures, steps, processes, how-to
 * - DEF: Definitions, explanations, concepts
 * - REL: Relationships, connections, comparisons
 * - OTHER: Other factual statements
 */

import natural from 'natural';
import type { FactCategory } from '$lib/types';

const { SentenceTokenizer } = natural;

export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence: number;
  sourceContext: string;
  metadata: {
    extractedFrom?: string;
    entities?: string[];
    relations?: string[];
    codeBlock?: string;
    language?: string;
    /** Nearest section heading above this fact. Used to enrich the dense embedding
     *  target so that contextual retrieval works without LLM calls. */
    heading?: string;
  };
}

export interface FactExtractionOptions {
  minConfidence?: number;
  maxFacts?: number;
  includeContext?: boolean;
}

// SentenceTokenizer needs abbreviation list — include German degrees and common abbreviations
// so "M.Sc." / "B.Sc." / "z.B." / etc. are not treated as sentence boundaries.
const abbreviations = [
  // English
  'dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e',
  // Academic degrees
  'M.Sc', 'B.Sc', 'Ph.D', 'M.A', 'B.A', 'Mag', 'Dipl',
  // German common abbreviations
  'inkl', 'bzw', 'ggf', 'usw', 'z.B', 'd.h', 'u.a', 'sog', 'ca', 'Nr', 'Str', 'Abs', 'Tel', 'bzgl',
];
const sentenceTokenizer = new SentenceTokenizer(abbreviations);

// Keywords for category classification
const categoryKeywords: Record<FactCategory, string[]> = {
  SPEC: [
    'parameter', 'value', 'dimension', 'size', 'width', 'height', 'version',
    'limit', 'maximum', 'minimum', 'default', 'configuration', 'setting',
    'requirement', 'specification', 'standard', 'format', 'type', 'unit',
    'measure', 'metric', 'kb', 'mb', 'gb', 'ms', 'seconds', 'minutes',
    // German
    'maximal', 'minimal', 'bis zu', 'mindestens', 'größe', 'anzahl',
    'kapazität', 'speicher', 'zeitlimit', 'frist',
  ],
  PROC: [
    'step', 'first', 'then', 'next', 'finally', 'process', 'procedure',
    'method', 'approach', 'how to', 'install', 'configure', 'setup',
    'create', 'build', 'run', 'execute', 'deploy', 'start', 'stop',
    'click', 'select', 'enter', 'press', 'navigate', 'open', 'close',
    // German
    'schritt', 'zuerst', 'dann', 'anschließend', 'danach', 'klicken',
    'wählen', 'eingeben', 'öffnen', 'starten', 'beenden', 'installieren',
    'konfigurieren', 'erstellen', 'ausführen', 'navigieren', 'auswählen',
  ],
  DEF: [
    'is', 'are', 'means', 'refers to', 'defined as', 'known as',
    'represents', 'describes', 'indicates', 'denotes', 'consists of',
    'comprises', 'includes', 'contains', 'explanation', 'concept',
    // German
    'ist ein', 'ist eine', 'sind', 'bedeutet', 'bezeichnet', 'umfasst',
    'beinhaltet', 'besteht aus', 'ermöglicht', 'erlaubt', 'definiert als',
  ],
  REL: [
    'compared to', 'versus', 'vs', 'similar to', 'different from',
    'related to', 'depends on', 'requires', 'uses', 'based on',
    'derived from', 'extends', 'implements', 'inherits', 'connects',
    'integrates', 'links', 'associated', 'connected',
    // German
    'verglichen mit', 'im vergleich zu', 'basiert auf', 'verwendet',
    'benötigt', 'integriert', 'verbunden mit', 'abhängig von', 'erfordert',
    'unterstützt',
  ],
  OTHER: [],
};

// Patterns that indicate non-factual content
const nonFactualPatterns = [
  /^\s*$/,
  /^(note|warning|tip|important|caution):/i,
  /^(see also|related|learn more)/i,
  /^(click here|read more|continue)/i,
  /^\d+\.\s*$/,
  /^[-*•]\s*$/,
  /^(copyright|©|all rights reserved)/i,
];

/**
 * Extract facts from text content
 */
export function extractFacts(
  text: string,
  options: FactExtractionOptions = {}
): ExtractedFact[] {
  const {
    minConfidence = 0.45,
    maxFacts = 200,
    includeContext = true,
  } = options;

  const facts: ExtractedFact[] = [];

  // Clean and normalize text
  let cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .trim();

  // Strip markdown formatting markers so they don't leak into fact content.
  // extractHeadings() already ran on the original text, so heading structure is captured.
  // These replacements run before whitespace collapse so line-anchored patterns work.
  cleanText = cleanText
    // Heading markers: "# Title" → "Title." — appending a period forces the
    // sentence tokenizer to treat each heading as a sentence boundary, preventing
    // heading text from merging with the following paragraph after whitespace
    // collapse (e.g. "U27 Fondssparen Mit dem Fonds-Sparplan..." as one sentence).
    // If the heading already ends with a period, the \.? group strips it first
    // so we never produce double periods.
    .replace(/^#{1,6}\s+(.+?)\.?\s*$/gm, '$1.')
    // Bold/italic: **text** / *text* / __text__ / _text_ → text
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')
    .replace(/_{1,2}([^_\n]+)_{1,2}/g, '$1')
    // Links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Markdown table separator rows: | --- | --- | (no useful content)
    .replace(/^\|[\s|:-]+\|$/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // List item markers: "- item" / "* item" / "+ item" → "item"
    // extractListFacts() processes the original text for proper list context;
    // stripping markers here prevents the tokenizer from producing garbled
    // sentences like "- Bis zu 200 Website-Seiten." or "Features - A - B".
    .replace(/^[-*+]\s+/gm, '');

  // Pre-process: replace checkmark/bullet separators used in pricing/feature lists
  // e.g. "✓ Starter ✓ Pro ✓ Premium" → "Starter. Pro. Premium"
  // These never contain sentence-ending periods, so the tokenizer sees one giant run-on.
  cleanText = cleanText.replace(/[✓✗✘•◦▪▸►→]/g, '. ');

  // Pre-process: protect German date patterns from being treated as sentence ends.
  // We temporarily replace trailing periods with a placeholder, tokenize, then restore.
  const GERMAN_DATE_PLACEHOLDER = '\u2060DATE\u2060'; // word-joiner, invisible

  // (a) dd.mm. patterns like "09.11." / "08.02." (month-day pairs in date tables)
  cleanText = cleanText.replace(/\b(\d{1,2}\.\d{1,2})\./g, `$1${GERMAN_DATE_PLACEHOLDER}`);

  // (b) Bare day numbers that open a date range: "01. - 03.12." / "22. – 24.06."
  //     The period is followed by optional whitespace and a dash/en-dash, signalling
  //     a range continuation ("01. - 03.12.2025") not a sentence end.
  cleanText = cleanText.replace(/\b(\d{1,2})\.\s*([-–])/g, `$1${GERMAN_DATE_PLACEHOLDER} $2`);

  cleanText = cleanText.replace(/\s+/g, ' ').trim();

  // Split into sentences
  const rawSentences = sentenceTokenizer.tokenize(cleanText);
  // Restore the placeholder back to a period in each sentence
  const sentences = rawSentences.map((s) => s.replace(new RegExp(GERMAN_DATE_PLACEHOLDER, 'g'), '.'));

  // Build heading map: for each sentence index, the nearest preceding heading in the
  // original text. Used to prepend section context to sourceContext so that sentences
  // like "Bis zu 200 Website-Seiten." get "[Starter-Plan] ..." prepended.
  const headings = extractHeadings(text);
  const headingMap = new Map<number, string>();
  if (headings.length > 0) {
    for (let i = 0; i < sentences.length; i++) {
      // Find approximate position of this sentence in the original text.
      // Strategy: take the first 5 words as a probe instead of a 30-char slice.
      // After whitespace collapse, a sentence can span what were originally multiple
      // lines (e.g. a stripped heading merged with the following body text by \s+ → ' ').
      // A 30-char slice of such a merged sentence will NOT be found verbatim in the
      // original text (which still has \n\n between the lines), so indexOf returns -1.
      // The first N words almost always stay within a single original line and are
      // reliably locatable in the structured markdown.
      const firstWords = sentences[i]
        .replace(/^[#\s*+\-]+/, '')   // strip leading markup chars
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5)
        .join(' ');
      if (firstWords.length < 5) continue;
      const sentencePos = text.indexOf(firstWords);
      if (sentencePos < 0) continue;
      // Walk headings in order (they are already sorted by index) to find the last
      // heading whose character position precedes this sentence.
      let nearestHeading = '';
      for (const h of headings) {
        if (h.index <= sentencePos) {
          nearestHeading = h.text;
        } else {
          break;
        }
      }
      if (nearestHeading) {
        headingMap.set(i, nearestHeading);
      }
    }
  }

  // Process each sentence
  for (let i = 0; i < sentences.length && facts.length < maxFacts; i++) {
    const sentence = sentences[i].trim();

    // Skip non-factual content
    if (isNonFactual(sentence)) continue;

    // Skip very short or very long sentences.
    // 10-char minimum captures short structured data (office hours, contact details)
    // that 20-char minimum was silently discarding.
    if (sentence.length < 10 || sentence.length > 500) continue;

    // Extract entities and keywords
    const entities = extractEntities(sentence);
    const category = classifyFact(sentence);
    const confidence = calculateConfidence(sentence, entities);

    if (confidence >= minConfidence) {
      // Get context (surrounding sentences)
      const context = includeContext
        ? getContext(sentences, i)
        : sentence;

      // Prepend the nearest section heading so retrieval gets topical context even
      // when ±1 sentence context is insufficient (e.g. feature list items).
      const heading = headingMap.get(i);
      const sourceContext = heading ? `[${heading}] ${context}` : context;

      // Store the raw sentence as content — pronoun "resolution" via makeStandalone
      // corrupts embeddings (it replaces pronouns with the first capitalized noun it
      // finds, which is usually wrong and lowers cosine similarity to real queries).
      // heading is stored in metadata so the embedder can prepend it to the dense
      // embedding target (Contextual Retrieval pattern) without touching content.
      facts.push({
        content: sentence,
        category,
        confidence,
        sourceContext,
        metadata: {
          extractedFrom: sentence,
          entities: entities.length > 0 ? entities : undefined,
          heading: heading || undefined,
        },
      });
    }
  }

  // Aggregate consecutive pricing plan facts into composite plan facts so that
  // queries like "Welche Preisoptionen gibt es?" retrieve a fact containing the
  // plan name, price AND features together rather than isolated atomic feature
  // fragments (e.g. "1.000 Chat-Sessions/Monat." with no price context).
  const pricingComposites = extractPricingPlanFacts(facts, maxFacts - facts.length);
  facts.push(...pricingComposites);

  // Also extract facts from lists and bullet points
  const listFacts = extractListFacts(text, minConfidence, maxFacts - facts.length);
  facts.push(...listFacts);

  // Also extract facts from code blocks (if present)
  const codeFacts = extractCodeFacts(text, minConfidence, maxFacts - facts.length);
  facts.push(...codeFacts);

  // Deduplication: list items and the sentence tokenizer both process bullet content
  // (bullets are converted to ". " before tokenization AND matched by the list regex),
  // producing near-duplicate facts with different sourceContext. Keep first occurrence.
  const totalBeforeDedup = facts.length;
  const seen = new Set<string>();
  const deduplicated = facts.filter((fact) => {
    const normalized = fact.content
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.,;:!?]+$/, '')
      .trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  // Debug log — only when RAG_DEBUG=true, so production logs stay clean
  if (process.env.RAG_DEBUG === 'true') {
    const afterConf = deduplicated.filter((f) => f.confidence >= minConfidence).length;
    console.debug(
      `[extractFacts] sentences=${sentences.length}, facts_before_dedup=${totalBeforeDedup}, ` +
      `facts_after_dedup=${deduplicated.length}, facts_after_confidence=${afterConf}`
    );
  }

  return deduplicated.slice(0, maxFacts);
}

/**
 * Check if sentence is non-factual
 */
function isNonFactual(sentence: string): boolean {
  for (const pattern of nonFactualPatterns) {
    if (pattern.test(sentence)) return true;
  }

  // Check for questions
  if (sentence.endsWith('?')) return true;

  // Check for subjective language
  const subjectiveWords = ['maybe', 'perhaps', 'might', 'could be', 'possibly', 'probably'];
  const lowerSentence = sentence.toLowerCase();
  for (const word of subjectiveWords) {
    if (lowerSentence.includes(word)) {
      // Only skip if it's the main assertion
      if (lowerSentence.startsWith(word) || lowerSentence.includes(`, ${word}`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract named entities from sentence
 */
function extractEntities(sentence: string): string[] {
  const entities: string[] = [];

  // Extract capitalized words (potential proper nouns/names)
  const capitalizedPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  const matches = sentence.match(capitalizedPattern) || [];

  for (const match of matches) {
    // Skip if at start of sentence (might just be capitalization)
    if (sentence.startsWith(match) && matches.length === 1) continue;

    // Skip common words
    const commonWords = ['The', 'This', 'That', 'These', 'Those', 'It', 'They', 'We', 'You', 'I'];
    if (!commonWords.includes(match)) {
      entities.push(match);
    }
  }

  // Extract technical terms (camelCase, snake_case, kebab-case)
  const technicalPattern = /\b([a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z_]+|[a-z]+-[a-z-]+)\b/g;
  const techMatches = sentence.match(technicalPattern) || [];
  entities.push(...techMatches);

  // Extract code-like terms (in backticks)
  const codePattern = /`([^`]+)`/g;
  let codeMatch;
  while ((codeMatch = codePattern.exec(sentence)) !== null) {
    entities.push(codeMatch[1]);
  }

  return [...new Set(entities)];
}

/**
 * Classify fact into category
 */
function classifyFact(sentence: string): FactCategory {
  const lowerSentence = sentence.toLowerCase();
  const scores: Record<FactCategory, number> = {
    SPEC: 0,
    PROC: 0,
    DEF: 0,
    REL: 0,
    OTHER: 0,
  };

  // Score each category based on keyword matches
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    for (const keyword of keywords) {
      if (lowerSentence.includes(keyword)) {
        scores[category as FactCategory] += 1;
      }
    }
  }

  // Check for number patterns (likely SPEC)
  if (/\d+(\.\d+)?\s*(kb|mb|gb|ms|s|px|%|em|rem)/i.test(sentence)) {
    scores.SPEC += 2;
  }

  // Check for definition patterns
  if (/\bis\s+(a|an|the)\b/i.test(sentence) || /\bare\s+(a|an|the)?\s*\w+/i.test(sentence)) {
    scores.DEF += 1;
  }

  // Check for procedural patterns
  if (/\b(to\s+\w+|by\s+\w+ing)\b/i.test(sentence)) {
    scores.PROC += 1;
  }

  // Find max score
  let maxCategory: FactCategory = 'OTHER';
  let maxScore = 0;

  for (const [category, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxCategory = category as FactCategory;
    }
  }

  return maxCategory;
}

/**
 * Calculate confidence score for a fact
 */
function calculateConfidence(sentence: string, entities: string[]): number {
  let confidence = 0.5;

  // Increase confidence for concrete content
  if (entities.length > 0) confidence += 0.1;
  if (entities.length > 2) confidence += 0.1;

  // Increase confidence for technical content
  if (/`[^`]+`/.test(sentence)) confidence += 0.1;
  if (/\d+/.test(sentence)) confidence += 0.05;

  // Increase confidence for structured statements
  if (/\bis\b|\bare\b|\bwill\b|\bcan\b/.test(sentence.toLowerCase())) confidence += 0.1;

  // Decrease confidence for vague language
  if (/\bsome\b|\bseveral\b|\bmany\b|\bvarious\b/i.test(sentence)) confidence -= 0.1;
  if (/\betc\b|\band so on\b|\band more\b/i.test(sentence)) confidence -= 0.1;

  // Cap confidence
  return Math.min(Math.max(confidence, 0.1), 1.0);
}

/**
 * Get context around a sentence
 */
function getContext(sentences: string[], index: number): string {
  const contextSize = 1;
  const start = Math.max(0, index - contextSize);
  const end = Math.min(sentences.length, index + contextSize + 1);

  return sentences.slice(start, end).join(' ');
}


/**
 * Detect pricing plan blocks in the already-extracted sentence facts and create
 * one composite fact per plan that joins the plan header (price) with all its
 * feature sentences.
 *
 * Detection heuristic:
 * - A fact whose content matches a price pattern ("290€ / Monat") opens a plan block.
 * - Subsequent facts shorter than MAX_FEATURE_LENGTH are treated as features of that plan.
 * - A long fact (≥ MAX_FEATURE_LENGTH chars) or another price-bearing fact closes the block.
 *
 * The composite content is self-contained ("Starter für einfache Websites 290€/Monat:
 * Bis zu 200 Website-Seiten, Bis zu 5 PDF-Dokumente, ...") so it embeds and ranks
 * well for both pricing overview queries and specific feature queries.
 */
function extractPricingPlanFacts(
  facts: ExtractedFact[],
  maxFacts: number,
): ExtractedFact[] {
  const PRICE_PATTERN = /\d[\d.,]*\s*€\s*\/\s*Monat/i;
  const MAX_FEATURE_LENGTH = 120;
  const composites: ExtractedFact[] = [];

  let planHeader: ExtractedFact | null = null;
  let planFeatures: string[] = [];

  const flush = () => {
    if (planHeader && planFeatures.length > 0 && composites.length < maxFacts) {
      const headerText = planHeader.content.replace(/\.\s*$/, '');
      const composite = `${headerText}: ${planFeatures.join(', ')}.`;
      composites.push({
        content: composite,
        category: 'SPEC',
        confidence: 0.9,
        sourceContext: composite,
        metadata: { extractedFrom: 'Pricing plan composite' },
      });
    }
    planHeader = null;
    planFeatures = [];
  };

  for (const fact of facts) {
    if (composites.length >= maxFacts) break;

    if (PRICE_PATTERN.test(fact.content)) {
      flush();
      planHeader = fact;
    } else if (planHeader !== null && fact.content.length <= MAX_FEATURE_LENGTH) {
      planFeatures.push(fact.content.replace(/\.\s*$/, ''));
    } else if (planHeader !== null) {
      // Long fact signals end of pricing block
      flush();
    }
  }
  flush();

  return composites;
}

/**
 * Extract facts from lists and bullet points
 */
function extractListFacts(
  text: string,
  minConfidence: number,
  maxFacts: number
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Find list items
  const listPattern = /^[\s]*[-*•]\s+(.+)$/gm;
  let match;

  while ((match = listPattern.exec(text)) !== null && facts.length < maxFacts) {
    const item = match[1].trim();

    // Skip very short items (10 chars allows short structured values with heading context)
    if (item.length < 10) continue;

    const entities = extractEntities(item);
    const category = classifyFact(item);
    const confidence = calculateConfidence(item, entities) - 0.1; // Slightly lower for list items

    if (confidence >= minConfidence) {
      // Build sourceContext from the last non-list, non-empty line before this item.
      // List items almost always depend on an implicit subject from a heading or
      // intro sentence above them (e.g. "Features: - supports X" — without the
      // heading "Features:" the item "supports X" is meaningless in isolation).
      const textBefore = text.slice(0, match.index);
      const precedingLines = textBefore.split('\n').filter(
        (l) => l.trim() && !/^[\s]*[-*•\d+\.]\s+/.test(l)
      );
      const precedingLine = precedingLines.length > 0
        // Strip markdown heading markers so "[## Preisübersicht]" doesn't appear in sourceContext
        ? precedingLines[precedingLines.length - 1].trim().replace(/^#{1,6}\s+/, '')
        : '';
      const looksLikeHeading = precedingLine.length > 0 && precedingLine.length < 80 && !precedingLine.endsWith('.');
      const sourceContext = precedingLine
        ? looksLikeHeading
          ? `[${precedingLine}] ${item}`
          : `${precedingLine} ${item}`
        : item;

      facts.push({
        content: item,
        category,
        confidence,
        sourceContext,
        metadata: {
          extractedFrom: `List item: ${item}`,
          entities: entities.length > 0 ? entities : undefined,
          heading: looksLikeHeading ? precedingLine : undefined,
        },
      });
    }
  }

  return facts;
}

/**
 * Extract headings from text for heading-inheritance in sourceContext.
 * Returns headings in document order with their character positions in text.
 *
 * Only detects REAL Markdown headings (^#{1,6}\s+) — the previous heuristic
 * that matched any short line bordered by blank lines caused false positives:
 * body sentences like "ab € 50,- Veranlagungsbetrag pro Monat" and bold lines
 * like "**Veranlagungen in Finanzinstrumente bergen Risiken.**" were detected
 * as headings, shifting dense embeddings into incorrect topic regions and
 * causing completely wrong documents to rank first in retrieval.
 */
function extractHeadings(text: string): Array<{index: number, text: string}> {
  const headings: Array<{index: number, text: string}> = [];
  const lines = text.split('\n');
  let charIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Markdown headings only: lines starting with one or more '#' characters.
    // Turndown converts <h1>–<h6> HTML elements to ATX-style headings, so these
    // reliably reflect the page's actual section structure.
    const mdMatch = trimmed.match(/^#{1,6}\s+(.+)/);
    if (mdMatch) {
      // Strip any inline bold/italic markers from the heading text so stored
      // headings are clean: "## **U27** Fondssparen" → "U27 Fondssparen"
      const headingText = mdMatch[1].trim()
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
        .replace(/_{1,2}([^_]+)_{1,2}/g, '$1');
      headings.push({ index: charIndex, text: headingText });
    }

    charIndex += line.length + 1; // +1 for the '\n'
  }

  return headings;
}

/**
 * Extract facts from code blocks.
 * Rather than embedding raw code (nobody queries "code example in typescript"),
 * we extract the last descriptive line BEFORE each code block — that heading or
 * description is the actual retrievable claim. The code is stored in metadata so
 * the LLM can still render it during generation.
 */
function extractCodeFacts(
  text: string,
  minConfidence: number,
  maxFacts: number
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  const codeBlockPattern = /```(\w*)?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockPattern.exec(text)) !== null && facts.length < maxFacts) {
    const language = match[1] || undefined;
    const code = match[2].trim();

    if (code.length < 20) continue;

    // Find the last non-empty, non-list line before this code block
    const textBefore = text.slice(0, match.index);
    const precedingLines = textBefore.split('\n').filter(
      (l) => l.trim() && !/^[\s]*[-*•\d+\.]\s/.test(l)
    );
    if (precedingLines.length === 0) continue;

    const precedingLine = precedingLines[precedingLines.length - 1].trim()
      .replace(/^#+\s*/, ''); // strip markdown heading markers

    if (precedingLine.length < 15) continue;

    if (0.75 >= minConfidence && facts.length < maxFacts) {
      facts.push({
        content: precedingLine,
        category: 'PROC',
        confidence: 0.75,
        sourceContext: `${precedingLine}\n${code.slice(0, 200)}`,
        metadata: {
          extractedFrom: precedingLine,
          codeBlock: code,
          language,
        },
      });
    }
  }

  return facts;
}

/**
 * Batch extract facts from multiple documents
 */
export function extractFactsBatch(
  documents: Array<{ content: string; url?: string }>,
  options: FactExtractionOptions = {}
): Array<{ url?: string; facts: ExtractedFact[] }> {
  return documents.map((doc) => ({
    url: doc.url,
    facts: extractFacts(doc.content, options),
  }));
}
