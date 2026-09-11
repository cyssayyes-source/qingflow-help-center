import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addSearchHighlightToUrl,
  createMultiSearchSnippet,
  hasMatchingSection,
  rankSearchDocuments,
  rankSearchResults,
  scoreSearchDocument,
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

test('search snippets prioritize rare query terms over repeated generic terms', () => {
  const content = [
    '文档解析可以读取文档内容。'.repeat(10),
    '支持 md、markdown：Markdown 文件。',
    '在 QMC 中导入导出文档。',
  ].join(' ');
  const snippet = createMultiSearchSnippet([{content}], ['导入 Markdown 文档']);

  assert.match(snippet.text, /导入/);
  assert.match(snippet.text, /markdown/i);
  assert.ok(snippet.matches.length >= 3);
  assert.ok(snippet.text.length <= 365);
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

test('ranking prefers an exact document title over a body-only match', () => {
  const titleMatch = {
    record_type: 'document',
    title: '导入 Markdown 文档',
    document_title: '导入 Markdown 文档',
    content: '支持多种导入方式。',
    url: '/docs/import-markdown/',
  };
  const bodyMatch = {
    record_type: 'document',
    title: '数据导入说明',
    document_title: '数据导入说明',
    content: '导入 Markdown 文档前请准备好文件。',
    url: '/docs/import-data/',
  };

  assert.ok(scoreSearchDocument(titleMatch, ['导入 Markdown 文档']) > scoreSearchDocument(bodyMatch, ['导入 Markdown 文档']));
  assert.equal(rankSearchDocuments([bodyMatch, titleMatch], ['导入 Markdown 文档'])[0], titleMatch);
});

test('ranking keeps a matching subheading ahead of a generic parent-title result', () => {
  const parentTitle = {
    record_type: 'section',
    title: '使用说明',
    section: '使用说明',
    document_title: '外部用户',
    content: '配置外部用户的基本步骤。',
    url: '/docs/external-users/#使用说明',
  };
  const subheading = {
    record_type: 'section',
    title: '管理员添加外部用户',
    section: '管理员添加外部用户',
    document_title: '外部用户',
    content: '管理员可以邀请外部用户加入协作。',
    url: '/docs/external-users/#管理员添加外部用户',
  };

  assert.equal(
    rankSearchDocuments([parentTitle, subheading], ['管理员添加外部用户'])[0],
    subheading,
  );
});

test('direct query matches outrank synonym-only matches', () => {
  const direct = {
    record_type: 'document',
    title: '数据导入',
    content: '从文件导入数据。',
    url: '/docs/import/',
  };
  const synonymOnly = {
    record_type: 'document',
    title: '批量录入',
    content: '通过批量录入方式写入数据。',
    url: '/docs/batch-entry/',
  };

  assert.ok(
    scoreSearchDocument(direct, ['数据导入', '批量录入']) >
      scoreSearchDocument(synonymOnly, ['数据导入', '批量录入']),
  );
});

test('multi-term ranking prefers query terms that occur close together', () => {
  const nearby = {
    record_type: 'document',
    title: '文件导入说明',
    content: '支持导入 Markdown 文档后继续编辑。',
    url: '/docs/nearby/',
  };
  const scattered = {
    record_type: 'document',
    title: '文件处理说明',
    content: `支持导入文件。${'其他配置说明。'.repeat(80)}支持 Markdown 文件。${'其他配置说明。'.repeat(80)}文档处理完成。`,
    url: '/docs/scattered/',
  };

  assert.ok(
    scoreSearchDocument(nearby, ['导入 Markdown 文档']) >
      scoreSearchDocument(scattered, ['导入 Markdown 文档']),
  );
  assert.equal(
    rankSearchDocuments([scattered, nearby], ['导入 Markdown 文档'])[0],
    nearby,
  );
});

test('generic help-center category does not count as a document text match', () => {
  const document = {
    record_type: 'document',
    title: '导入数据',
    section: '帮助文档',
    content: '从 Excel 文件批量导入数据。',
    url: '/docs/import/',
  };

  assert.equal(scoreSearchDocument(document, ['文档']), 0);
});

test('grouped result ranking uses the best matching record in each group', () => {
  const bodyGroup = {
    document: {
      record_type: 'document',
      title: '数据处理',
      content: '导入 Markdown 文档后可以继续处理。',
      url: '/docs/process/',
    },
  };
  const titleGroup = {
    document: {
      record_type: 'document',
      title: '导入 Markdown 文档',
      content: '导入文件。',
      url: '/docs/import-markdown/',
    },
  };

  assert.equal(rankSearchResults([bodyGroup, titleGroup], ['导入 Markdown 文档'])[0], titleGroup);
});
