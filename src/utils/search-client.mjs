import {normalizeSearchText} from './search-results.mjs';

export function expandSearchQuery(query, synonymGroups = []) {
  const variants = new Set([query]);
  const normalizedQuery = normalizeSearchText(query);

  synonymGroups.forEach(({terms = []}) => {
    const normalizedTerms = terms.map(normalizeSearchText);
    if (normalizedTerms.some((term) => term && normalizedQuery.includes(term))) {
      terms.forEach((term) => variants.add(term));
    }
  });

  return Array.from(variants);
}

export function createTypesenseSearch(
  collection,
  query,
  options = {},
) {
  return {
    collection,
    q: query,
    query_by: 'title,document_title,keywords,tags,search_tokens,content',
    query_by_weights: '16,14,7,5,6,2',
    synonym_sets: `${collection}-synonyms`,
    highlight_fields:
      options.highlightFields ?? 'title,document_title,section,keywords,content',
    prioritize_exact_match: true,
    prioritize_token_position: true,
    demote_synonym_match: true,
    text_match_type: options.textMatchType ?? 'max_score',
    prefix: 'true,true,true,true,false,true',
    num_typos: 1,
    page: options.page ?? 1,
    per_page: options.perPage ?? 5,
    ...(options.dropTokensThreshold
      ? {drop_tokens_threshold: options.dropTokensThreshold}
      : {}),
    ...(options.excludeFields ? {exclude_fields: options.excludeFields} : {}),
    ...(options.includeFields ? {include_fields: options.includeFields} : {}),
    ...(options.filterBy ? {filter_by: options.filterBy} : {}),
    ...(options.groupByDocument
      ? {
          group_by: 'doc_id',
          group_limit: options.groupLimit ?? 5,
        }
      : {}),
    sort_by: '_text_match:desc,business_priority:desc,updated_at_ts:desc',
  };
}

export function getGroupedSearchHits(searchResult = {}) {
  const groupedHits = Array.isArray(searchResult.grouped_hits)
    ? searchResult.grouped_hits
    : [];
  if (groupedHits.length > 0) {
    return groupedHits.map((group) => group.hits ?? []);
  }
  return Array.isArray(searchResult.hits)
    ? searchResult.hits.map((hit) => [hit])
    : [];
}
