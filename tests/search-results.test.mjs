import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addSearchHighlightToUrl,
  createMultiSearchSnippet,
  hasMatchingSection,
  mergeSearchDocuments,
  selectGroupedSearchResult,
} from '../src/utils/search-results.mjs';

test('search snippets keep distant matches as separate contextual excerpts', () => {
  const leading = '这里是开头内容。'.repeat(16);
  const middle = '中间的审批配置需要由管理员确认。';
  const trailing = '这是间隔很远的内容。'.repeat(18);
  const ending = '最后还需要处理审批任务并通知负责人。';

  const snippet = createMultiSearchSnippet(
    [{content: `${leading}${middle}${trailing}${ending}`}],
    ['审批'],
  );

  assert.match(snippet.text, /审批配置/);
  assert.match(snippet.text, /审批任务/);
  assert.match(snippet.text, /\.\.\. .*\.\.\./);
  assert.ok(snippet.matches.length >= 2);
});

test('grouped search chooses a relevant section instead of a generic sibling heading', () => {
  const genericSection = {
    record_type: 'section',
    title: '注意事项',
    section: '注意事项',
    document_title: '审批类型',
    content: '请在发布前确认当前配置。',
    url: '/docs/approval/#notes',
  };
  const matchingSection = {
    record_type: 'section',
    title: '审批配置',
    section: '审批配置',
    document_title: '审批类型',
    content: '在审批节点中设置负责人和审批类型。',
    url: '/docs/approval/#settings',
  };
  const documentRecord = {
    record_type: 'document',
    title: '审批类型',
    document_title: '审批类型',
    content: '审批类型包含或签与会签。',
    url: '/docs/approval/',
  };

  const result = selectGroupedSearchResult(
    [genericSection, documentRecord, matchingSection],
    ['审批'],
  );

  assert.equal(result.displayDocument, matchingSection);
  assert.deepEqual(result.snippetDocuments, [matchingSection]);
});

test('grouped search requests details only when the initial group lacks a matching section', () => {
  const documentRecord = {
    id: 'approval-document',
    doc_id: 'approval-document',
    record_type: 'document',
    title: '审批类型',
    content: '配置不同类型的流程节点。',
  };
  const matchingSection = {
    id: 'approval-section',
    doc_id: 'approval-document',
    record_type: 'section',
    title: '审批配置',
    section: '审批配置',
    content: '在审批节点中设置负责人。',
  };

  assert.equal(hasMatchingSection([documentRecord], ['审批']), false);
  assert.equal(hasMatchingSection([matchingSection], ['审批']), true);
  assert.deepEqual(
    mergeSearchDocuments([matchingSection], [documentRecord, matchingSection]),
    [matchingSection, documentRecord],
  );
});

test('document title matches open the document while subheading matches open the section', () => {
  const documentRecord = {
    record_type: 'document',
    title: '外部用户',
    document_title: '外部用户',
    content: '介绍协同使用方式。',
    url: '/docs/external-users/',
  };
  const firstSection = {
    record_type: 'section',
    title: '简介',
    section: '简介',
    document_title: '外部用户',
    content: '介绍协同使用方式。',
    url: '/docs/external-users/#简介',
  };
  const targetSection = {
    record_type: 'section',
    title: '管理员添加外部用户',
    section: '管理员添加外部用户',
    document_title: '外部用户',
    content: '配置邀请权限。',
    url: '/docs/external-users/#管理员添加外部用户',
  };

  assert.equal(
    selectGroupedSearchResult([firstSection, documentRecord, targetSection], ['外部用户'])
      .displayDocument,
    documentRecord,
  );
  assert.equal(
    selectGroupedSearchResult([firstSection, documentRecord, targetSection], ['管理员添加'])
      .displayDocument,
    targetSection,
  );
});

test('search highlighting preserves an existing query string and anchor', () => {
  assert.equal(
    addSearchHighlightToUrl('/docs/approval/?lang=zh#settings', '审批 配置'),
    '/docs/approval/?lang=zh&search=%E5%AE%A1%E6%89%B9+%E9%85%8D%E7%BD%AE#settings',
  );
});
