#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const ROOT_DIR = join(SCRIPT_DIR, '..');
const CONFIG_PATH = join(ROOT_DIR, 'config', 'sources.json');
const STATE_PATH = join(ROOT_DIR, 'state', 'state.json');
const OUTPUT_DIR = join(ROOT_DIR, 'output');
const LATEST_ITEMS_PATH = join(OUTPUT_DIR, 'latest-items.json');
const LATEST_DIGEST_PATH = join(OUTPUT_DIR, 'latest-digest.md');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 30000;
const STATE_RETENTION_DAYS = 45;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_TOTAL_LIMIT = 24;
const DEFAULT_ITEMS_PER_SOURCE = 6;
const DIGEST_TIME_ZONE = 'America/Los_Angeles';
const REMOVABLE_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src'
]);

const CLASSIFIERS = [
  {
    score: 5,
    reason: 'Corporate move or major external event',
    pattern: /\b(acquir(?:e|es|ed|ing)|acquisition|merger|invest(?:ment|s|ed)?|partner(?:ship|s|ed)?|joint venture|regulator|regulatory|antitrust|lawsuit|settlement|ban|blocked)\b/i
  },
  {
    score: 4,
    reason: 'Flagship model or product launch',
    pattern: /\b(introducing|introduce|launch(?:ed|es|ing)?|announce(?:d|ment|s)?|release(?:d|s)?|general availability|available now|preview|debut|unveil(?:ed|s)?)\b/i
  },
  {
    score: 3,
    reason: 'Safety, security, or policy update',
    pattern: /\b(safety|security|policy|governance|responsibility|compliance|trust|risk|election|privacy)\b/i
  },
  {
    score: 2,
    reason: 'Technical or research update',
    pattern: /\b(research|engineering|infrastructure|benchmark|paper|study|chip|gpu|data center|datacenter)\b/i
  }
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const state = await loadState();
  const now = Date.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  const lookbackDays = options.lookbackDays ?? config.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const totalLimit = options.totalLimit ?? config.totalLimit ?? DEFAULT_TOTAL_LIMIT;
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  const sourceFilter = options.sourceIds ? new Set(options.sourceIds) : null;
  const activeSources = (config.sources || []).filter(source => !sourceFilter || sourceFilter.has(source.id));

  if (activeSources.length === 0) {
    throw new Error('No sources selected. Check config/sources.json or your --source flags.');
  }

  const fetchResults = await Promise.all(
    activeSources.map(async source => {
      try {
        return await fetchSource(source, lookbackMs, now);
      } catch (error) {
        return { source, items: [], error: error.message };
      }
    })
  );
  const errors = [];
  const fetchedItems = [];

  for (const result of fetchResults) {
    if (result.error) {
      errors.push(`${result.source.label}: ${result.error}`);
      continue;
    }
    fetchedItems.push(...result.items);
  }

  const dedupedItems = dedupeItems(fetchedItems)
    .map(item => ({
      ...item,
      classification: classifyItem(item, now)
    }))
    .sort(compareItems)
    .slice(0, totalLimit);

  const newItems = dedupedItems.filter(item => !state.seenItems[item.id]);

  for (const item of dedupedItems) {
    state.seenItems[item.id] = now;
  }
  state.lastRunAt = new Date(now).toISOString();
  pruneState(state, now);

  const summary = {
    generatedAt: new Date(now).toISOString(),
    lookbackDays,
    sourcesChecked: activeSources.map(source => ({
      id: source.id,
      company: source.company,
      label: source.label
    })),
    totals: {
      fetched: fetchedItems.length,
      deduped: dedupedItems.length,
      new: newItems.length
    },
    items: dedupedItems,
    newItems,
    errors
  };

  const digest = renderDigest(summary);

  if (!options.noWrite) {
    await writeFile(LATEST_ITEMS_PATH, `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(LATEST_DIGEST_PATH, `${digest}\n`);
    await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  }

  process.stdout.write(`${digest}\n`);

  if (errors.length > 0) {
    process.stderr.write(`\nWarnings:\n${errors.map(err => `- ${err}`).join('\n')}\n`);
  }
}

function parseArgs(argv) {
  const options = {
    lookbackDays: null,
    totalLimit: null,
    sourceIds: null,
    noWrite: false
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--lookback-days' && argv[idx + 1]) {
      options.lookbackDays = Number(argv[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--total-limit' && argv[idx + 1]) {
      options.totalLimit = Number(argv[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--source' && argv[idx + 1]) {
      if (!options.sourceIds) options.sourceIds = [];
      options.sourceIds.push(argv[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--no-write') {
      options.noWrite = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/run-digest.js [--lookback-days N] [--total-limit N] [--source ID] [--no-write]\n'
      );
      process.exit(0);
    }
  }

  return options;
}

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { lastRunAt: null, seenItems: {} };
  }

  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!state.seenItems || typeof state.seenItems !== 'object') {
      state.seenItems = {};
    }
    return state;
  } catch {
    return { lastRunAt: null, seenItems: {} };
  }
}

function pruneState(state, now) {
  const cutoff = now - STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of Object.entries(state.seenItems)) {
    if (timestamp < cutoff) {
      delete state.seenItems[id];
    }
  }
}

async function fetchSource(source, lookbackMs, now) {
  let html = '';
  let htmlError = null;
  try {
    html = await fetchText(source.homepageUrl);
  } catch (error) {
    htmlError = error;
  }

  const feedUrls = [
    ...(source.feedUrls || []),
    ...(html ? discoverFeedUrls(html, source.homepageUrl) : [])
  ];

  const feedItems = [];
  const seenFeedUrls = new Set();
  for (const feedUrl of feedUrls) {
    if (seenFeedUrls.has(feedUrl)) continue;
    seenFeedUrls.add(feedUrl);
    try {
      const xml = await fetchText(feedUrl);
      feedItems.push(...parseFeed(xml, feedUrl));
    } catch {
      // Keep going. The HTML parsers below are the fallback.
    }
  }

  const jsonLdItems = html ? parseJsonLdArticles(html, source.homepageUrl) : [];
  const anchorItems = html ? parseAnchorArticles(html, source.homepageUrl) : [];

  const merged = dedupeItems(
    [...feedItems, ...jsonLdItems, ...anchorItems]
      .map(item => normalizeItem(item, source))
      .filter(Boolean)
      .filter(item => isAllowedBySource(item, source))
      .filter(item => isWithinLookback(item, lookbackMs, now))
  )
    .sort(compareItems)
    .slice(0, source.maxItems || DEFAULT_ITEMS_PER_SOURCE);

  if (merged.length === 0 && htmlError) {
    throw htmlError;
  }

  return { source, items: merged };
}

async function fetchText(url) {
  return curlFetchText(url);
}

function curlFetchText(url) {
  return execFileSync(
    'curl',
    [
      '-sS',
      '-f',
      '-L',
      '--compressed',
      '--max-time',
      String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
      '-A',
      USER_AGENT,
      '-H',
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8',
      '-H',
      'Accept-Language: en-US,en;q=0.9',
      '-H',
      'Cache-Control: no-cache',
      url
    ],
    {
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024
    }
  );
}

function discoverFeedUrls(html, baseUrl) {
  const urls = new Set();

  const relAlternateRegex = /<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = relAlternateRegex.exec(html)) !== null) {
    urls.add(normalizeUrl(match[1], baseUrl));
  }

  const hrefFeedRegex = /href=["']([^"']*(?:\/feed\/?|rss(?:\.xml)?|atom(?:\.xml)?|\/index\.xml|\/rss\/?)[^"']*)["']/gi;
  while ((match = hrefFeedRegex.exec(html)) !== null) {
    urls.add(normalizeUrl(match[1], baseUrl));
  }

  return [...urls].filter(Boolean);
}

function parseFeed(xml, baseUrl) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks
    .map(block => {
      const title = readXmlTag(block, ['title']);
      const url = readXmlLink(block);
      if (!title || !url) return null;

      const publishedAt = readXmlTag(block, ['pubDate', 'published', 'updated', 'dc:date']);
      const summary = readXmlTag(block, ['description', 'summary', 'content:encoded', 'content']);
      return {
        url: normalizeUrl(url, baseUrl),
        title: cleanText(title),
        summary: cleanText(summary),
        publishedAt: toIsoDate(publishedAt),
        discoveryMethod: 'feed'
      };
    })
    .filter(Boolean);
}

function parseJsonLdArticles(html, baseUrl) {
  const results = [];
  const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const parsed = parseJsonSafe(match[1]);
    if (!parsed) continue;

    for (const node of flattenJsonLd(parsed)) {
      const article = jsonLdNodeToItem(node, baseUrl);
      if (article) results.push(article);
    }
  }

  return results;
}

function flattenJsonLd(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(flattenJsonLd);

  if (node['@graph']) {
    return flattenJsonLd(node['@graph']);
  }

  if (node.itemListElement) {
    return [node, ...flattenJsonLd(node.itemListElement)];
  }

  if (node.item) {
    return [node, ...flattenJsonLd(node.item)];
  }

  return [node];
}

function jsonLdNodeToItem(node, baseUrl) {
  if (!node || typeof node !== 'object') return null;

  if (node['@type'] === 'ListItem' && node.item) {
    return jsonLdNodeToItem(node.item, baseUrl);
  }

  const rawTypes = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  const types = rawTypes.filter(Boolean).map(value => String(value));
  const isArticle =
    types.some(type => /Article|NewsArticle|BlogPosting/i.test(type)) ||
    (!!node.url && (!!node.headline || !!node.name));

  if (!isArticle) return null;

  const url = normalizeUrl(node.url || node.mainEntityOfPage, baseUrl);
  const title = cleanText(node.headline || node.name);
  if (!url || !title) return null;

  const summary = cleanText(node.description || node.abstract || truncateText(node.articleBody, 240));
  const publishedAt = toIsoDate(node.datePublished || node.dateModified);

  return {
    url,
    title,
    summary,
    publishedAt,
    discoveryMethod: 'json-ld'
  };
}

function parseAnchorArticles(html, baseUrl) {
  const results = [];
  const anchorRegex = /<a\b([^>]*?)href=(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const attrPrefix = match[1] || '';
    const href = match[3];
    const attrSuffix = match[4] || '';
    const innerHtml = match[5] || '';
    const attrs = `${attrPrefix} ${attrSuffix}`;

    const url = normalizeUrl(href, baseUrl);
    if (!url) continue;

    const attrTitle = getAttributeValue(attrs, 'title') || getAttributeValue(attrs, 'aria-label');
    const rawText = cleanText(attrTitle || innerHtml);
    const title = cleanupAnchorTitle(rawText);
    if (!title || title.length < 8) continue;

    results.push({
      url,
      title,
      summary: '',
      publishedAt: toIsoDate(extractDateToken(rawText)),
      discoveryMethod: 'anchor'
    });
  }

  return results;
}

function normalizeItem(item, source) {
  if (!item || !item.url || !item.title) return null;

  const normalizedUrl = normalizeUrl(item.url, source.homepageUrl);
  if (!normalizedUrl) return null;

  const title = cleanupTitle(item.title);
  if (!title) return null;

  const summary = cleanupSummary(item.summary);
  const publishedAt = toIsoDate(item.publishedAt);
  const id = createHash('sha1').update(normalizedUrl).digest('hex');

  return {
    id,
    company: source.company,
    sourceId: source.id,
    sourceLabel: source.label,
    homepageUrl: source.homepageUrl,
    url: normalizedUrl,
    title,
    summary,
    publishedAt,
    discoveryMethod: item.discoveryMethod || 'unknown'
  };
}

function isAllowedBySource(item, source) {
  if (item.url === normalizeUrl(source.homepageUrl, source.homepageUrl)) return false;

  const url = new URL(item.url);
  const homepage = new URL(source.homepageUrl);
  if (source.allowedHostnames && source.allowedHostnames.length > 0) {
    if (!source.allowedHostnames.includes(url.hostname)) return false;
  } else if (url.hostname !== homepage.hostname) {
    return false;
  }

  if (source.articlePathPrefixes && source.articlePathPrefixes.length > 0) {
    const matchesPrefix = source.articlePathPrefixes.some(prefix => url.pathname.startsWith(prefix));
    if (!matchesPrefix) return false;
  }

  if (source.excludePathPrefixes && source.excludePathPrefixes.some(prefix => url.pathname.startsWith(prefix))) {
    return false;
  }

  const haystack = `${item.title}\n${item.summary}`.toLowerCase();
  if (source.requiredKeywords && source.requiredKeywords.length > 0) {
    const matchedKeyword = source.requiredKeywords.some(keyword => textContainsKeyword(haystack, keyword));
    if (!matchedKeyword) return false;
  }

  if (source.excludeKeywords && source.excludeKeywords.length > 0) {
    const hasExcludedKeyword = source.excludeKeywords.some(keyword => textContainsKeyword(haystack, keyword));
    if (hasExcludedKeyword) return false;
  }

  return true;
}

function isWithinLookback(item, lookbackMs, now) {
  if (!item.publishedAt) return true;
  const publishedTs = Date.parse(item.publishedAt);
  if (Number.isNaN(publishedTs)) return true;
  return now - publishedTs <= lookbackMs;
}

function classifyItem(item, now) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  let score = 1;
  let reason = 'Routine official update';

  for (const classifier of CLASSIFIERS) {
    if (classifier.pattern.test(haystack)) {
      if (classifier.score > score) {
        score = classifier.score;
        reason = classifier.reason;
      }
    }
  }

  if (item.publishedAt) {
    const ageMs = now - Date.parse(item.publishedAt);
    if (!Number.isNaN(ageMs) && ageMs <= 48 * 60 * 60 * 1000) {
      score += 1;
    }
  }

  let bucket = 'digest';
  if (score >= 5) bucket = 'critical';
  else if (score >= 3) bucket = 'important';

  return { bucket, score, reason };
}

function compareItems(left, right) {
  const scoreDelta = (right.classification?.score || 0) - (left.classification?.score || 0);
  if (scoreDelta !== 0) return scoreDelta;

  const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
  const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
  if (rightTime !== leftTime) return rightTime - leftTime;

  return left.company.localeCompare(right.company) || left.title.localeCompare(right.title);
}

function dedupeItems(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (!item || !item.url) continue;
    const existing = byUrl.get(item.url);
    if (!existing || scoreCandidate(item) > scoreCandidate(existing)) {
      byUrl.set(item.url, item);
    }
  }
  return [...byUrl.values()];
}

function scoreCandidate(item) {
  let score = 0;
  if (item.publishedAt) score += 2;
  if (item.summary) score += Math.min(item.summary.length, 200) / 200;
  if (item.title) score += Math.min(item.title.length, 120) / 120;
  if (item.discoveryMethod === 'feed') score += 1;
  if (item.discoveryMethod === 'json-ld') score += 0.5;
  return score;
}

function renderDigest(summary) {
  const timestamp = formatDateTime(summary.generatedAt);
  const lines = [
    '# AI Company Watch',
    '',
    `Generated: ${timestamp}`,
    `Lookback window: ${summary.lookbackDays} day(s)`,
    `Sources checked: ${summary.sourcesChecked.length}`,
    `Items fetched: ${summary.totals.fetched}`,
    `Items kept: ${summary.totals.deduped}`,
    `New items: ${summary.totals.new}`,
    ''
  ];

  const buckets = [
    ['critical', 'Critical'],
    ['important', 'Important'],
    ['digest', 'Digest']
  ];

  if (summary.newItems.length === 0) {
    lines.push('## No New Items', '', 'No unseen items were found in the current lookback window.', '');
  } else {
    for (const [bucketId, bucketLabel] of buckets) {
      const bucketItems = summary.newItems.filter(item => item.classification.bucket === bucketId);
      if (bucketItems.length === 0) continue;

      lines.push(`## ${bucketLabel}`, '');
      for (const item of bucketItems) {
        lines.push(`### ${item.company} - ${item.title}`);
        lines.push(`Source: ${item.sourceLabel}`);
        lines.push(`Published: ${formatDate(item.publishedAt)}`);
        lines.push(`Why it matters: ${item.classification.reason}`);
        if (item.summary) lines.push(`Summary: ${item.summary}`);
        lines.push(`Link: ${item.url}`);
        lines.push('');
      }
    }
  }

  if (summary.errors.length > 0) {
    lines.push('## Warnings', '');
    for (const error of summary.errors) {
      lines.push(`- ${error}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function readXmlTag(block, tagNames) {
  for (const tagName of tagNames) {
    const escaped = tagName.replace(':', '\\:');
    const cdataRegex = new RegExp(`<${escaped}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${escaped}>`, 'i');
    const cdataMatch = block.match(cdataRegex);
    if (cdataMatch) return cdataMatch[1].trim();

    const tagRegex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const tagMatch = block.match(tagRegex);
    if (tagMatch) return tagMatch[1].trim();
  }
  return '';
}

function readXmlLink(block) {
  const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (hrefMatch) return hrefMatch[1];

  const textMatch = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (textMatch) return textMatch[1].trim();

  return '';
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

function getAttributeValue(attrs, name) {
  const regex = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attrs.match(regex);
  return match ? match[2] || match[3] || match[4] || '' : '';
}

function normalizeUrl(url, baseUrl) {
  try {
    const resolved = new URL(url, baseUrl);
    resolved.hash = '';

    for (const key of [...resolved.searchParams.keys()]) {
      if (REMOVABLE_QUERY_PARAMS.has(key.toLowerCase())) {
        resolved.searchParams.delete(key);
      }
    }

    if (resolved.pathname !== '/' && resolved.pathname.endsWith('/')) {
      resolved.pathname = resolved.pathname.replace(/\/+$/, '');
    }

    return resolved.toString();
  } catch {
    return '';
  }
}

function cleanupTitle(text) {
  const cleaned = collapseWhitespace(
    decodeEntities(String(text || ''))
      .replace(/^(Announcements|Announcement|Product|Products|Research|Engineering|Company|Policy|Policies|News)\s+/i, '')
      .replace(/\s*\|\s*[^|]+$/g, '')
      .replace(/\s*-\s*(OpenAI|Anthropic|Google|Google DeepMind|Meta|Microsoft)\s*$/i, '')
  ).trim();

  if (!cleaned) return '';
  if (/^(read more|learn more|watch now|listen now)$/i.test(cleaned)) return '';
  return cleaned;
}

function cleanupAnchorTitle(text) {
  let cleaned = cleanText(text);
  if (!cleaned) return '';

  const dateToken = extractDateToken(cleaned);
  if (dateToken) cleaned = cleaned.replace(dateToken, ' ');

  cleaned = cleaned
    .replace(/\b(Read more|Learn more|Watch now|Listen now|Explore more|See more)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleanupTitle(cleaned);
}

function cleanupSummary(text) {
  const cleaned = truncateText(
    cleanText(text)
      .replace(/^The post\s+/i, '')
      .replace(/\s+The post\s+[^.]+$/i, '')
      .replace(/\s+appeared first on\s+[^.]+\.\s*$/i, ''),
    280
  );
  if (!cleaned) return '';
  if (cleaned.toLowerCase() === 'read more') return '';
  return cleaned;
}

function cleanText(text) {
  return collapseWhitespace(stripTags(decodeEntities(String(text || '')))).trim();
}

function stripTags(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ');
}

function truncateText(text, limit) {
  const clean = collapseWhitespace(text).trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trim()}...`;
}

function textContainsKeyword(text, keyword) {
  const escaped = escapeRegex(keyword).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDateToken(text) {
  if (!text) return '';

  const patterns = [
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  return '';
}

function toIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value).trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatDate(isoString) {
  if (!isoString) return 'Unknown';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: DIGEST_TIME_ZONE,
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

function formatDateTime(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DIGEST_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(isoString));
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
