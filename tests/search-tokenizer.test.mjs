import assert from 'node:assert/strict';
import test from 'node:test';
import {buildSearchTokens, tokenizeSearchText} from '../scripts/lib/search-tokenizer.mjs';

test('Chinese tokenizer preserves mixed-language terms and overlapping Chinese n-grams', () => {
  const tokens = tokenizeSearchText('导入 Markdown 文档并配置审批中心');
  assert.ok(tokens.includes('markdown'));
  assert.ok(tokens.includes('导入'));
  assert.ok(tokens.includes('文档'));
  assert.ok(tokens.includes('审批'));
  assert.ok(tokens.includes('中心'));
  assert.ok(tokens.includes('审批中'));
});

test('search token generation is deterministic across field values', () => {
  assert.deepEqual(
    buildSearchTokens(['Markdown 文档', '导入 Markdown 文档']),
    buildSearchTokens(['导入 Markdown 文档', 'Markdown 文档']),
  );
});
