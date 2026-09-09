import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {getContentPaths, getContentSource} from '../scripts/lib/content-source.mjs';
import {
  assignDocumentRoutes,
  createOutlineClient,
  disableProxyForOutline,
  fetchAllPages,
  fetchOutlineSnapshot,
  findRelativeMediaReferences,
  generateOutlineOutput,
  readLegacyRoutes,
  replaceGeneratedOutput,
  rewriteMarkdownUrls,
  serializeGeneratedSidebar,
  validateOutlineMarkdown,
} from '../scripts/lib/outline-sync.mjs';

const baseUrl = 'https://outline.dev.oalite.com';
const docIdOne = '11111111-1111-4111-8111-111111111111';
const docIdTwo = '22222222-2222-4222-8222-222222222222';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  });
}

test('Outline synchronization disables inherited proxy settings', () => {
  const environment = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    all_proxy: 'socks5://127.0.0.1:7890',
    NODE_USE_ENV_PROXY: '1',
  };

  disableProxyForOutline(environment);

  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    assert.equal(name in environment, false);
  }
  assert.equal(environment.NODE_USE_ENV_PROXY, '0');
  assert.equal(environment.NO_PROXY, '*');
  assert.equal(environment.no_proxy, '*');
});

test('content source paths select one document tree', () => {
  assert.equal(getContentSource({}), 'outline');
  assert.equal(getContentSource({DOCS_CONTENT_SOURCE: 'LEGACY'}), 'legacy');
  assert.equal(getContentPaths('/repo', {DOCS_CONTENT_SOURCE: 'legacy'}).docsRoot, path.join('/repo', 'docs', 'migrated'));
  assert.throws(() => getContentSource({DOCS_CONTENT_SOURCE: 'other'}), /Unsupported/);
});

test('Outline client posts JSON, authenticates, paginates, and retries transient errors', async () => {
  const requests = [];
  let attempts = 0;
  const client = createOutlineClient({
    baseUrl: `${baseUrl}/`,
    token: 'test-secret',
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      attempts += 1;
      if (attempts === 1) return jsonResponse({message: 'temporary'}, 500);
      const {offset} = JSON.parse(options.body);
      return jsonResponse({data: offset === 0 ? [{id: '1'}, {id: '2'}] : [{id: '3'}]});
    },
  });

  const items = await fetchAllPages(client, 'collections.list', {}, 2);
  assert.deepEqual(items.map(({id}) => id), ['1', '2', '3']);
  assert.equal(requests[0].url, `${baseUrl}/api/collections.list`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(requests.length, 3);
});

test('Outline client does not retry authorization errors or expose its token', async () => {
  let attempts = 0;
  const client = createOutlineClient({
    token: 'private-token',
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse({message: 'private-token'}, 403);
    },
  });
  await assert.rejects(client.post('collections.list'), (error) => {
    assert.doesNotMatch(error.message, /private-token/);
    assert.match(error.message, /HTTP 403/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('snapshot uses the collection tree and fetches missing bodies with documents.info', async () => {
  const endpoints = [];
  const client = {
    async post(endpoint, payload) {
      endpoints.push({endpoint, payload});
      if (endpoint === 'collections.list') {
        return {data: payload.offset === 0 ? [{id: 'collection-1', name: '售后知识库'}] : []};
      }
      if (endpoint === 'collections.documents') {
        return {
          data: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              title: '📖 售后知识库',
              children: [
                {
                  id: docIdOne,
                  title: '产品指南',
                  url: '/doc/product-guide-one',
                  children: [
                    {id: docIdTwo, title: '表单', url: '/doc/form-two', children: []},
                  ],
                },
              ],
            },
          ],
        };
      }
      if (endpoint === 'documents.list') {
        return {
          data:
            payload.offset === 0
              ? [{id: docIdOne, title: '产品指南', urlId: 'one', text: 'Parent', updatedAt: '2026-01-01'}]
              : [],
        };
      }
      if (endpoint === 'documents.info') {
        return {data: {id: docIdTwo, title: '表单', urlId: 'two', text: 'Child', updatedAt: '2026-01-02'}};
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };

  const snapshot = await fetchOutlineSnapshot(client, '售后知识库');
  assert.equal(snapshot.documents.length, 2);
  assert.deepEqual(snapshot.documents[1].parents, ['产品指南']);
  assert.equal(snapshot.documents[1].text, 'Child');
  assert.ok(endpoints.some(({endpoint}) => endpoint === 'documents.info'));
  assert.ok(
    endpoints.some(
      ({endpoint, payload}) =>
        endpoint === 'documents.list' &&
        payload.sort === 'createdAt' &&
        payload.direction === 'ASC',
    ),
  );
});

test('snapshot requires exactly one collection with the configured name', async () => {
  const emptyClient = {post: async () => ({data: []})};
  await assert.rejects(fetchOutlineSnapshot(emptyClient, '售后知识库'), /not found/);

  const duplicateClient = {
    post: async () => ({
      data: [
        {id: 'collection-1', name: '售后知识库'},
        {id: 'collection-2', name: '售后知识库'},
      ],
    }),
  };
  await assert.rejects(fetchOutlineSnapshot(duplicateClient, '售后知识库'), /Multiple/);
});

test('snapshot rejects wrong bodies and documents outside the navigation tree', async () => {
  const responses = {
    'collections.list': {data: [{id: 'collection', name: '售后知识库'}]},
    'collections.documents': {
      data: [{id: docIdOne, title: 'Guide', children: []}],
    },
    'documents.list': {data: []},
    'documents.info': {data: {id: docIdTwo, title: 'Guide', text: 'Wrong'}},
  };
  const wrongBodyClient = {post: async (endpoint) => responses[endpoint]};
  await assert.rejects(fetchOutlineSnapshot(wrongBodyClient, '售后知识库'), /wrong document/);

  responses['documents.list'] = {
    data: [
      {id: docIdOne, title: 'Guide', text: 'Guide'},
      {id: docIdTwo, title: 'Extra', text: 'Extra'},
    ],
  };
  const extraBodyClient = {post: async (endpoint) => responses[endpoint]};
  await assert.rejects(fetchOutlineSnapshot(extraBodyClient, '售后知识库'), /outside the navigation tree/);
});

test('media references become absolute and Outline document links become local', () => {
  const documents = [
    {
      id: 'doc-1',
      urlId: 'one',
      url: '/doc/guide-one',
      slug: '/product-guides/guide',
    },
  ];
  const markdown = [
    '[Guide](/doc/guide-one#part)',
    '![Image](/api/attachments.redirect?id=image)',
    '<video src="/api/attachments.redirect?id=video" poster="/api/attachments.redirect?id=poster"></video>',
    '<source srcset="/api/attachments.redirect?id=small 1x, /api/attachments.redirect?id=large 2x">',
    'First line<br>Second line',
    'Visit <https://example.com/help>',
    '| JSON | {"value":{"enabled":true}} |',
    '文件{序号}.pdf',
    'HP < 60，合格率<不合格率，HP **<** 10，行尾<',
    '正则 ^[a-z]{0,}$ 与 [0-9]{2}',
    '后行断言 (?<=订单号:)(\\S+)',
    '例子：{"name":"贾胜强"}',
    '分页 {{PAGE_INDEX}} 与 {{OFFSET}}',
    '钉钉语法 <@userid>',
    '字段 qf_field.{开始日期$$169ACB6B8$$}',
    '```md',
    '![Example](/api/attachments.redirect?id=do-not-rewrite-code)',
    '```',
  ].join('\n');

  const rewritten = rewriteMarkdownUrls(markdown, documents, baseUrl);
  assert.match(rewritten, /\[Guide\]\(\/docs\/product-guides\/guide#part\)/);
  assert.match(rewritten, /https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=image/);
  assert.match(rewritten, /id=video/);
  assert.match(rewritten, /id=large 2x/);
  assert.match(rewritten, /First line<br \/>Second line/);
  assert.match(
    rewritten,
    /Visit \[https:\/\/example\.com\/help\]\(https:\/\/example\.com\/help\)/,
  );
  assert.match(
    rewritten,
    /\| JSON \| &#123;"value":&#123;"enabled":true&#125;&#125; \|/,
  );
  assert.match(rewritten, /文件&#123;序号&#125;\.pdf/);
  assert.match(
    rewritten,
    /HP &lt; 60，合格率&lt;不合格率，HP \*\*&lt;\*\* 10，行尾&lt;/,
  );
  assert.match(
    rewritten,
    /正则 \^\[a-z\]&#123;0,&#125;\$ 与 \[0-9\]&#123;2&#125;/,
  );
  assert.match(rewritten, /后行断言 \(\?&lt;=订单号:\)\(\\S\+\)/);
  assert.match(rewritten, /例子：&#123;"name":"贾胜强"&#125;/);
  assert.match(
    rewritten,
    /分页 &#123;&#123;PAGE_INDEX&#125;&#125; 与 &#123;&#123;OFFSET&#125;&#125;/,
  );
  assert.match(rewritten, /钉钉语法 &lt;@userid&gt;/);
  assert.match(
    rewritten,
    /字段 qf_field\.&#123;开始日期\$\$169ACB6B8\$\$&#125;/,
  );
  assert.match(rewritten, /do-not-rewrite-code/);
  assert.deepEqual(findRelativeMediaReferences(rewritten), []);
});

test('Outline Markdown rejects executable MDX and unsafe JSX', async () => {
  await validateOutlineMarkdown('Safe **Markdown**\n\n<video src="https://example.com/video.mp4" controls />');
  await assert.rejects(
    validateOutlineMarkdown('{process.env.OUTLINE_API_TOKEN}'),
    /Executable MDX construct/,
  );
  await assert.rejects(
    validateOutlineMarkdown('export const secret = process.env.OUTLINE_API_TOKEN'),
    /Executable MDX construct/,
  );
  await assert.rejects(
    validateOutlineMarkdown('<img src="https://example.com/a.png" onError={alert(1)} />'),
    /Executable MDX attribute|Unsafe MDX attribute/,
  );
  await assert.rejects(validateOutlineMarkdown('[unsafe](javascript:alert(1))'));
});

test('legacy routes match by full breadcrumb and ambiguous matches fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-routes-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const docsRoot = path.join(root, 'docs', 'migrated');
  await mkdir(docsRoot, {recursive: true});
  const document = (slug, body) => [
    '---',
    'title: "成员"',
    `slug: "${slug}"`,
    '---',
    body,
    '',
  ].join('\n');
  await writeFile(path.join(docsRoot, 'one.mdx'), document('/product-guides/form/member', 'One'));
  await writeFile(path.join(docsRoot, 'two.mdx'), document('/product-guides/form/member-2', 'Two'));
  const sidebarFile = path.join(root, 'sidebars.ts');
  await writeFile(
    sidebarFile,
    [
      "import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';",
      'const sidebars: SidebarsConfig = {"helpCenterSidebar":[{"type":"category","label":"产品指南","items":[{"type":"category","label":"表单","items":["migrated/one","migrated/two"]}]}]};',
      'export default sidebars;',
    ].join('\n'),
  );
  const legacyRoutes = await readLegacyRoutes({docsRoot, sidebarFile});
  const outlineDocument = {
    id: 'outline-1',
    urlId: 'MemberOne',
    title: '成员',
    parents: ['产品指南', '表单'],
  };
  const assignment = assignDocumentRoutes([outlineDocument], legacyRoutes, {
    version: 1,
    documents: {},
  });
  assert.equal(assignment.conflicts.length, 1);
  assert.equal(assignment.documents[0].slug, undefined);

  const mapped = assignDocumentRoutes([outlineDocument], legacyRoutes, {
    version: 1,
    documents: {'outline-1': {slug: '/product-guides/form/member'}},
  });
  assert.equal(mapped.conflicts.length, 0);
  assert.equal(mapped.documents[0].routeSource, 'route-map');
});

test('new documents receive a stable urlId route and parent documents link from the sidebar', () => {
  const document = {
    id: '0198acbd-0000-0000-0000-000000000001',
    urlId: 'AbC123',
    title: 'New page',
    parents: [],
  };
  const assignment = assignDocumentRoutes([document], [], {version: 1, documents: {}});
  assert.equal(assignment.documents[0].slug, '/outline/abc123');
  const sidebar = serializeGeneratedSidebar([
    {...document, children: [{...document, id: 'child-id', title: 'Child', children: []}]},
  ]);
  assert.match(sidebar, /"link": \{/);
  assert.match(sidebar, /"id": "generated\/0198acbd-0000-0000-0000-000000000001"/);
});

test('failed MDX validation leaves the previous generated output intact', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-output-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'docs', 'generated'), {recursive: true});
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  await writeFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'old');
  await writeFile(path.join(root, 'sidebars.generated.ts'), 'old sidebar');
  const tree = [{id: docIdOne, title: 'Broken', children: []}];
  const document = {
    id: docIdOne,
    urlId: 'broken',
    title: 'Broken',
    text: '{broken',
    parents: [],
    slug: '/outline/broken',
    routeSource: 'outline-id',
  };

  await assert.rejects(
    generateOutlineOutput({
      cwd: root,
      snapshot: {collection: {id: 'collection', name: '售后知识库'}, tree},
      assignedDocuments: [document],
      baseUrl,
    }),
  );
  assert.equal(await readFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, 'sidebars.generated.ts'), 'utf8'), 'old sidebar');
});

test('successful generation replaces the snapshot without creating local media', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-success-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  const tree = [{id: docIdOne, title: 'Guide', url: '/doc/guide-one', children: []}];
  const document = {
    id: docIdOne,
    urlId: 'one',
    url: '/doc/guide-one',
    title: 'Guide',
    text: 'Hello\n\n![Image](/api/attachments.redirect?id=image)',
    updatedAt: '2026-09-09T00:00:00.000Z',
    parents: [],
    slug: '/outline/one',
    routeSource: 'outline-id',
  };
  const report = await generateOutlineOutput({
    cwd: root,
    snapshot: {collection: {id: 'collection', name: '售后知识库'}, tree},
    assignedDocuments: [document],
    baseUrl,
  });

  const output = await readFile(path.join(root, 'docs', 'generated', `${docIdOne}.mdx`), 'utf8');
  assert.match(output, /source: "outline"/);
  assert.match(output, /https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=image/);
  assert.equal(report.media, 'remote');
  await assert.rejects(access(path.join(root, 'static')));
});

test('report staging failure preserves the previous generated snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-report-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'docs', 'generated'), {recursive: true});
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  await writeFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'old');
  await writeFile(path.join(root, 'sidebars.generated.ts'), 'old sidebar');
  const document = {
    id: docIdOne,
    urlId: 'one',
    title: 'Guide',
    text: 'Safe content',
    parents: [],
    slug: '/outline/one',
    routeSource: 'outline-id',
  };

  await assert.rejects(
    generateOutlineOutput({
      cwd: root,
      snapshot: {
        collection: {id: 'collection', name: '售后知识库'},
        tree: [{id: docIdOne, title: 'Guide', children: []}],
      },
      assignedDocuments: [document],
      baseUrl,
      writeFileImpl: async (filePath, value) => {
        if (filePath.endsWith('outline-sync-report.json')) throw new Error('report failed');
        await writeFile(filePath, value);
      },
    }),
    /report failed/,
  );
  assert.equal(await readFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, 'sidebars.generated.ts'), 'utf8'), 'old sidebar');
});

test('swap failure rolls back documents, sidebar, and report', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-swap-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const stagedRoot = path.join(root, '.tmp', 'stage');
  const stagedDocs = path.join(stagedRoot, 'generated');
  const stagedSidebar = path.join(stagedRoot, 'sidebars.generated.ts');
  const stagedReport = path.join(stagedRoot, 'outline-sync-report.json');
  await mkdir(path.join(root, 'docs', 'generated'), {recursive: true});
  await mkdir(stagedDocs, {recursive: true});
  await writeFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'old');
  await writeFile(path.join(root, 'sidebars.generated.ts'), 'old sidebar');
  await writeFile(path.join(root, '.tmp', 'outline-sync-report.json'), 'old report');
  await writeFile(path.join(stagedDocs, 'new.mdx'), 'new');
  await writeFile(stagedSidebar, 'new sidebar');
  await writeFile(stagedReport, 'new report');
  let injected = false;

  await assert.rejects(
    replaceGeneratedOutput({
      cwd: root,
      stagedDocs,
      stagedSidebar,
      stagedReport,
      operations: {
        rename: async (source, target) => {
          if (!injected && source === stagedSidebar) {
            injected = true;
            throw new Error('rename failed');
          }
          await fsRename(source, target);
        },
        rm,
      },
    }),
    /rename failed/,
  );
  assert.equal(await readFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, 'sidebars.generated.ts'), 'utf8'), 'old sidebar');
  assert.equal(await readFile(path.join(root, '.tmp', 'outline-sync-report.json'), 'utf8'), 'old report');
  assert.equal(
    (await readdir(path.join(root, '.tmp'))).some((name) => name.startsWith('outline-backup-')),
    false,
  );
});
