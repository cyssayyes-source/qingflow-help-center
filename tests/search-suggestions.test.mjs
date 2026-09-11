import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTypesenseSearch,
  expandSearchQuery,
  getGroupedSearchHits,
} from '../src/utils/search-client.mjs';
import {
  createSearchSuggestionRecords,
  hasMinimumSuggestionQuery,
  mapTypesenseSuggestions,
  searchLocalSuggestions,
  SEARCH_SUGGESTION_CANDIDATE_LIMIT,
  SEARCH_SUGGESTION_GROUP_LIMIT,
} from '../src/utils/search-suggestions.mjs';

test('lightweight suggestion records contain one safe projection per document', () => {
  const records = [
    {
      id: 'approval',
      doc_id: 'approval',
      record_type: 'document',
      title: '审批中心',
      document_title: '审批中心',
      section: '帮助文档',
      breadcrumb: '帮助文档 / 流程与审批 / 审批中心',
      keywords: ['待办中心'],
      search_tokens: ['审批', '中心'],
      content: '不应进入轻量索引的正文',
      raw_url: '/raw-docs/approval.md',
      url: '/docs/approval/',
      business_priority: 50,
      updated_at_ts: 1,
    },
    {id: 'approval-section', doc_id: 'approval', record_type: 'section'},
    {id: 'approval-copy', doc_id: 'approval', record_type: 'document'},
  ];

  const projected = createSearchSuggestionRecords(records);
  assert.equal(projected.length, 1);
  assert.deepEqual(Object.keys(projected[0]), [
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
  ]);
  assert.equal('content' in projected[0], false);
  assert.equal('search_tokens' in projected[0], false);
  assert.equal('raw_url' in projected[0], false);
});

test('autocomplete waits for two visible characters', () => {
  assert.equal(hasMinimumSuggestionQuery('审'), false);
  assert.equal(hasMinimumSuggestionQuery(' 审批 '), true);
  assert.equal(hasMinimumSuggestionQuery('AP'), true);
  assert.equal(hasMinimumSuggestionQuery(''), false);
});

test('Typesense request shares relevance settings and limits suggestion payload', () => {
  const request = createTypesenseSearch('help_docs', '审批 配置', {
    perPage: SEARCH_SUGGESTION_CANDIDATE_LIMIT,
    groupByDocument: true,
    groupLimit: SEARCH_SUGGESTION_GROUP_LIMIT,
    includeFields: 'id,doc_id,title,url',
    highlightFields: 'title,document_title,section',
  });

  assert.equal(request.query_by, 'title,document_title,keywords,tags,search_tokens,content');
  assert.equal(request.query_by_weights, '16,14,7,5,6,2');
  assert.equal(request.per_page, 20);
  assert.equal(request.group_by, 'doc_id');
  assert.equal(request.group_limit, 5);
  assert.equal(request.include_fields, 'id,doc_id,title,url');
  assert.equal(request.highlight_fields, 'title,document_title,section');
});

test('Typesense suggestions re-rank document groups using their best matching section', () => {
  const payload = {
    found: 12,
    grouped_hits: [
      {
        hits: [
          {
            document: {
              id: 'generic-section',
              doc_id: 'generic',
              record_type: 'section',
              title: '添加流程',
              section: '添加流程',
              breadcrumb: '搭建技巧 / 按场景分类 / 进销存',
              url: '/docs/generic/#add',
            },
          },
        ],
      },
      {
        hits: [
          {
            document: {
              id: 'approval-parent',
              doc_id: 'approval',
              record_type: 'document',
              title: '什么是电子签章',
              breadcrumb: '帮助文档 / 管理后台 / 插件管理 / 电子签章',
              url: '/docs/approval/',
            },
          },
          {
            document: {
              id: 'approval-section',
              doc_id: 'approval',
              record_type: 'section',
              title: '2.6 在审批节点中配置电子签章',
              section: '2.6 在审批节点中配置电子签章',
              breadcrumb: '帮助文档 / 管理后台 / 插件管理 / 电子签章',
              url: '/docs/approval/#configure',
            },
          },
        ],
      },
    ],
  };

  const result = mapTypesenseSuggestions(payload, ['审批配置']);
  assert.equal(result.items[0].id, 'approval-section');
  assert.equal(result.items[0].title, '2.6 在审批节点中配置电子签章');
  assert.equal(result.items[1].id, 'generic-section');
});

test('grouped Typesense hits become unique document suggestions with section anchors', () => {
  const payload = {
    found: 12,
    grouped_hits: [
      {
        hits: [
          {
            document: {
              id: 'approval-section',
              doc_id: 'approval',
              record_type: 'section',
              title: '配置审批节点',
              section: '配置审批节点',
              breadcrumb: '帮助文档 / 流程与审批 / 审批中心 / 配置审批节点',
              url: '/docs/approval/#configure',
            },
          },
        ],
      },
      {
        hits: [
          {
            document: {
              id: 'approval-copy',
              doc_id: 'approval',
              record_type: 'document',
              title: '审批中心',
              breadcrumb: '帮助文档 / 流程与审批 / 审批中心',
              url: '/docs/approval/',
            },
          },
        ],
      },
      {
        hits: [
          {
            document: {
              id: 'members',
              doc_id: 'members',
              record_type: 'document',
              title: '成员管理',
              breadcrumb: '帮助文档 / 工作区 / 成员管理',
              url: '/docs/members/',
            },
          },
        ],
      },
    ],
  };

  assert.equal(getGroupedSearchHits(payload).length, 3);
  const result = mapTypesenseSuggestions(payload);
  assert.equal(result.found, 12);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    id: 'approval-section',
    docId: 'approval',
    title: '配置审批节点',
    breadcrumb: '帮助文档 / 流程与审批 / 审批中心',
    url: '/docs/approval/#configure',
    recordType: 'section',
  });
});

test('local suggestions rank title and synonym matches without full document content', () => {
  const records = [
    {
      id: 'connections',
      doc_id: 'connections',
      record_type: 'document',
      title: '连接中心',
      keywords: ['集成'],
      breadcrumb: '帮助文档 / 开放平台 / 连接中心',
      url: '/docs/connections/',
    },
    {
      id: 'todo',
      doc_id: 'todo',
      record_type: 'document',
      title: '待办中心',
      keywords: ['审批中心', '审批工作台'],
      breadcrumb: '帮助文档 / 流程与审批 / 待办中心',
      url: '/docs/todo/',
    },
  ];
  const variants = expandSearchQuery('审批中心', [
    {terms: ['待办中心', '审批中心', '审批工作台']},
  ]);

  const result = searchLocalSuggestions(records, variants);
  assert.equal(result.found, 1);
  assert.equal(result.items[0].docId, 'todo');
});
