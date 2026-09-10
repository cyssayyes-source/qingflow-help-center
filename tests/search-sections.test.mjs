import assert from 'node:assert/strict';
import test from 'node:test';
import {extractSearchSections} from '../scripts/lib/search-sections.mjs';

test('search section anchors include first-level subheadings and match Docusaurus slugs', () => {
  const sections = extractSearchSections([
    '# 重复标题',
    '# 一级子标题',
    'Top-level section',
    '## 重复标题',
    'First section',
    '## 重复标题',
    'Second section',
    '## 第三步：配置Q- Source主动模式',
    'Q-Source section',
    '## [链接标题](https://example.com) {#Custom-Anchor}',
    'Custom section',
    '## 数组 &#123;"a":1&#125;',
    'Entity section',
    '```md',
    '## 代码块标题',
    '```',
  ].join('\n'), '重复标题');

  assert.deepEqual(
    sections.map(({title, slug}) => ({title, slug})),
    [
      {title: '一级子标题', slug: '一级子标题'},
      {title: '重复标题', slug: '重复标题-1'},
      {title: '重复标题', slug: '重复标题-2'},
      {title: '第三步：配置Q- Source主动模式', slug: '第三步配置q--source主动模式'},
      {title: '链接标题', slug: 'Custom-Anchor'},
      {title: '数组 {"a":1}', slug: '数组-a1'},
    ],
  );
  assert.equal(sections[0].body, 'Top-level section');
  assert.equal(sections[1].body, 'First section');
  assert.equal(sections[2].body, 'Second section');
  assert.equal(sections.some(({title}) => title === '代码块标题'), false);
});
