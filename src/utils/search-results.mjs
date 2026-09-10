function asText(value) {
  return String(value ?? '');
}

export function normalizeSearchText(value) {
  return asText(value).toLowerCase().replace(/[\s\u3000]+/g, '').trim();
}

export function normalizeSearchTextWithMap(value) {
  let text = '';
  const offsets = [];
  const endOffsets = [];
  let offset = 0;

  for (const character of asText(value).toLowerCase()) {
    const startOffset = offset;
    offset += character.length;
    if (/^[\s\u3000]$/u.test(character)) continue;

    for (const normalizedCharacter of Array.from(character)) {
      text += normalizedCharacter;
      offsets.push(startOffset);
      endOffsets.push(offset);
    }
  }

  return {text, offsets, endOffsets};
}

export function findSearchMatches(value, variants) {
  const normalizedValue = normalizeSearchTextWithMap(value);
  const normalizedVariants = Array.from(
    new Set((variants ?? []).map(normalizeSearchText).filter(Boolean)),
  ).sort((left, right) => right.length - left.length);
  const matches = [];

  normalizedVariants.forEach((variant) => {
    let searchFrom = 0;
    while (searchFrom < normalizedValue.text.length) {
      const matchIndex = normalizedValue.text.indexOf(variant, searchFrom);
      if (matchIndex === -1) break;

      const matchEndIndex = matchIndex + variant.length - 1;
      const start = normalizedValue.offsets[matchIndex];
      const end = normalizedValue.endOffsets[matchEndIndex];
      if (start !== undefined && end !== undefined) {
        matches.push({start, end});
      }
      searchFrom = matchIndex + variant.length;
    }
  });

  return matches
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce((merged, match) => {
      const previous = merged[merged.length - 1];
      if (previous && match.start < previous.end) {
        previous.end = Math.max(previous.end, match.end);
      } else {
        merged.push({...match});
      }
      return merged;
    }, []);
}

function extractSearchTokens(value) {
  return asText(value).toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/giu) ?? [];
}

export function getSearchHighlightTerms(variants) {
  const primary = new Set();
  const fragments = new Set();

  (variants ?? []).forEach((variant) => {
    extractSearchTokens(variant).forEach((token) => {
      primary.add(token);
      const characters = Array.from(token);
      if (/^\p{Script=Han}+$/u.test(token) && characters.length >= 3) {
        for (let index = 0; index < characters.length - 1; index += 1) {
          fragments.add(characters.slice(index, index + 2).join(''));
        }
      }
    });
  });

  return Array.from(new Set([...(variants ?? []), ...primary, ...fragments]))
    .map(normalizeSearchText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function findRelevantMatches(value, variants) {
  const exactMatches = findSearchMatches(value, variants);
  return exactMatches.length > 0
    ? exactMatches
    : findSearchMatches(value, getSearchHighlightTerms(variants));
}

function buildSnippetWindows(content, matches, maxWindows) {
  const windows = [];

  matches.forEach((match) => {
    const start = Math.max(0, match.start - 56);
    const end = Math.min(content.length, match.end + 108);
    const previous = windows[windows.length - 1];

    if (previous && start <= previous.end + 20) {
      previous.end = Math.max(previous.end, end);
      return;
    }
    windows.push({start, end});
  });

  return windows.slice(0, maxWindows);
}

function formatSnippetWindow(content, window) {
  const text = content.slice(window.start, window.end).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `${window.start > 0 ? '...' : ''}${text}${window.end < content.length ? '...' : ''}`;
}

export function createMultiSearchSnippet(documents, variants, maxSnippets = 3) {
  const snippets = [];
  const seen = new Set();

  for (const document of documents ?? []) {
    const content = asText(document?.content).trim();
    if (!content) continue;

    const matches = findRelevantMatches(content, variants);
    const windows = buildSnippetWindows(content, matches, maxSnippets - snippets.length);
    for (const window of windows) {
      const snippet = formatSnippetWindow(content, window);
      if (!snippet || seen.has(snippet)) continue;
      seen.add(snippet);
      snippets.push(snippet);
      if (snippets.length >= maxSnippets) break;
    }
    if (snippets.length >= maxSnippets) break;
  }

  if (snippets.length === 0) return {text: '', matches: []};

  const text = snippets.join(' ... ');
  return {text, matches: findSearchMatches(text, getSearchHighlightTerms(variants))};
}

function getRecordHeading(document) {
  return document?.record_type === 'section'
    ? asText(document.section || document.title)
    : asText(document?.document_title || document?.title);
}

function scoreSearchDocument(document, variants, index) {
  const heading = getRecordHeading(document);
  const content = asText(document?.content);
  const headingMatches = findRelevantMatches(heading, variants).length;
  const contentMatches = findRelevantMatches(content, variants).length;
  const normalizedHeading = normalizeSearchText(heading);
  const exactHeadingMatch = (variants ?? []).some(
    (variant) => normalizeSearchText(variant) === normalizedHeading,
  );
  const headingWeight = document?.record_type === 'section' ? 400 : 300;
  const contentWeight = document?.record_type === 'section' ? 8 : 1;
  return (
    (exactHeadingMatch ? 1000 : 0) +
    headingMatches * headingWeight +
    Math.min(contentMatches, 20) * contentWeight -
    index / 1000
  );
}

export function hasMatchingSection(documents, variants) {
  return (documents ?? []).some((document) =>
    document?.record_type === 'section' &&
    findRelevantMatches(
      `${asText(document.section || document.title)}\n${asText(document.content)}`,
      variants,
    ).length > 0,
  );
}

export function mergeSearchDocuments(preferredDocuments, fallbackDocuments) {
  const documents = [];
  const seen = new Set();

  for (const document of [...(preferredDocuments ?? []), ...(fallbackDocuments ?? [])]) {
    if (!document) continue;
    const key =
      document.id ??
      document.url ??
      `${document.doc_id ?? ''}:${document.record_type ?? ''}:${document.title ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(document);
  }

  return documents;
}

export function selectGroupedSearchResult(documents, variants) {
  const entries = (documents ?? []).filter(Boolean);
  const matchingSections = entries.filter((document) =>
    document.record_type === 'section' &&
    findRelevantMatches(
      `${asText(document.section || document.title)}\n${asText(document.content)}`,
      variants,
    ).length > 0,
  );
  const matchingDocuments = entries.filter((document) =>
    document.record_type !== 'section' &&
    findRelevantMatches(
      `${getRecordHeading(document)}\n${asText(document.content)}`,
      variants,
    ).length > 0,
  );
  const directMatches = [...matchingSections, ...matchingDocuments];
  const candidates = directMatches.length > 0 ? directMatches : entries;
  const displayDocument = candidates.reduce((best, document, index) => {
    if (!best) return document;
    const bestIndex = candidates.indexOf(best);
    return scoreSearchDocument(document, variants, index) >
      scoreSearchDocument(best, variants, bestIndex)
      ? document
      : best;
  }, undefined);
  const snippetDocuments = displayDocument
    ? [
        displayDocument,
        ...matchingSections.filter((document) => document !== displayDocument),
      ]
    : [];

  return {displayDocument, snippetDocuments};
}

export function addSearchHighlightToUrl(url, query) {
  const value = asText(url).trim();
  const highlight = asText(query).trim();
  if (!value || !highlight) return value;

  const hashIndex = value.indexOf('#');
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : value.slice(hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1));
  params.set('search', highlight);
  return `${pathname}?${params.toString()}${hash}`;
}
