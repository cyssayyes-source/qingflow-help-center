import assert from 'node:assert/strict';
import test from 'node:test';
import {buildBreadcrumb} from '../scripts/lib/search-breadcrumb.mjs';

test('uses the Outline FAQ label instead of repeating the synthetic route label', () => {
  assert.equal(
    buildBreadcrumb(
      '常见问题-faq',
      ['常见问题（FAQ）'],
      '一句话QA',
      '导入数据进入流程会触发代码块、Q-Linker么？',
    ),
    '常见问题（FAQ） / 一句话QA / 导入数据进入流程会触发代码块、Q-Linker么？',
  );
});

test('still removes ordinary adjacent duplicate breadcrumb labels', () => {
  assert.equal(
    buildBreadcrumb('帮助文档', ['帮助文档', '数据管理'], '导入数据'),
    '帮助文档 / 数据管理 / 导入数据',
  );
});
