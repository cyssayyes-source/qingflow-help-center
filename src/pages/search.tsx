import type {FormEvent, ReactNode} from 'react';
import {useEffect, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  LoaderCircle,
  Search,
  Sparkles,
} from 'lucide-react';

import styles from './search.module.css';
import {
  addSearchHighlightToUrl,
  createMultiSearchSnippet,
  findSearchMatches,
  getSearchHighlightTerms,
  hasMatchingSection,
  mergeSearchDocuments,
  normalizeSearchText,
  selectGroupedSearchResult,
} from '../utils/search-results.mjs';

type SearchDocument = {
  doc_id?: string;
  record_type?: 'document' | 'section';
  title?: string;
  document_title?: string;
  section?: string;
  breadcrumb?: string;
  keywords?: string[];
  content?: string;
  url?: string;
  version?: string;
  language?: string;
  product?: string;
  business_priority?: number;
  tags?: string[];
  search_tokens?: string[];
};

type SearchMatch = {start: number; end: number};
type SearchSnippet = {text: string; matches: SearchMatch[]};
type ResultSnippet = SearchSnippet & {source: 'local' | 'typesense'};

type SearchHit = {
  document?: SearchDocument;
  matchingDocuments?: SearchDocument[];
  snippet?: string;
  snippetMatches?: SearchMatch[];
  highlights?: Array<{
    field?: string;
    snippet?: string;
  }>;
};

type SearchState = 'idle' | 'loading' | 'ready' | 'error';
type SynonymGroup = {terms: string[]};
type LocalSearchData = {documents: SearchDocument[]; synonymGroups: SynonymGroup[]};
type SearchPageResult = {hits: SearchHit[]; found: number; page: number; perPage: number};

const PAGE_SIZE = 8;
const GROUP_HIT_LIMIT = 5;

const localDocuments: SearchDocument[] = [
  {
    title: '新手指南',
    section: '快速开始',
    content: '认识轻流，了解核心概念并开始使用产品。',
    url: '/docs/getting-started',
    tags: ['入门', '帮助中心'],
  },
  {
    title: '如何收集和流转数据',
    section: '快速开始',
    content: '使用表单和流程收集、处理并流转业务数据。',
    url: '/docs/product-guides/qingflow-introduction/collect-and-route-data',
    tags: ['表单', '流程', '数据'],
  },
  {
    title: '轻流简介',
    section: '快速开始',
    content: '了解轻流的核心功能、应用场景和账号模式。',
    url: '/docs/product-guides/qingflow-introduction',
    tags: ['轻流', '入门'],
  },
  {
    title: '流程引擎',
    section: '流程与审批',
    content: '配置申请、审批、填写和抄送节点，管理业务流程。',
    url: '/docs/product-guides/workflow-engine',
    tags: ['审批', '流程', '待办'],
  },
  {
    title: '权限管理',
    section: '管理后台',
    content: '配置工作区权限、高级权限和管理员角色。',
    url: '/docs/product-guides/admin-console/permissions',
    tags: ['权限', '管理员'],
  },
  {
    title: '更新日志',
    section: '更新动态',
    content: '查看轻流各版本的产品功能更新记录。',
    url: '/docs/release-notes',
    tags: ['更新', '版本'],
  },
  {
    title: 'OPENAPI',
    section: '开放平台',
    content: '了解轻流开放接口、鉴权方式和系统集成能力。',
    url: '/docs/product-guides/qing-code/openapi',
    tags: ['API', '开发'],
  },
  {
    title: '常见问题',
    section: 'FAQ',
    content: '查找轻流产品使用过程中常见问题的处理方法。',
    url: '/docs/faq',
    tags: ['问题', 'FAQ'],
  },
];

function expandQuery(query: string, synonymGroups: SynonymGroup[]): string[] {
  const variants = new Set([query]);
  const normalizedQuery = normalizeSearchText(query);

  synonymGroups.forEach(({terms}) => {
    const normalizedTerms = terms.map(normalizeSearchText);
    if (normalizedTerms.some((term) => normalizedQuery.includes(term))) {
      terms.forEach((term) => variants.add(term));
    }
  });

  return Array.from(variants);
}

function getBusinessPriority(document: SearchDocument): number {
  if (typeof document.business_priority === 'number') {
    return document.business_priority;
  }

  const url = (document.url ?? '').toLowerCase();
  const section = (document.section ?? '').toLowerCase();

  if (url.includes('/product-guides/') || section === '产品指南' || section === '帮助文档') {
    return 30;
  }
  if (
    url.includes('/faq/') ||
    section.includes('faq') ||
    section.includes('常见问题')
  ) {
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

type SearchQueryTerms = {primary: string[]; fragments: string[]};

function buildSearchQueryTerms(variants: string[]): SearchQueryTerms {
  const primary = new Set<string>();
  const fragments = new Set<string>();

  variants.forEach((variant) => {
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

  return {primary: Array.from(primary), fragments: Array.from(fragments)};
}

function extractSearchTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/giu) ?? [];
}

function searchLocalDocuments(
  query: string,
  documents: SearchDocument[],
  synonymGroups: SynonymGroup[],
  page: number,
  perPage: number,
): SearchPageResult {
  const normalizedQuery = normalizeSearchText(query);
  const variants = expandQuery(query, synonymGroups).map(normalizeSearchText);
  const queryTerms = buildSearchQueryTerms([normalizedQuery]);
  const variantTerms = buildSearchQueryTerms(variants);
  const fields: Array<[keyof SearchDocument, number]> = [
    ['title', 100],
    ['section', 80],
    ['keywords', 70],
    ['tags', 50],
    ['search_tokens', 65],
    ['content', 10],
  ];
  const matchesByDocument = new Map<
    string,
    Array<{document: SearchDocument; score: number; businessPriority: number}>
  >();

  documents.forEach((document) => {
    let score = 0;
    const matchedPrimaryTerms = new Set<string>();
    const matchedFragments = new Set<string>();
    fields.forEach(([field, weight]) => {
      const values = Array.isArray(document[field])
        ? (document[field] as string[])
        : [String(document[field] ?? '')];
      const value = normalizeSearchText(values.join(' '));
      queryTerms.primary.forEach((term) => {
        if (value.includes(term)) matchedPrimaryTerms.add(term);
      });

      const exactVariant = variants.find((variant) => variant && value.includes(variant));
      if (exactVariant) {
        score += weight * (exactVariant === normalizedQuery ? 2 : 1.2);
        if (value.startsWith(exactVariant)) score += Math.round(weight * 0.2);
        return;
      }

      const matchedTerms = variantTerms.primary.filter((term) => value.includes(term));
      if (matchedTerms.length > 0) {
        score += Math.min(weight * 1.25, matchedTerms.length * weight * 0.42);
        return;
      }

      const matchedFieldFragments = variantTerms.fragments.filter((fragment) =>
        value.includes(fragment),
      );
      matchedFieldFragments.forEach((fragment) => matchedFragments.add(fragment));
      score += Math.min(weight * 0.8, matchedFieldFragments.length * weight * 0.18);
    });

    if (queryTerms.primary.length > 0 && matchedPrimaryTerms.size > 0) {
      score += 18 * (matchedPrimaryTerms.size / queryTerms.primary.length);
    } else if (matchedFragments.size > 0) {
      score += Math.min(12, matchedFragments.size * 2);
    }

    if (
      queryTerms.primary.length > 0 &&
      matchedPrimaryTerms.size === 0 &&
      matchedFragments.size < getMinimumFragmentMatches(variantTerms.fragments.length)
    ) {
      return;
    }
    if (score === 0) return;
    const key = document.doc_id ?? document.url ?? document.title ?? '';
    const businessPriority = getBusinessPriority(document);
    const matches = matchesByDocument.get(key) ?? [];
    matches.push({document, score, businessPriority});
    matchesByDocument.set(key, matches);
  });

  const ranked = Array.from(matchesByDocument.values())
    .map((matches) => {
      const sortedMatches = [...matches].sort(
        (left, right) =>
          right.score - left.score ||
          right.businessPriority - left.businessPriority ||
          (left.document.title ?? '').localeCompare(right.document.title ?? '', 'zh-CN') ||
          (left.document.url ?? '').localeCompare(right.document.url ?? ''),
      );
      const best = sortedMatches[0];
      return {
        documents: sortedMatches.slice(0, GROUP_HIT_LIMIT).map((match) => match.document),
        score: best.score,
        businessPriority: best.businessPriority,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.businessPriority - left.businessPriority ||
        (left.documents[0]?.title ?? '').localeCompare(right.documents[0]?.title ?? '', 'zh-CN') ||
        (left.documents[0]?.url ?? '').localeCompare(right.documents[0]?.url ?? ''),
    );
  const safePage = Math.max(1, Math.floor(page) || 1);
  const totalPages = getTotalPages(ranked.length, perPage);
  const resolvedPage = totalPages > 0 ? Math.min(safePage, totalPages) : 1;
  const start = (resolvedPage - 1) * perPage;

  return {
    found: ranked.length,
    page: resolvedPage,
    perPage,
    hits: ranked.slice(start, start + perPage).map(({documents: matchedDocuments}) => {
      const {displayDocument, snippetDocuments} = selectGroupedSearchResult(
        matchedDocuments,
        variants,
      );
      const snippet = createMultiSearchSnippet(
        snippetDocuments.length > 0 ? snippetDocuments : matchedDocuments,
        variants,
      );
      return {
        document: displayDocument ?? matchedDocuments[0],
        matchingDocuments: snippetDocuments,
        snippet: snippet.text,
        snippetMatches: snippet.matches,
      };
    }),
  };
}

function getTotalPages(found: number, perPage: number): number {
  return found > 0 ? Math.ceil(found / perPage) : 0;
}

function getMinimumFragmentMatches(fragmentCount: number): number {
  if (fragmentCount === 0) return 0;
  return Math.min(fragmentCount, Math.max(2, Math.ceil(fragmentCount * 0.5)));
}

function getResultSnippet(result: SearchHit, query: string): ResultSnippet {
  const contentHighlight = result.highlights?.find(
    (highlight) => highlight.field === 'content' && highlight.snippet,
  );
  const generatedSnippet = createMultiSearchSnippet(
    result.matchingDocuments?.length
      ? result.matchingDocuments
      : result.document
        ? [result.document]
        : [],
    [query],
  );

  if (generatedSnippet.text) {
    return {...generatedSnippet, source: 'local'};
  }
  if (result.snippet !== undefined) {
    return {
      text: result.snippet,
      matches: result.snippetMatches ?? [],
      source: result.snippetMatches !== undefined ? 'local' : 'typesense',
    };
  }
  if (contentHighlight?.snippet) {
    return {text: contentHighlight.snippet, matches: [], source: 'typesense'};
  }
  const fallbackHighlight = result.highlights?.find((highlight) => highlight.snippet)?.snippet;
  if (fallbackHighlight) {
    return {text: fallbackHighlight, matches: [], source: 'typesense'};
  }
  return {...generatedSnippet, source: 'local'};
}

function renderTypesenseSnippet(value: string): ReactNode {
  return value.split(/(<mark>[\s\S]*?<\/mark>)/gi).map((part, index) => {
    const match = part.match(/^<mark>([\s\S]*?)<\/mark>$/i);
    return match ? (
      <mark key={index} className={styles.resultHighlight}>
        {match[1]}
      </mark>
    ) : (
      part
    );
  });
}

function renderLocalSnippet(value: string, matches: SearchMatch[]): ReactNode {
  if (matches.length === 0) return value;

  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    const start = Math.max(cursor, Math.min(value.length, match.start));
    const end = Math.max(start, Math.min(value.length, match.end));
    if (start > cursor) parts.push(value.slice(cursor, start));
    if (end > start) {
      parts.push(
        <mark key={index} className={styles.resultHighlight}>
          {value.slice(start, end)}
        </mark>,
      );
    }
    cursor = end;
  });
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function renderSearchSnippet(snippet: ResultSnippet): ReactNode {
  return snippet.source === 'typesense'
    ? renderTypesenseSnippet(snippet.text)
    : renderLocalSnippet(snippet.text, snippet.matches);
}

function createGroupedSearchHit(hits: SearchHit[], query: string): SearchHit {
  const documents = hits
    .map((hit) => hit.document)
    .filter((document): document is SearchDocument => Boolean(document));
  const {displayDocument, snippetDocuments} = selectGroupedSearchResult(documents, [query]);
  const selectedHit = hits.find((hit) => hit.document === displayDocument) ?? hits[0];

  return {
    ...selectedHit,
    document: displayDocument ?? selectedHit?.document,
    matchingDocuments: snippetDocuments,
  };
}

function getDocumentsFromHits(hits: SearchHit[]): SearchDocument[] {
  return hits
    .map((hit) => hit.document)
    .filter((document): document is SearchDocument => Boolean(document));
}

function createTypesenseSearch(
  collection: string,
  query: string,
  options: {page?: number; perPage?: number; filterBy?: string; groupByDocument?: boolean} = {},
) {
  return {
    collection,
    q: query,
    query_by: 'title,section,keywords,tags,search_tokens,content',
    query_by_weights: '12,8,7,5,6,2',
    synonym_sets: `${collection}-synonyms`,
    highlight_fields: 'title,keywords,content',
    prioritize_exact_match: true,
    prioritize_token_position: true,
    text_match_type: 'max_score',
    prefix: 'true,true,true,true,false,true',
    num_typos: 1,
    page: options.page ?? 1,
    per_page: options.perPage ?? GROUP_HIT_LIMIT,
    ...(options.filterBy ? {filter_by: options.filterBy} : {}),
    ...(options.groupByDocument
      ? {
          group_by: 'doc_id',
          group_limit: GROUP_HIT_LIMIT,
        }
      : {}),
    sort_by: '_text_match:desc,business_priority:desc,updated_at_ts:desc',
  };
}

function createExactDocumentFilter(documentId: string): string {
  return `doc_id:=${JSON.stringify(documentId)} && record_type:=section`;
}

export default function SearchPage(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const searchPath = useBaseUrl('/search');
  const searchIndexPath = useBaseUrl('/search-records.json');
  const searchSynonymsPath = useBaseUrl('/search-synonyms.json');
  const localIndexPromise = useRef<Promise<LocalSearchData> | null>(null);
  const customFields = (siteConfig.customFields ?? {}) as {
    typesense?: {
      host?: string;
      searchApiKey?: string;
      collection?: string;
    };
  };
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [notice, setNotice] = useState('');

  const typesense = customFields.typesense ?? {};
  const canUseTypesense = Boolean(typesense.host && typesense.searchApiKey);

  function getLocalDocuments() {
    if (!localIndexPromise.current) {
      localIndexPromise.current = Promise.all([
        fetch(searchIndexPath),
        fetch(searchSynonymsPath),
      ])
        .then(async ([documentsResponse, synonymsResponse]) => {
          if (!documentsResponse.ok) {
            throw new Error(`Local search index responded with ${documentsResponse.status}`);
          }
          const documents: unknown = await documentsResponse.json();
          const synonyms: unknown = synonymsResponse.ok ? await synonymsResponse.json() : [];
          return {
            documents: Array.isArray(documents) ? (documents as SearchDocument[]) : localDocuments,
            synonymGroups: Array.isArray(synonyms) ? (synonyms as SynonymGroup[]) : [],
          };
        })
        .catch(() => ({documents: localDocuments, synonymGroups: []}));
    }

    return localIndexPromise.current;
  }

  async function runSearch(nextQuery: string, requestedPage = 1) {
    const trimmedQuery = nextQuery.trim();
    const nextPage = Math.max(1, Math.floor(requestedPage) || 1);
    if (!trimmedQuery) {
      setResults([]);
      setTotalResults(0);
      setCurrentPage(1);
      setState('idle');
      setNotice('');
      return;
    }

    setState('loading');
    setNotice('');

    if (!canUseTypesense) {
      const documents = await getLocalDocuments();
      const localResult = searchLocalDocuments(
        trimmedQuery,
        documents.documents,
        documents.synonymGroups,
        nextPage,
        PAGE_SIZE,
      );
      setResults(localResult.hits);
      setTotalResults(localResult.found);
      setCurrentPage(localResult.page);
      setState('ready');
      return;
    }

    const host = typesense.host?.replace(/\/$/, '');
    const collection = typesense.collection || 'qingflow_help_docs';
    try {
      const response = await fetch(`${host}/multi_search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TYPESENSE-API-KEY': typesense.searchApiKey ?? '',
        },
        body: JSON.stringify({
          searches: [
            createTypesenseSearch(collection, trimmedQuery, {
              page: nextPage,
              perPage: PAGE_SIZE,
              groupByDocument: true,
            }),
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Search service responded with ${response.status}`);
      }

      const payload = await response.json();
      const searchResult = payload.results?.[0] ?? {};
      const groupedHits = Array.isArray(searchResult.grouped_hits)
        ? searchResult.grouped_hits
        : [];
      const groupedSearchHits: SearchHit[][] = groupedHits.length > 0
        ? groupedHits.map((group: {hits?: SearchHit[]}) => group.hits ?? [])
        : Array.isArray(searchResult.hits)
          ? searchResult.hits.map((hit: SearchHit) => [hit])
          : [];
      const missingSectionDetails = groupedSearchHits
        .map((hits, index) => ({
          index,
          documentId: getDocumentsFromHits(hits)[0]?.doc_id,
          documents: getDocumentsFromHits(hits),
        }))
        .filter(
          (group): group is {index: number; documentId: string; documents: SearchDocument[]} =>
            Boolean(group.documentId) && !hasMatchingSection(group.documents, [trimmedQuery]),
        );
      const detailDocumentsByGroup = new Map<number, SearchDocument[]>();

      if (missingSectionDetails.length > 0) {
        const detailsResponse = await fetch(`${host}/multi_search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TYPESENSE-API-KEY': typesense.searchApiKey ?? '',
          },
          body: JSON.stringify({
            searches: missingSectionDetails.map(({documentId}) =>
              createTypesenseSearch(collection, trimmedQuery, {
                filterBy: createExactDocumentFilter(documentId),
              }),
            ),
          }),
        });
        if (!detailsResponse.ok) {
          throw new Error(`Search detail service responded with ${detailsResponse.status}`);
        }
        const detailPayload = await detailsResponse.json();
        const detailResults = Array.isArray(detailPayload.results) ? detailPayload.results : [];
        missingSectionDetails.forEach((group, index) => {
          const detailHits = Array.isArray(detailResults[index]?.hits)
            ? detailResults[index].hits as SearchHit[]
            : [];
          detailDocumentsByGroup.set(group.index, getDocumentsFromHits(detailHits));
        });
      }

      const hits: SearchHit[] = groupedSearchHits.map((groupHits, index) => {
        const detailDocuments = detailDocumentsByGroup.get(index) ?? [];
        if (detailDocuments.length === 0) {
          return createGroupedSearchHit(groupHits, trimmedQuery);
        }
        const mergedDocuments = mergeSearchDocuments(
          detailDocuments,
          getDocumentsFromHits(groupHits),
        );
        return createGroupedSearchHit(
          mergedDocuments.map((document) => ({document})),
          trimmedQuery,
        );
      });
      const found = Number.isFinite(searchResult.found)
        ? Math.max(0, Number(searchResult.found))
        : hits.length;
      const resolvedPage = found > 0
        ? Math.min(nextPage, getTotalPages(found, PAGE_SIZE))
        : 1;
      if (resolvedPage !== nextPage) {
        updateUrl(trimmedQuery, resolvedPage);
        await runSearch(trimmedQuery, resolvedPage);
        return;
      }
      setResults(hits);
      setTotalResults(found);
      setCurrentPage(resolvedPage);
      setState('ready');
    } catch {
      // A configured Typesense service must fail explicitly. Automatically
      // downloading the full local index here makes a transient online error
      // look like a frozen search page.
      setResults([]);
      setTotalResults(0);
      setCurrentPage(1);
      setState('error');
      setNotice('搜索服务暂时不可用，请稍后重试。');
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextQuery = params.get('q') ?? '';
    const nextPage = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
    setQuery(nextQuery);
    setCurrentPage(nextPage);
    if (nextQuery) void runSearch(nextQuery, nextPage);
  }, []);

  function updateUrl(nextQuery: string, nextPage = 1) {
    const params = new URLSearchParams();
    if (nextQuery.trim()) params.set('q', nextQuery.trim());
    if (nextPage > 1) params.set('page', String(nextPage));
    const queryString = params.toString();
    const nextUrl = queryString ? `${searchPath}?${queryString}` : searchPath;
    window.history.replaceState({}, '', nextUrl);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateUrl(query, 1);
    void runSearch(query, 1);
  }

  function handleSuggestion(nextQuery: string) {
    setQuery(nextQuery);
    updateUrl(nextQuery, 1);
    void runSearch(nextQuery, 1);
  }

  function handlePageChange(nextPage: number) {
    const totalPages = getTotalPages(totalResults, PAGE_SIZE);
    if (nextPage < 1 || nextPage > totalPages || nextPage === currentPage) return;

    updateUrl(query, nextPage);
    void runSearch(query, nextPage);
  }

  return (
    <Layout title="搜索帮助文档" description="搜索轻流产品帮助、操作指南和开发文档。">
      <main className={styles.searchPage}>
        <header className={styles.searchHero}>
          <div className="container">
            <div className={styles.heroInner}>
              <p className={styles.eyebrow}>
                <Sparkles aria-hidden="true" size={16} />
                站内搜索
              </p>
              <Heading as="h1">搜索帮助文档</Heading>
              <p>描述你遇到的问题，查找相关功能说明、操作步骤和最佳实践。</p>
              <form className={styles.searchForm} onSubmit={handleSubmit}>
                <Search aria-hidden="true" size={21} />
                <input
                  className={styles.searchInput}
                  type="search"
                  placeholder="例如：审批中心怎么配置"
                  aria-label="搜索帮助文档"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
                <button
                  type="submit"
                  data-umami-event="search"
                  data-umami-event-location="search-page">
                  搜索 <ArrowRight aria-hidden="true" size={18} />
                </button>
              </form>
              <div className={styles.suggestions}>
                <span>热门搜索</span>
                {['导入 Markdown 文档', '审批中心怎么配置', '私有化部署拓扑'].map(
                  (suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => handleSuggestion(suggestion)}>
                      {suggestion}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>
        </header>

        <section className={styles.resultsSection}>
          <div className="container">
            <div className={styles.resultsInner}>
              {state === 'loading' ? (
                <div className={styles.stateMessage}>
                  <LoaderCircle className={styles.spinner} aria-hidden="true" size={24} />
                  正在查找相关文档...
                </div>
              ) : null}

              {notice ? <p className={styles.notice}>{notice}</p> : null}

              {state === 'ready' ? (
                <div className={styles.resultsHeader}>
                  <Heading as="h2">搜索结果</Heading>
                  <span>{totalResults} 篇相关文档</span>
                </div>
              ) : null}

              {state === 'ready' && results.length === 0 ? (
                <div className={styles.emptyState}>
                  <FileSearch aria-hidden="true" size={30} />
                  <Heading as="h2">没有找到相关内容</Heading>
                  <p>试试缩短问题，或者使用功能名称重新搜索。</p>
                  <Link to="/docs/getting-started">浏览完整文档目录</Link>
                </div>
              ) : null}

              {state === 'idle' ? (
                <div className={styles.emptyState}>
                  <Search aria-hidden="true" size={30} />
                  <Heading as="h2">从一个问题开始</Heading>
                  <p>输入产品功能、操作目标或遇到的问题。</p>
                </div>
              ) : null}

              <div className={styles.results}>
                {results.map((result, index) => {
                  const document = result.document ?? {};
                  const sectionTitle =
                    document.record_type === 'section'
                      ? document.section ?? document.title
                      : document.title;
                  const documentTitle = document.document_title ?? document.title;
                  const snippet = getResultSnippet(result, query);
                  const destination = addSearchHighlightToUrl(
                    document.url ?? '/docs/getting-started',
                    query,
                  );

                  return (
                    <article key={`${document.url ?? 'result'}-${index}`} className={styles.resultRow}>
                      <Link to={destination}>
                        <div className={styles.resultTopline}>
                          <span>{document.breadcrumb ?? document.section ?? '帮助文档'}</span>
                        </div>
                        <Heading as="h2">{sectionTitle ?? '未命名段落'}</Heading>
                        {documentTitle && documentTitle !== sectionTitle ? (
                          <p className={styles.resultDocumentTitle}>{documentTitle}</p>
                        ) : null}
                        <p>{renderSearchSnippet(snippet)}</p>
                        <ChevronRight className={styles.resultArrow} aria-hidden="true" size={21} />
                      </Link>
                    </article>
                  );
                })}
              </div>

              {state === 'ready' && getTotalPages(totalResults, PAGE_SIZE) > 1 ? (
                <nav className={styles.pagination} aria-label="搜索结果分页">
                  <button
                    type="button"
                    aria-label="上一页"
                    disabled={currentPage === 1}
                    onClick={() => handlePageChange(currentPage - 1)}>
                    <ChevronLeft aria-hidden="true" size={17} />
                  </button>
                  <span>
                    第 {currentPage} / {getTotalPages(totalResults, PAGE_SIZE)} 页
                  </span>
                  <button
                    type="button"
                    aria-label="下一页"
                    disabled={currentPage === getTotalPages(totalResults, PAGE_SIZE)}
                    onClick={() => handlePageChange(currentPage + 1)}>
                    <ChevronRight aria-hidden="true" size={17} />
                  </button>
                </nav>
              ) : null}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
