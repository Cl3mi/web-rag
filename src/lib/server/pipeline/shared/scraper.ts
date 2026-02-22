/**
 * Web Scraper Service
 *
 * Handles sitemap parsing and HTML fetching with rate limiting.
 */

import { RateLimiter, conservativeRateLimiter } from './rate-limiter';

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  priority?: number;
}

export interface FetchResult {
  url: string;
  html: string;
  status: number;
  headers: Record<string, string>;
  fetchedAt: Date;
}

export interface ScraperOptions {
  /** Custom rate limiter */
  rateLimiter?: RateLimiter;
  /** Request timeout in ms */
  timeout?: number;
  /** Custom user agent */
  userAgent?: string;
  /** Maximum redirects to follow */
  maxRedirects?: number;
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; WebRAGLabBot/1.0; +https://github.com/web-rag-lab)';
const DEFAULT_TIMEOUT = 30000;

/**
 * Parse a sitemap XML and extract URLs
 */
export async function parseSitemap(
  sitemapUrl: string,
  options: ScraperOptions = {}
): Promise<SitemapUrl[]> {
  const {
    rateLimiter = conservativeRateLimiter,
    timeout = DEFAULT_TIMEOUT,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  await rateLimiter.acquire();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(sitemapUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    return parseSitemapXml(xml);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse sitemap XML content
 */
function parseSitemapXml(xml: string): SitemapUrl[] {
  const urls: SitemapUrl[] = [];

  // Check if this is a sitemap index
  const sitemapIndexMatch = xml.match(/<sitemapindex[^>]*>([\s\S]*?)<\/sitemapindex>/i);
  if (sitemapIndexMatch) {
    // This is a sitemap index, we'd need to recursively fetch sub-sitemaps
    // For now, just extract the sitemap URLs
    const sitemapMatches = xml.matchAll(/<sitemap[^>]*>([\s\S]*?)<\/sitemap>/gi);
    for (const match of sitemapMatches) {
      const locMatch = match[1].match(/<loc[^>]*>([^<]+)<\/loc>/i);
      if (locMatch) {
        urls.push({ loc: locMatch[1].trim() });
      }
    }
    return urls;
  }

  // Parse regular sitemap
  const urlMatches = xml.matchAll(/<url[^>]*>([\s\S]*?)<\/url>/gi);

  for (const match of urlMatches) {
    const urlContent = match[1];

    const locMatch = urlContent.match(/<loc[^>]*>([^<]+)<\/loc>/i);
    if (!locMatch) continue;

    const url: SitemapUrl = {
      loc: locMatch[1].trim(),
    };

    const lastmodMatch = urlContent.match(/<lastmod[^>]*>([^<]+)<\/lastmod>/i);
    if (lastmodMatch) {
      url.lastmod = lastmodMatch[1].trim();
    }

    const priorityMatch = urlContent.match(/<priority[^>]*>([^<]+)<\/priority>/i);
    if (priorityMatch) {
      url.priority = parseFloat(priorityMatch[1].trim());
    }

    urls.push(url);
  }

  return urls;
}

/**
 * Discover sitemap URLs for a domain
 */
export async function discoverSitemaps(
  baseUrl: string,
  options: ScraperOptions = {}
): Promise<string[]> {
  const {
    rateLimiter = conservativeRateLimiter,
    timeout = DEFAULT_TIMEOUT,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  const sitemaps: string[] = [];
  const parsedUrl = new URL(baseUrl);
  const baseOrigin = parsedUrl.origin;

  // Common sitemap locations
  const commonLocations = [
    `${baseOrigin}/sitemap.xml`,
    `${baseOrigin}/sitemap_index.xml`,
    `${baseOrigin}/sitemap/sitemap.xml`,
    `${baseOrigin}/sitemaps/sitemap.xml`,
  ];

  // Try robots.txt first
  try {
    await rateLimiter.acquire();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const robotsResponse = await fetch(`${baseOrigin}/robots.txt`, {
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
        },
      });

      if (robotsResponse.ok) {
        const robotsTxt = await robotsResponse.text();
        const sitemapMatches = robotsTxt.matchAll(/Sitemap:\s*(.+)/gi);

        for (const match of sitemapMatches) {
          const sitemapUrl = match[1].trim();
          if (!sitemaps.includes(sitemapUrl)) {
            sitemaps.push(sitemapUrl);
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    // robots.txt not found or error, continue with common locations
  }

  // Try common locations if no sitemaps found in robots.txt
  if (sitemaps.length === 0) {
    for (const location of commonLocations) {
      try {
        await rateLimiter.acquire();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          const response = await fetch(location, {
            method: 'HEAD',
            signal: controller.signal,
            headers: {
              'User-Agent': userAgent,
            },
          });

          if (response.ok) {
            sitemaps.push(location);
            break; // Found one, stop looking
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {
        // Continue to next location
      }
    }
  }

  return sitemaps;
}

/**
 * Fetch a single URL
 */
export async function fetchUrl(
  url: string,
  options: ScraperOptions = {}
): Promise<FetchResult> {
  const {
    rateLimiter = conservativeRateLimiter,
    timeout = DEFAULT_TIMEOUT,
    userAgent = DEFAULT_USER_AGENT,
    maxRedirects = 5,
  } = options;

  await rateLimiter.acquire();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html, application/xhtml+xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = await response.text();

    // Extract headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      url: response.url, // May differ from original due to redirects
      html,
      status: response.status,
      headers,
      fetchedAt: new Date(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch multiple URLs with rate limiting
 */
export async function fetchUrls(
  urls: string[],
  options: ScraperOptions = {},
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, FetchResult | Error>> {
  const results = new Map<string, FetchResult | Error>();
  const total = urls.length;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    try {
      const result = await fetchUrl(url, options);
      results.set(url, result);
    } catch (error) {
      results.set(url, error instanceof Error ? error : new Error(String(error)));
    }

    if (onProgress) {
      onProgress(i + 1, total);
    }
  }

  return results;
}

/**
 * Get all URLs from a domain by crawling its sitemaps
 */
export async function getAllUrlsFromDomain(
  baseUrl: string,
  options: ScraperOptions = {}
): Promise<SitemapUrl[]> {
  const allUrls: SitemapUrl[] = [];
  const seenUrls = new Set<string>();

  // Discover sitemaps
  const sitemapUrls = await discoverSitemaps(baseUrl, options);

  if (sitemapUrls.length === 0) {
    console.log('No sitemaps found, returning base URL only');
    return [{ loc: baseUrl }];
  }

  // Process each sitemap
  const processQueue = [...sitemapUrls];

  while (processQueue.length > 0) {
    const sitemapUrl = processQueue.shift()!;

    if (seenUrls.has(sitemapUrl)) continue;
    seenUrls.add(sitemapUrl);

    try {
      const urls = await parseSitemap(sitemapUrl, options);

      for (const url of urls) {
        // Check if this is a sub-sitemap (no extension or .xml)
        if (url.loc.endsWith('.xml') || url.loc.includes('sitemap')) {
          if (!seenUrls.has(url.loc)) {
            processQueue.push(url.loc);
          }
        } else {
          if (!seenUrls.has(url.loc)) {
            seenUrls.add(url.loc);
            allUrls.push(url);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to parse sitemap ${sitemapUrl}:`, error);
    }
  }

  return allUrls;
}
