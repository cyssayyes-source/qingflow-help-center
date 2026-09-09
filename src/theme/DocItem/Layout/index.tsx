import React, {type ReactNode, useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import {useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import {Check, Copy} from 'lucide-react';
import ContentVisibility from '@theme/ContentVisibility';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import DocItemContent from '@theme/DocItem/Content';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocVersionBadge from '@theme/DocVersionBadge';
import DocVersionBanner from '@theme/DocVersionBanner';
import type {Props} from '@theme/DocItem/Layout';
import {getSearchHighlightTerms} from '../../../utils/search-results.mjs';

import styles from './styles.module.css';

type CopyState = 'idle' | 'copied' | 'error';

const SEARCH_HIGHLIGHT_HOLD_MS = 2600;
const SEARCH_HIGHLIGHT_REMOVE_MS = 3600;

function getTextMatches(value: string, terms: string[]): Array<{start: number; end: number}> {
  const normalized = value.toLocaleLowerCase();
  const matches: Array<{start: number; end: number}> = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const term = terms.find((candidate) => normalized.startsWith(candidate, cursor));
    if (term) {
      matches.push({start: cursor, end: cursor + term.length});
      cursor += term.length;
    } else {
      cursor += 1;
    }
  }

  return matches;
}

function highlightSearchTerms(root: HTMLElement, query: string): HTMLElement[] {
  const terms = getSearchHighlightTerms([query])
    .map((term: string) => term.toLocaleLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const ignoredTags = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !node.nodeValue?.trim() ||
        !parent ||
        ignoredTags.has(parent.tagName) ||
        parent.closest('[data-search-highlight], [data-no-search-highlight]')
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  const highlights: HTMLElement[] = [];
  textNodes.forEach((textNode) => {
    const text = textNode.nodeValue ?? '';
    const matches = getTextMatches(text, terms);
    if (matches.length === 0 || !textNode.parentNode) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match) => {
      if (match.start > cursor) fragment.append(text.slice(cursor, match.start));
      const mark = document.createElement('mark');
      mark.className = styles.searchHighlight;
      mark.dataset.searchHighlight = 'true';
      mark.textContent = text.slice(match.start, match.end);
      fragment.append(mark);
      highlights.push(mark);
      cursor = match.end;
    });
    if (cursor < text.length) fragment.append(text.slice(cursor));
    textNode.parentNode.replaceChild(fragment, textNode);
  });

  return highlights;
}

function removeSearchHighlights(highlights: HTMLElement[]) {
  highlights.forEach((highlight) => {
    const parent = highlight.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(highlight.textContent ?? ''), highlight);
    parent.normalize();
  });
}

function removeSearchParameter() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('search')) return;
  url.searchParams.delete('search');
  const search = url.searchParams.toString();
  window.history.replaceState({}, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
}

function useSearchHighlight(articleRef: React.RefObject<HTMLElement | null>, documentId: string) {
  const location = useLocation();
  const pendingQueryRef = useRef<{documentId: string; query: string} | null>(null);

  useEffect(() => {
    const suppliedQuery = new URLSearchParams(location.search).get('search')?.trim();
    const pendingQuery = pendingQueryRef.current;
    if (pendingQuery && pendingQuery.documentId !== documentId) {
      pendingQueryRef.current = null;
    }
    const query = suppliedQuery ||
      (pendingQuery?.documentId === documentId ? pendingQuery.query : undefined);

    if (!query) return undefined;

    // Strict Mode immediately re-runs effects in development. Keep the query for
    // this document until that replay has applied the visible highlight.
    pendingQueryRef.current = {documentId, query};

    const content = articleRef.current?.querySelector<HTMLElement>('.theme-doc-markdown');
    if (!content) {
      if (suppliedQuery) removeSearchParameter();
      return undefined;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let highlights: HTMLElement[] = [];
    let fadeTimer: number | undefined;
    let removeTimer: number | undefined;
    let highlightFrame: number | undefined;
    let scrollFrame: number | undefined;

    // Give Docusaurus a paint to settle the document, then explicitly center the
    // destination heading before showing the temporary search highlight.
    scrollFrame = window.requestAnimationFrame(() => {
      const hash = location.hash.slice(1);
      if (hash) {
        try {
          document.getElementById(decodeURIComponent(hash))?.scrollIntoView({block: 'center'});
        } catch {
          document.getElementById(hash)?.scrollIntoView({block: 'center'});
        }
      }

      highlightFrame = window.requestAnimationFrame(() => {
        highlights = highlightSearchTerms(content, query);
        if (suppliedQuery) removeSearchParameter();
        if (highlights.length === 0) return;

        fadeTimer = window.setTimeout(
          () => highlights.forEach((highlight) => highlight.classList.add(styles.searchHighlightFading)),
          reduceMotion ? 0 : SEARCH_HIGHLIGHT_HOLD_MS,
        );
        removeTimer = window.setTimeout(
          () => removeSearchHighlights(highlights),
          reduceMotion ? 1200 : SEARCH_HIGHLIGHT_REMOVE_MS,
        );
      });
    });

    return () => {
      if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
      if (highlightFrame !== undefined) window.cancelAnimationFrame(highlightFrame);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
      if (removeTimer !== undefined) window.clearTimeout(removeTimer);
      removeSearchHighlights(highlights);
    };
  }, [articleRef, documentId]);
}

function useDocTOC() {
  const {frontMatter, toc} = useDoc();
  const windowSize = useWindowSize();
  const hidden = frontMatter.hide_table_of_contents;
  const canRender = !hidden && toc.length > 0;

  return {
    hidden,
    mobile: canRender ? <DocItemTOCMobile /> : undefined,
    desktop:
      canRender && (windowSize === 'desktop' || windowSize === 'ssr') ? (
        <DocItemTOCDesktop />
      ) : undefined,
  };
}

function DocToolbar() {
  const {metadata} = useDoc();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const sourcePath = metadata.source
    .replace(/^@site\/docs\//, '')
    .replace(/\.(md|mdx)$/i, '.md');
  const rawUrl = useBaseUrl(`/raw-docs/${sourcePath}`);

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copyMarkdown() {
    try {
      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error(`Markdown request failed: ${response.status}`);
      const markdown = await response.text();
      await navigator.clipboard.writeText(markdown);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  const label =
    copyState === 'copied'
      ? '已复制'
      : copyState === 'error'
        ? '复制失败'
        : '复制为 Markdown';

  return (
    <div className={styles.docToolbar}>
      <DocBreadcrumbs />
      <button
        type="button"
        className={styles.copyButton}
        onClick={copyMarkdown}
        aria-label="复制页面为 Markdown">
        {copyState === 'copied' ? (
          <Check aria-hidden="true" size={16} />
        ) : (
          <Copy aria-hidden="true" size={16} />
        )}
        <span>{label}</span>
      </button>
    </div>
  );
}

export default function DocItemLayout({children}: Props): ReactNode {
  const docTOC = useDocTOC();
  const {metadata} = useDoc();
  const articleRef = React.useRef<HTMLElement>(null);

  useSearchHighlight(articleRef, metadata.id);

  return (
    <div className={clsx('row', styles.docLayout)}>
      <div className={clsx('col', docTOC.desktop && styles.docItemCol)}>
        <ContentVisibility metadata={metadata} />
        <DocVersionBanner />
        <div className={styles.docItemContainer}>
          <article ref={articleRef}>
            <DocToolbar />
            <DocVersionBadge />
            {docTOC.mobile}
            <DocItemContent>{children}</DocItemContent>
            <DocItemFooter />
          </article>
          <DocItemPaginator />
        </div>
      </div>
      {docTOC.desktop && (
        <aside className={clsx('col col--3', styles.tocColumn)}>{docTOC.desktop}</aside>
      )}
    </div>
  );
}
