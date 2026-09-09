import assert from 'node:assert/strict';
import test from 'node:test';
import {syncTypesense} from '../scripts/lib/typesense-sync.mjs';

const host = 'https://typesense.example.com';
const apiKey = 'admin-key';
const collection = 'help';
const records = [
  {
    id: 'current-id',
    doc_id: 'current-id',
    title: 'Current',
  },
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

test('Typesense sync imports the snapshot before pruning only stale ids', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    const method = options.method ?? 'GET';
    if (url === `${host}/collections/${collection}` && method === 'GET') {
      return jsonResponse({message: 'not found'}, 404);
    }
    if (url === `${host}/collections` && method === 'POST') {
      return jsonResponse({name: collection}, 201);
    }
    if (url.endsWith('/documents/import?action=upsert')) {
      return new Response('{"success":true}\n');
    }
    if (url.endsWith('/documents/export?include_fields=id')) {
      return new Response('{"id":"current-id"}\n{"id":"removed-id"}\n');
    }
    if (url.includes('/documents?') && method === 'DELETE') {
      return jsonResponse({num_deleted: 1});
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await syncTypesense({
    host: `${host}/`,
    apiKey,
    collection,
    records,
    fetchImpl,
    logger: {log() {}},
  });

  assert.deepEqual(result, {imported: 1, deleted: 1});
  const importIndex = requests.findIndex(({url}) => url.includes('/documents/import'));
  const exportIndex = requests.findIndex(({url}) => url.includes('/documents/export'));
  const deleteRequest = requests.find(({options}) => options.method === 'DELETE');
  assert.ok(importIndex !== -1 && exportIndex > importIndex);
  assert.ok(deleteRequest);
  const deleteUrl = new URL(deleteRequest.url);
  assert.equal(deleteUrl.searchParams.get('filter_by'), 'id:=[removed-id]');
  assert.doesNotMatch(deleteUrl.searchParams.get('filter_by'), /current-id/);
  assert.equal(deleteRequest.options.headers['X-TYPESENSE-API-KEY'], apiKey);
});

test('Typesense sync never prunes records after a partial import failure', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    if (url.endsWith(`/collections/${collection}`) && !options.method) {
      return jsonResponse({fields: []});
    }
    if (options.method === 'PATCH') return jsonResponse({});
    if (url.endsWith('/documents/import?action=upsert')) {
      return new Response('{"success":false,"error":"invalid record"}\n');
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  };

  await assert.rejects(
    syncTypesense({host, apiKey, collection, records, fetchImpl, logger: {log() {}}}),
    /rejected search record 1/,
  );
  assert.equal(requests.some(({url}) => url.includes('/documents/export')), false);
  assert.equal(requests.some(({options}) => options.method === 'DELETE'), false);
});
