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

const { SentenceTokenizer, WordTokenizer, PorterStemmer } = natural;

export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence: number;
  sourceContext: string;
  metadata: {
    extractedFrom?: string;
    entities?: string[];
    relations?: string[];
  };
}

export interface FactExtractionOptions {
  minConfidence?: number;
  maxFacts?: number;
  includeContext?: boolean;
}

// SentenceTokenizer needs abbreviation list
const abbreviations = ['dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e'];
const sentenceTokenizer = new SentenceTokenizer(abbreviations);
const wordTokenizer = new WordTokenizer();

// Keywords for category classification
const categoryKeywords: Record<FactCategory, string[]> = {
  SPEC: [
    'parameter', 'value', 'dimension', 'size', 'width', 'height', 'version',
    'limit', 'maximum', 'minimum', 'default', 'configuration', 'setting',
    'requirement', 'specification', 'standard', 'format', 'type', 'unit',
    'measure', 'metric', 'kb', 'mb', 'gb', 'ms', 'seconds', 'minutes',
  ],
  PROC: [
    'step', 'first', 'then', 'next', 'finally', 'process', 'procedure',
    'method', 'approach', 'how to', 'install', 'configure', 'setup',
    'create', 'build', 'run', 'execute', 'deploy', 'start', 'stop',
    'click', 'select', 'enter', 'press', 'navigate', 'open', 'close',
  ],
  DEF: [
    'is', 'are', 'means', 'refers to', 'defined as', 'known as',
    'represents', 'describes', 'indicates', 'denotes', 'consists of',
    'comprises', 'includes', 'contains', 'explanation', 'concept',
  ],
  REL: [
    'compared to', 'versus', 'vs', 'similar to', 'different from',
    'related to', 'depends on', 'requires', 'uses', 'based on',
    'derived from', 'extends', 'implements', 'inherits', 'connects',
    'integrates', 'links', 'associated', 'connected',
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
    minConfidence = 0.5,
    maxFacts = 100,
    includeContext = true,
  } = options;

  const facts: ExtractedFact[] = [];

  // Clean and normalize text
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split into sentences
  const sentences = sentenceTokenizer.tokenize(cleanText);

  // Process each sentence
  for (let i = 0; i < sentences.length && facts.length < maxFacts; i++) {
    const sentence = sentences[i].trim();

    // Skip non-factual content
    if (isNonFactual(sentence)) continue;

    // Skip very short or very long sentences
    if (sentence.length < 20 || sentence.length > 500) continue;

    // Extract entities and keywords
    const entities = extractEntities(sentence);
    const category = classifyFact(sentence);
    const confidence = calculateConfidence(sentence, entities);

    if (confidence >= minConfidence) {
      // Get context (surrounding sentences)
      const context = includeContext
        ? getContext(sentences, i)
        : sentence;

      // Make fact standalone if needed
      const standaloneFact = makeStandalone(sentence, context);

      facts.push({
        content: standaloneFact,
        category,
        confidence,
        sourceContext: context,
        metadata: {
          extractedFrom: sentence,
          entities: entities.length > 0 ? entities : undefined,
        },
      });
    }
  }

  // Also extract facts from lists and bullet points
  const listFacts = extractListFacts(text, minConfidence, maxFacts - facts.length);
  facts.push(...listFacts);

  // Also extract facts from code blocks (if present)
  const codeFacts = extractCodeFacts(text, minConfidence, maxFacts - facts.length);
  facts.push(...codeFacts);

  return facts.slice(0, maxFacts);
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
 * Make a fact standalone by resolving pronouns and references
 */
function makeStandalone(sentence: string, context: string): string {
  // Simple pronoun resolution - could be improved with proper NLP
  let result = sentence;

  // If sentence starts with pronoun, try to find antecedent
  const pronounStarts = ['it ', 'they ', 'this ', 'these ', 'that '];

  for (const pronoun of pronounStarts) {
    if (result.toLowerCase().startsWith(pronoun)) {
      // Extract potential antecedent from context
      const contextWords = wordTokenizer.tokenize(context) || [];
      const capitalizedNouns = contextWords.filter(
        (w) => /^[A-Z][a-z]+$/.test(w) && !['The', 'This', 'That', 'It'].includes(w)
      );

      if (capitalizedNouns.length > 0) {
        // Replace pronoun with first noun found
        const noun = capitalizedNouns[0];
        result = noun + result.slice(pronoun.trim().length);
      }
      break;
    }
  }

  return result;
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

    // Skip very short items
    if (item.length < 15) continue;

    const entities = extractEntities(item);
    const category = classifyFact(item);
    const confidence = calculateConfidence(item, entities) - 0.1; // Slightly lower for list items

    if (confidence >= minConfidence) {
      facts.push({
        content: item,
        category,
        confidence,
        sourceContext: item,
        metadata: {
          extractedFrom: `List item: ${item}`,
          entities: entities.length > 0 ? entities : undefined,
        },
      });
    }
  }

  return facts;
}

/**
 * Extract facts from code blocks
 */
function extractCodeFacts(
  text: string,
  minConfidence: number,
  maxFacts: number
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Find code blocks
  const codeBlockPattern = /```(\w+)?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockPattern.exec(text)) !== null && facts.length < maxFacts) {
    const language = match[1] || 'code';
    const code = match[2].trim();

    // Skip very short code blocks
    if (code.length < 20) continue;

    // Create a fact about the code example
    const factContent = `Code example in ${language}: ${code.slice(0, 100)}${code.length > 100 ? '...' : ''}`;

    facts.push({
      content: factContent,
      category: 'SPEC',
      confidence: 0.7,
      sourceContext: code,
      metadata: {
        extractedFrom: `Code block (${language})`,
      },
    });
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
