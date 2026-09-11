import type {FormEvent, KeyboardEvent, ReactNode} from 'react';
import {useEffect, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import {useHistory} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import clsx from 'clsx';
import {ArrowRight, ChevronRight, Command, LoaderCircle, Search} from 'lucide-react';

import {
  buildSearchQuery,
  findSearchMatches,
  getSearchHighlightTerms,
  normalizeSearchText,
} from '../../utils/search-results.mjs';
import {createTypesenseSearch, expandSearchQuery} from '../../utils/search-client.mjs';
import {
  hasMinimumSuggestionQuery,
  mapTypesenseSuggestions,
  searchLocalSuggestions,
  SEARCH_SUGGESTION_CANDIDATE_LIMIT,
  SEARCH_SUGGESTION_GROUP_LIMIT,
  SEARCH_SUGGESTION_LIMIT,
} from '../../utils/search-suggestions.mjs';
import styles from './styles.module.css';

type SynonymGroup = {terms: string[]};

type SuggestionRecord = {
  id?: string;
  doc_id?: string;
  record_type?: 'document';
  title?: string;
  document_title?: string;
  section?: string;
  breadcrumb?: string;
  keywords?: string[];
  url?: string;
  business_priority?: number;
  updated_at_ts?: number;
};

type SearchSuggestion = {
  id: string;
  docId: string;
  title: string;
  breadcrumb: string;
  url: string;
  recordType: 'document' | 'section';
};

type SuggestionState = 'idle' | 'loading' | 'ready' | 'error';

export type SearchComboboxProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  variant: 'home' | 'search-page';
  analyticsLocation: 'home' | 'search-page';
  inputId: string;
  placeholder: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  enableShortcut?: boolean;
  className?: string;
};

const SUGGESTION_DEBOUNCE_MS = 200;
const LOADING_INDICATOR_DELAY_MS = 200;
const SUGGESTION_FIELDS = [
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
].join(',');

function renderHighlightedTitle(value: string, query: string): ReactNode {
  const matches = findSearchMatches(value, getSearchHighlightTerms([query]));
  if (matches.length === 0) return value;

  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach(({start, end}: {start: number; end: number}, index: number) => {
    if (start > cursor) parts.push(value.slice(cursor, start));
    parts.push(<mark key={`${start}-${end}-${index}`}>{value.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function withBaseUrl(baseUrl: string, url: string): string {
  if (!url.startsWith('/')) return url;
  return `${baseUrl.replace(/\/$/u, '')}/${url.replace(/^\//u, '')}`;
}

export default function SearchCombobox({
  value,
  onChange,
  onSubmit,
  variant,
  analyticsLocation,
  inputId,
  placeholder,
  ariaLabel = '搜索帮助文档',
  autoFocus = false,
  enableShortcut = false,
  className,
}: SearchComboboxProps): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const history = useHistory();
  const baseUrl = useBaseUrl('/');
  const searchPath = useBaseUrl('/search');
  const suggestionIndexPath = useBaseUrl('/search-suggestions.json');
  const searchSynonymsPath = useBaseUrl('/search-synonyms.json');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const localIndexPromise = useRef<Promise<SuggestionRecord[]> | null>(null);
  const synonymGroupsPromise = useRef<Promise<SynonymGroup[]> | null>(null);
  const requestSequence = useRef(0);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [found, setFound] = useState(0);
  const [state, setState] = useState<SuggestionState>('idle');
  const [showLoading, setShowLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = `${inputId}-suggestions`;

  const customFields = (siteConfig.customFields ?? {}) as {
    typesense?: {
      host?: string;
      searchApiKey?: string;
      collection?: string;
    };
  };
  const typesense = customFields.typesense ?? {};
  const canUseTypesense = Boolean(typesense.host && typesense.searchApiKey);

  function getSynonymGroups(): Promise<SynonymGroup[]> {
    if (!synonymGroupsPromise.current) {
      synonymGroupsPromise.current = fetch(searchSynonymsPath)
        .then(async (response) => {
          if (!response.ok) return [];
          const payload: unknown = await response.json();
          return Array.isArray(payload) ? (payload as SynonymGroup[]) : [];
        })
        .catch(() => []);
    }
    return synonymGroupsPromise.current;
  }

  function getLocalSuggestionRecords(): Promise<SuggestionRecord[]> {
    if (!localIndexPromise.current) {
      localIndexPromise.current = fetch(suggestionIndexPath)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Suggestion index responded with ${response.status}`);
          }
          const payload: unknown = await response.json();
          return Array.isArray(payload) ? (payload as SuggestionRecord[]) : [];
        });
    }
    return localIndexPromise.current;
  }

  async function loadSuggestions(query: string, signal: AbortSignal) {
    const synonymGroups = await getSynonymGroups();
    const variants = expandSearchQuery(query, synonymGroups).map(normalizeSearchText);

    if (canUseTypesense) {
      try {
        const searchQuery = buildSearchQuery(query, synonymGroups) || query;
        const isNaturalLanguageQuery =
          normalizeSearchText(searchQuery) !== normalizeSearchText(query);
        const host = typesense.host?.replace(/\/$/u, '');
        const collection = typesense.collection || 'qingflow_help_docs';
        const response = await fetch(`${host}/multi_search`, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'X-TYPESENSE-API-KEY': typesense.searchApiKey ?? '',
          },
          body: JSON.stringify({
            searches: [
              createTypesenseSearch(collection, searchQuery, {
                page: 1,
                perPage: SEARCH_SUGGESTION_CANDIDATE_LIMIT,
                groupByDocument: true,
                groupLimit: SEARCH_SUGGESTION_GROUP_LIMIT,
                includeFields: SUGGESTION_FIELDS,
                highlightFields: 'title,document_title,section',
                textMatchType: isNaturalLanguageQuery ? 'max_weight' : 'max_score',
              }),
            ],
          }),
        });
        if (!response.ok) {
          throw new Error(`Suggestion service responded with ${response.status}`);
        }
        const payload = await response.json();
        return mapTypesenseSuggestions(payload.results?.[0] ?? {}, variants);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }

    const localRecords = await getLocalSuggestionRecords();
    return searchLocalSuggestions(localRecords, variants);
  }

  function closeSuggestions() {
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function submitSearch() {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      inputRef.current?.focus();
      return;
    }
    closeSuggestions();
    onSubmit(trimmedValue);
  }

  function selectSuggestion(suggestion: SearchSuggestion) {
    closeSuggestions();
    history.push(withBaseUrl(baseUrl, suggestion.url));
  }

  useEffect(() => {
    const requestId = ++requestSequence.current;
    setActiveIndex(-1);

    if (!isFocused || !hasInteracted || isComposing || !hasMinimumSuggestionQuery(value)) {
      if (!hasMinimumSuggestionQuery(value)) {
        setSuggestions([]);
        setFound(0);
        setState('idle');
      }
      setIsOpen(false);
      return undefined;
    }

    setSuggestions([]);
    setFound(0);
    setState('idle');
    setIsOpen(false);
    let controller: AbortController | undefined;
    const debounceTimer = window.setTimeout(() => {
      controller = new AbortController();
      setState('loading');
      setIsOpen(true);
      void loadSuggestions(value.trim(), controller.signal)
        .then((result: {items: SearchSuggestion[]; found: number}) => {
          if (requestSequence.current !== requestId || controller?.signal.aborted) return;
          setSuggestions(result.items);
          setFound(result.found);
          setState('ready');
          setIsOpen(true);
        })
        .catch(() => {
          if (requestSequence.current !== requestId || controller?.signal.aborted) return;
          setSuggestions([]);
          setFound(0);
          setState('error');
          setIsOpen(true);
        });
    }, SUGGESTION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(debounceTimer);
      controller?.abort();
    };
  }, [hasInteracted, isComposing, isFocused, value]);

  useEffect(() => {
    if (state !== 'loading') {
      setShowLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(
      () => setShowLoading(true),
      LOADING_INDICATOR_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeSuggestions();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (!enableShortcut) return undefined;
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      const isCommand =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (isCommand || (event.key === '/' && !isTyping)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [enableShortcut]);

  const footerIndex = suggestions.length;
  const optionCount = state === 'ready' ? suggestions.length + 1 : 0;
  const panelVisible =
    isOpen &&
    (state === 'ready' || state === 'error' || (state === 'loading' && showLoading));
  const activeOptionId =
    panelVisible && activeIndex >= 0
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || isComposing) return;

    if (event.key === 'Escape') {
      if (isOpen) event.preventDefault();
      closeSuggestions();
      return;
    }
    if (event.key === 'Tab') {
      closeSuggestions();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!hasMinimumSuggestionQuery(value)) return;
      event.preventDefault();
      setHasInteracted(true);
      setIsOpen(true);
      if (optionCount === 0) return;
      setActiveIndex((current) => {
        if (event.key === 'ArrowDown') return current >= optionCount - 1 ? 0 : current + 1;
        return current <= 0 ? optionCount - 1 : current - 1;
      });
      return;
    }
    if (event.key === 'Enter' && panelVisible && activeIndex >= 0) {
      event.preventDefault();
      if (activeIndex < suggestions.length) {
        selectSuggestion(suggestions[activeIndex]);
      } else {
        submitSearch();
      }
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitSearch();
  }

  const statusText =
    state === 'loading'
      ? '正在查找相关文档'
      : state === 'ready'
        ? found > 0
          ? `找到 ${found} 篇相关文档`
          : '没有找到匹配的文档'
        : state === 'error'
          ? '搜索建议暂时不可用'
          : '';

  return (
    <div ref={containerRef} className={clsx(styles.container, className)}>
      <form
        className={clsx(styles.form, styles[variant === 'home' ? 'formHome' : 'formPage'])}
        onSubmit={handleFormSubmit}
        onMouseEnter={() => window.docusaurus?.preload(searchPath)}>
        <Search aria-hidden="true" size={variant === 'home' ? 22 : 21} strokeWidth={2} />
        <input
          ref={inputRef}
          id={inputId}
          className={styles.input}
          name="q"
          type="search"
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={panelVisible}
          aria-activedescendant={activeOptionId}
          role="combobox"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setIsFocused(true);
            setHasInteracted(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            setIsFocused(true);
            if (hasInteracted && state === 'ready' && hasMinimumSuggestionQuery(value)) {
              setIsOpen(true);
            }
          }}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => {
            setIsComposing(false);
            setIsFocused(true);
            setHasInteracted(true);
          }}
          autoComplete="off"
          enterKeyHint="search"
          autoFocus={autoFocus}
        />
        {variant === 'home' ? (
          <span className={styles.shortcut} aria-hidden="true">
            <Command size={13} />K
          </span>
        ) : null}
        <button
          className={styles.submitButton}
          type="submit"
          aria-label="提交搜索"
          data-umami-event="search"
          data-umami-event-location={analyticsLocation}>
          {variant === 'search-page' ? <span>搜索</span> : null}
          <ArrowRight aria-hidden="true" size={variant === 'home' ? 19 : 18} />
        </button>
      </form>

      {panelVisible ? (
        <div
          id={listboxId}
          className={styles.panel}
          role="listbox"
          aria-label="搜索建议"
          aria-busy={state === 'loading'}>
          {state === 'loading' ? (
            <div className={styles.stateRow} role="status">
              <LoaderCircle className={styles.spinner} aria-hidden="true" size={17} />
              正在查找相关文档...
            </div>
          ) : null}

          {state === 'error' ? (
            <div className={styles.stateRow}>搜索建议暂时不可用，可继续搜索全部内容。</div>
          ) : null}

          {state === 'ready' && suggestions.length === 0 ? (
            <div className={styles.stateRow}>没有找到匹配的文档</div>
          ) : null}

          {state === 'ready'
            ? suggestions.map((suggestion, index) => (
                <Link
                  id={`${listboxId}-option-${index}`}
                  key={`${suggestion.docId}-${suggestion.url}`}
                  className={clsx(styles.option, activeIndex === index && styles.optionActive)}
                  role="option"
                  aria-selected={activeIndex === index}
                  tabIndex={-1}
                  to={suggestion.url}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={closeSuggestions}
                  data-umami-event="search-suggestion-select"
                  data-umami-event-location={analyticsLocation}
                  data-umami-event-position={index + 1}
                  data-umami-event-result-type={suggestion.recordType}>
                  <span className={styles.optionText}>
                    <strong>{renderHighlightedTitle(suggestion.title, value)}</strong>
                    <small>{suggestion.breadcrumb}</small>
                  </span>
                  <ChevronRight aria-hidden="true" size={17} />
                </Link>
              ))
            : null}

          {state === 'ready' ? (
            <button
              id={`${listboxId}-option-${footerIndex}`}
              className={clsx(
                styles.searchAll,
                activeIndex === footerIndex && styles.optionActive,
              )}
              type="button"
              role="option"
              aria-selected={activeIndex === footerIndex}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(footerIndex)}
              onClick={submitSearch}
              data-umami-event="search"
              data-umami-event-location={`${analyticsLocation}-suggestions`}>
              <Search aria-hidden="true" size={17} />
              <span>
                {found > 0
                  ? `查看“${value.trim()}”的全部 ${found} 篇结果`
                  : `搜索“${value.trim()}”的全部内容`}
              </span>
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          ) : null}
        </div>
      ) : null}

      <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
    </div>
  );
}
