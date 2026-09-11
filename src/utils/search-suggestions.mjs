import {getGroupedSearchHits} from './search-client.mjs';
import {
  rankSearchDocuments,
  rankSearchResults,
  selectGroupedSearchResult,
} from './search-results.mjs';

export const SEARCH_SUGGESTION_LIMIT = 5;
export const SEARCH_SUGGESTION_CANDIDATE_LIMIT = 20;
export const SEARCH_SUGGESTION_GROUP_LIMIT = 5;
export const SEARCH_SUGGESTION_MIN_LENGTH = 2;

const suggestionFields = [
  'id',
  'doc_id',
  'record_type',
  'title',
  'document_title',
  'section',
  'breadcrumb',
  'keywords',
  'url',
  'business_priority',
  'updated_at_ts',
];

export function hasMinimumSuggestionQuery(query) {
  return Array.from(String(query ?? '').trim()).length >= SEARCH_SUGGESTION_MIN_LENGTH;
}

export function createSearchSuggestionRecords(records) {
  const seenDocumentIds = new Set();
  return (records ?? [])
    .filter((record) => record?.record_type === 'document')
    .filter((record) => {
      const key = record.doc_id ?? record.id ?? record.url;
      if (!key || seenDocumentIds.has(key)) return false;
      seenDocumentIds.add(key);
      return true;
    })
    .map((record) =>
      Object.fromEntries(
        suggestionFields
          .filter((field) => Object.hasOwn(record, field))
          .map((field) => [field, record[field]]),
      ),
    );
}

function asSuggestion(document) {
  if (!document) return null;
  const title =
    document.record_type === 'section'
      ? document.section ?? document.title
      : document.title ?? document.document_title;
  const url = document.url;
  if (!title || !url) return null;

  const breadcrumbItems = String(document.breadcrumb ?? '帮助文档')
    .split(/\s+\/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (breadcrumbItems.at(-1) === title) breadcrumbItems.pop();

  return {
    id: document.id ?? `${document.doc_id ?? url}:${url}`,
    docId: document.doc_id ?? document.id ?? url,
    title,
    breadcrumb: breadcrumbItems.join(' / ') || '帮助文档',
    url,
    recordType: document.record_type === 'section' ? 'section' : 'document',
  };
}

export function mapTypesenseSuggestions(
  searchResult,
  variants = [],
  limit = SEARCH_SUGGESTION_LIMIT,
) {
  const seenDocumentIds = new Set();
  const items = [];
  const groupedResults = getGroupedSearchHits(searchResult)
    .map((hits) => {
      const documents = hits.map((hit) => hit?.document).filter(Boolean);
      if (documents.length === 0) return null;
      const {displayDocument} = selectGroupedSearchResult(documents, variants);
      return {
        document: displayDocument ?? documents[0],
        matchingDocuments: documents,
      };
    })
    .filter(Boolean);
  const rankedResults = variants.length > 0
    ? rankSearchResults(groupedResults, variants)
    : groupedResults;

  for (const result of rankedResults) {
    const suggestion = asSuggestion(result.document);
    if (!suggestion || seenDocumentIds.has(suggestion.docId)) continue;
    seenDocumentIds.add(suggestion.docId);
    items.push(suggestion);
    if (items.length >= limit) break;
  }

  const found = Number.isFinite(searchResult?.found)
    ? Math.max(items.length, Number(searchResult.found))
    : items.length;
  return {items, found};
}

export function searchLocalSuggestions(
  records,
  variants,
  limit = SEARCH_SUGGESTION_LIMIT,
) {
  const ranked = rankSearchDocuments(records, variants);
  return {
    items: ranked.slice(0, limit).map(asSuggestion).filter(Boolean),
    found: ranked.length,
  };
}
