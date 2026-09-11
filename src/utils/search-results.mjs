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

const CHINESE_QUESTION_FILLERS = [
  '我想知道',
  '我想了解',
  '在哪里',
  '怎么办',
  '为什么',
  '是什么',
  '什么是',
  '请问',
  '怎么',
  '如何',
  '怎样',
  '为何',
  '是否',
  '能否',
  '可否',
  '可以',
  '能够',
  '哪里',
  '在哪',
];
const CHINESE_QUESTION_FILLER_PATTERN = new RegExp(
  CHINESE_QUESTION_FILLERS.join('|'),
  'gu',
);

function splitChineseSearchToken(value) {
  return value
    .replace(CHINESE_QUESTION_FILLER_PATTERN, ' ')
    .replace(/[吗呢呀吧么？?]+$/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

export function getSearchQueryTerms(value) {
  return (asText(value).toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/giu) ?? [])
    .flatMap((token) =>
      /^\p{Script=Han}+$/u.test(token) ? splitChineseSearchToken(token) : token,
    )
    .filter(Boolean);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceSearchTermWithCanonical(term, synonymGroups) {
  let result = term;

  for (const group of synonymGroups ?? []) {
    const terms = Array.isArray(group?.terms) ? group.terms.filter(Boolean).map(String) : [];
    const canonical = terms[0];
    if (!canonical) continue;

    const matchedAlias = [...terms]
      .sort((left, right) => right.length - left.length)
      .find((alias) => normalizeSearchText(result).includes(normalizeSearchText(alias)));
    if (!matchedAlias) continue;

    result = result.replace(
      new RegExp(escapeRegularExpression(matchedAlias), 'giu'),
      canonical,
    );
  }

  return result;
}

export function buildSearchQuery(value, synonymGroups = []) {
  const terms = getSearchQueryTerms(value).map((term) =>
    replaceSearchTermWithCanonical(term, synonymGroups),
  );
  return terms.length > 0 ? terms.join(' ') : asText(value).trim();
}

function extractSearchTokens(value) {
  return getSearchQueryTerms(value);
}

const SNIPPET_CONTEXT_BEFORE = 40;
const SNIPPET_CONTEXT_AFTER = 80;
const MAX_SNIPPET_WINDOW_LENGTH = 180;

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

function buildSnippetWindows(content, matches) {
  const windows = [];

  matches.forEach((match) => {
    const start = Math.max(0, match.start - SNIPPET_CONTEXT_BEFORE);
    const end = Math.min(
      content.length,
      Math.min(match.end + SNIPPET_CONTEXT_AFTER, start + MAX_SNIPPET_WINDOW_LENGTH),
    );
    const previous = windows[windows.length - 1];

    if (
      previous &&
      start <= previous.end + 20 &&
      Math.max(previous.end, end) - previous.start <= MAX_SNIPPET_WINDOW_LENGTH
    ) {
      previous.end = Math.max(previous.end, end);
      return;
    }
    windows.push({start, end});
  });

  return windows;
}

function getSnippetCoverageTerms(variants) {
  return Array.from(
    new Set(
      (variants ?? [])
        .flatMap((variant) => extractSearchTokens(variant))
        .map(normalizeSearchText)
        .filter(Boolean),
    ),
  );
}

function countTermOccurrences(value, term) {
  const normalizedValue = normalizeSearchText(value);
  if (!normalizedValue || !term) return 0;

  let count = 0;
  let offset = 0;
  while (offset < normalizedValue.length) {
    const matchIndex = normalizedValue.indexOf(term, offset);
    if (matchIndex === -1) break;
    count += 1;
    offset = matchIndex + term.length;
  }
  return count;
}

function selectSnippetWindows(candidates, variants, maxWindows) {
  if (candidates.length <= maxWindows) return candidates;

  const terms = getSnippetCoverageTerms(variants);
  const termWeights = new Map(
    terms.map((term) => {
      const occurrences = candidates.reduce(
        (total, candidate) => total + countTermOccurrences(candidate.content, term),
        0,
      );
      return [term, 1 / Math.max(1, occurrences)];
    }),
  );
  const scoredCandidates = candidates.map((candidate) => {
    const value = candidate.content.slice(candidate.start, candidate.end);
    const coverage = terms.filter((term) => normalizeSearchText(value).includes(term));
    const weight = coverage.reduce((total, term) => total + (termWeights.get(term) ?? 0), 0);
    return {...candidate, coverage, weight};
  });
  const selected = [];
  const covered = new Set();

  while (selected.length < maxWindows && scoredCandidates.length > selected.length) {
    const best = scoredCandidates
      .filter((candidate) => !selected.includes(candidate))
      .map((candidate) => {
        const newCoverage = candidate.coverage.filter((term) => !covered.has(term));
        const newWeight = newCoverage.reduce(
          (total, term) => total + (termWeights.get(term) ?? 0),
          0,
        );
        return {candidate, newCoverage, newWeight};
      })
      .sort(
        (left, right) =>
          right.newWeight - left.newWeight ||
          right.candidate.weight - left.candidate.weight ||
          right.newCoverage.length - left.newCoverage.length ||
          left.candidate.order - right.candidate.order,
      )[0];
    if (!best) break;
    selected.push(best.candidate);
    best.candidate.coverage.forEach((term) => covered.add(term));
  }

  return selected.sort(
    (left, right) => left.documentIndex - right.documentIndex || left.start - right.start,
  );
}

function formatSnippetWindow(content, window) {
  const text = content.slice(window.start, window.end).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `${window.start > 0 ? '...' : ''}${text}${window.end < content.length ? '...' : ''}`;
}

export function createMultiSearchSnippet(documents, variants, maxSnippets = 2) {
  const candidates = [];
  const seen = new Set();

  (documents ?? []).forEach((document, documentIndex) => {
    const content = asText(document?.content).trim();
    if (!content) return;

    const matches = findRelevantMatches(content, variants);
    const windows = buildSnippetWindows(content, matches);
    for (const window of windows) {
      const snippet = formatSnippetWindow(content, window);
      if (!snippet || seen.has(snippet)) continue;
      seen.add(snippet);
      candidates.push({
        content,
        documentIndex,
        order: candidates.length,
        ...window,
      });
    }
  });

  const selectedWindows = selectSnippetWindows(candidates, variants, maxSnippets);
  const snippets = selectedWindows
    .map(({content, ...window}) => formatSnippetWindow(content, window))
    .filter(Boolean);

  if (snippets.length === 0) return {text: '', matches: []};

  const text = snippets.join(' ... ');
  return {text, matches: findSearchMatches(text, getSearchHighlightTerms(variants))};
}

export function getRecordHeading(document) {
  return document?.record_type === 'section'
    ? asText(document.section || document.title)
    : asText(document?.document_title || document?.title);
}

export function getSearchBusinessPriority(document) {
  if (typeof document?.business_priority === 'number') return document.business_priority;

  const url = asText(document?.url).toLowerCase();
  const section = asText(document?.section).toLowerCase();
  if (url.includes('/product-guides/') || section === '产品指南' || section === '帮助文档') {
    return 30;
  }
  if (url.includes('/faq/') || section.includes('faq') || section.includes('常见问题')) {
    return 20;
  }
  if (
    url.includes('/release-notes/') ||
    section.includes('更新日志') ||
    section.includes('更新动态')
  ) {
    return 10;
  }
  return 0;
}

function buildScoringTerms(variants) {
  const primary = new Set();
  const fragments = new Set();
  for (const variant of variants) {
    for (const token of extractSearchTokens(variant)) {
      primary.add(token);
      const characters = Array.from(token);
      if (/^\p{Script=Han}+$/u.test(token) && characters.length >= 3) {
        for (let index = 0; index < characters.length - 1; index += 1) {
          fragments.add(characters.slice(index, index + 2).join(''));
        }
      }
    }
  }
  return {primary: Array.from(primary), fragments: Array.from(fragments)};
}

function getShortestTermSpan(value, terms) {
  const normalizedValue = normalizeSearchText(value);
  const occurrences = [];
  const maxOccurrencesPerTerm = 64;

  terms.forEach((term) => {
    let offset = 0;
    let occurrenceCount = 0;
    while (offset < normalizedValue.length && occurrenceCount < maxOccurrencesPerTerm) {
      const start = normalizedValue.indexOf(term, offset);
      if (start === -1) break;
      occurrences.push({start, end: start + term.length, term});
      occurrenceCount += 1;
      offset = start + term.length;
    }
  });

  if (occurrences.length === 0) return Infinity;
  occurrences.sort((left, right) => left.start - right.start || left.end - right.end);
  const termCounts = new Map();
  let coveredTerms = 0;
  let left = 0;
  let shortest = Infinity;

  for (let right = 0; right < occurrences.length; right += 1) {
    const rightOccurrence = occurrences[right];
    const nextCount = (termCounts.get(rightOccurrence.term) ?? 0) + 1;
    termCounts.set(rightOccurrence.term, nextCount);
    if (nextCount === 1) coveredTerms += 1;

    while (coveredTerms === terms.length && left <= right) {
      const leftOccurrence = occurrences[left];
      shortest = Math.min(shortest, rightOccurrence.end - leftOccurrence.start);
      const remainingCount = (termCounts.get(leftOccurrence.term) ?? 1) - 1;
      if (remainingCount === 0) coveredTerms -= 1;
      termCounts.set(leftOccurrence.term, remainingCount);
      left += 1;
    }
  }

  return shortest;
}

function getScoringFields(document) {
  const titleWeight = document?.record_type === 'section' ? 170 : 200;
  const fields = [
    {name: 'title', weight: titleWeight, exact: 10000},
    {name: 'section', weight: 145, exact: 8200},
    {name: 'document_title', weight: 125, exact: 7200},
    {name: 'keywords', weight: 72, exact: 1800},
    {name: 'tags', weight: 52, exact: 1400},
    // Generated n-grams are a recall aid, not independent relevance evidence.
    // Keep their ranking contribution below editorial fields and body text.
    {name: 'search_tokens', weight: 18, exact: 300},
    {name: 'content', weight: 14, exact: 400},
  ];
  const seen = new Set();
  return fields.filter(({name}) => {
    const value = normalizeSearchText(
      Array.isArray(document?.[name]) ? document[name].join(' ') : document?.[name],
    );
    if (
      !value ||
      (name === 'section' &&
        document?.record_type !== 'section' &&
        value === normalizeSearchText('帮助文档')) ||
      (name === 'section' &&
        document?.record_type === 'section' &&
        value === normalizeSearchText(document?.title))
    ) {
      return false;
    }
    // Document records commonly copy title into document_title. Count that
    // signal only once so the parent page does not receive a duplicate boost.
    if (
      name === 'document_title' &&
      document?.record_type !== 'section' &&
      value === normalizeSearchText(document?.title)
    ) {
      return false;
    }
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/**
 * Scores one record for both local fallback search and Typesense result
 * re-ranking. The first variant is the user's direct query; later variants
 * are synonym expansions and intentionally receive a lower multiplier.
 */
export function scoreSearchDocument(document, variants, index = 0) {
  const sourceVariants = Array.from(
    new Set((variants ?? []).map((variant) => asText(variant).trim()).filter(Boolean)),
  );
  const normalizedVariants = Array.from(
    new Set(sourceVariants.map(normalizeSearchText).filter(Boolean)),
  );
  if (normalizedVariants.length === 0) return 0;

  const directVariant = normalizedVariants[0];
  const directTerms = Array.from(new Set(extractSearchTokens(sourceVariants[0])));
  const {primary: variantTerms, fragments} = buildScoringTerms(sourceVariants);
  const matchedDirectTerms = new Set();
  const matchedFragments = new Set();
  let matchedSynonymPhrase = false;
  let score = 0;

  getScoringFields(document).forEach(({name, weight, exact}) => {
    const value = normalizeSearchText(
      Array.isArray(document?.[name]) ? document[name].join(' ') : document?.[name],
    );
    if (!value) return;
    directTerms.forEach((term) => {
      if (value.includes(term)) matchedDirectTerms.add(term);
    });

    const directPhrase = value.includes(directVariant);
    const synonymPhrase = !directPhrase && normalizedVariants
      .slice(1)
      .find((variant) => value.includes(variant));
    if (directPhrase || synonymPhrase) {
      const phrase = directPhrase ? directVariant : synonymPhrase;
      if (synonymPhrase) matchedSynonymPhrase = true;
      const multiplier = directPhrase ? 1 : 0.58;
      score += weight * (directPhrase ? 1 : 0.7) * multiplier;
      if (value === phrase) score += exact * multiplier;
      else if (value.startsWith(phrase)) score += weight * 0.7 * multiplier;
      return;
    }

    const matchedTerms = variantTerms.filter((term) => value.includes(term));
    if (matchedTerms.length > 0) {
      const directMatchedCount = matchedTerms.filter((term) =>
        directTerms.includes(term),
      ).length;
      score += Math.min(weight * 1.25, matchedTerms.length * weight * 0.42);
      score += directMatchedCount * weight * 0.12;
      return;
    }

    const matchedFieldFragments = fragments.filter((fragment) => value.includes(fragment));
    matchedFieldFragments.forEach((fragment) => matchedFragments.add(fragment));
    score += Math.min(weight * 0.8, matchedFieldFragments.length * weight * 0.18);
  });

  if (directTerms.length > 0 && matchedDirectTerms.size > 0) {
    score += 36 * (matchedDirectTerms.size / directTerms.length);
  } else if (matchedFragments.size > 0) {
    score += Math.min(12, matchedFragments.size * 2);
  }

  if (directTerms.length > 1 && matchedDirectTerms.size > 1) {
    const span = getShortestTermSpan(document?.content, directTerms);
    if (Number.isFinite(span)) {
      const coverage = matchedDirectTerms.size / directTerms.length;
      score += Math.min(36, 240 / Math.sqrt(Math.max(1, span))) * coverage;
    }
  }

  const minimumFragmentMatches = fragments.length
    ? Math.min(fragments.length, Math.max(2, Math.ceil(fragments.length * 0.5)))
    : 0;
  if (
    directTerms.length > 0 &&
    matchedDirectTerms.size === 0 &&
    !matchedSynonymPhrase &&
    matchedFragments.size < minimumFragmentMatches
  ) {
    return 0;
  }

  if (score === 0) return 0;
  return score - index / 100000;
}

export function rankSearchDocuments(documents, variants) {
  return (documents ?? [])
    .map((document, index) => {
      const score = scoreSearchDocument(document, variants, index);
      return {
        document,
        index,
        score,
        rankingScore: score + getSearchBusinessPriority(document),
      };
    })
    .filter(({score}) => score > 0)
    .sort((left, right) =>
      right.rankingScore - left.rankingScore ||
      getSearchBusinessPriority(right.document) - getSearchBusinessPriority(left.document) ||
      getRecordHeading(left.document).localeCompare(getRecordHeading(right.document), 'zh-CN') ||
      asText(left.document?.url).localeCompare(asText(right.document?.url)),
    )
    .map(({document}) => document);
}

export function rankSearchResults(results, variants) {
  return (results ?? [])
    .map((result, index) => {
      const documents = [result?.document, ...(result?.matchingDocuments ?? [])].filter(Boolean);
      const score = documents.reduce(
        (best, document) => Math.max(best, scoreSearchDocument(document, variants)),
        0,
      );
      return {
        result,
        index,
        score,
        rankingScore: score + getSearchBusinessPriority(result?.document),
      };
    })
    .sort((left, right) =>
      right.rankingScore - left.rankingScore ||
      getSearchBusinessPriority(right.result?.document) -
        getSearchBusinessPriority(left.result?.document) ||
      left.index - right.index,
    )
    .map(({result}) => result);
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
