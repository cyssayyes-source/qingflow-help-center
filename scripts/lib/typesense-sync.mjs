const safeDocumentIdPattern = /^[A-Za-z0-9_-]+$/;
const deleteBatchSize = 100;

export function buildCollectionSchema(collection) {
  return {
    name: collection,
    enable_nested_fields: false,
    fields: [
      {name: 'doc_id', type: 'string', facet: true},
      {name: 'record_type', type: 'string', facet: true},
      {name: 'title', type: 'string'},
      {name: 'section', type: 'string', facet: true},
      {name: 'breadcrumb', type: 'string'},
      {name: 'keywords', type: 'string[]', facet: true, optional: true},
      {name: 'content', type: 'string'},
      {name: 'url', type: 'string', facet: true},
      {name: 'product', type: 'string', facet: true},
      {name: 'business_priority', type: 'int32', optional: true},
      {name: 'version', type: 'string', facet: true},
      {name: 'language', type: 'string', facet: true},
      {name: 'tags', type: 'string[]', facet: true, optional: true},
      {name: 'updated_at', type: 'string', optional: true},
      {name: 'updated_at_ts', type: 'int64', optional: true},
    ],
    default_sorting_field: 'updated_at_ts',
  };
}

function normalizeHost(host) {
  const normalized = String(host ?? '').trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('TYPESENSE_HOST is required.');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('TYPESENSE_HOST must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TYPESENSE_HOST must be an absolute HTTP(S) URL.');
  }
  return normalized;
}

function collectionUrl(host, collection, suffix = '') {
  return `${host}/collections/${encodeURIComponent(collection)}${suffix}`;
}

function requestHeaders(apiKey, contentType) {
  return {
    ...(contentType ? {'Content-Type': contentType} : {}),
    'X-TYPESENSE-API-KEY': apiKey,
  };
}

async function responseDetails(response) {
  const details = (await response.text()).trim();
  return details ? ` ${details.slice(0, 500)}` : '';
}

function parseJsonLines(value, context) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${context} returned invalid JSON on line ${index + 1}.`);
    }
  });
}

export function validateSearchRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Search records artifact must be a non-empty JSON array.');
  }

  const ids = new Set();
  for (const record of records) {
    const id = record?.id;
    if (typeof id !== 'string' || !safeDocumentIdPattern.test(id)) {
      throw new Error(`Search record has an unsafe id: ${JSON.stringify(id)}.`);
    }
    if (ids.has(id)) throw new Error(`Search record id is duplicated: ${id}.`);
    ids.add(id);
  }
  return ids;
}

export async function ensureTypesenseCollection({
  host,
  apiKey,
  collection,
  fetchImpl = fetch,
  logger = console,
}) {
  const schema = buildCollectionSchema(collection);
  const response = await fetchImpl(collectionUrl(host, collection), {
    headers: requestHeaders(apiKey),
  });

  if (response.ok) {
    const existingSchema = await response.json();
    const existingFields = new Set(
      (existingSchema.fields ?? []).map((field) => field.name),
    );
    const missingFields = schema.fields.filter((field) => !existingFields.has(field.name));
    if (missingFields.length === 0) return;

    const alterResponse = await fetchImpl(collectionUrl(host, collection), {
      method: 'PATCH',
      headers: requestHeaders(apiKey, 'application/json'),
      body: JSON.stringify({fields: missingFields}),
    });
    if (!alterResponse.ok) {
      throw new Error(
        `Failed to update collection schema: ${alterResponse.status}${await responseDetails(alterResponse)}`,
      );
    }
    logger.log(`Added ${missingFields.length} fields to ${collection}`);
    return;
  }

  if (response.status !== 404) {
    throw new Error(
      `Failed to verify collection: ${response.status}${await responseDetails(response)}`,
    );
  }

  const createResponse = await fetchImpl(`${host}/collections`, {
    method: 'POST',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify(schema),
  });
  if (!createResponse.ok) {
    throw new Error(
      `Failed to create collection: ${createResponse.status}${await responseDetails(createResponse)}`,
    );
  }
}

export async function importTypesenseDocuments({
  host,
  apiKey,
  collection,
  records,
  fetchImpl = fetch,
  logger = console,
}) {
  const payload = records.map((record) => JSON.stringify(record)).join('\n');
  const response = await fetchImpl(
    collectionUrl(host, collection, '/documents/import?action=upsert'),
    {
      method: 'POST',
      headers: requestHeaders(apiKey, 'text/plain'),
      body: payload,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to import documents: ${response.status}${await responseDetails(response)}`,
    );
  }

  const results = parseJsonLines(await response.text(), 'Typesense import');
  if (results.length !== records.length) {
    throw new Error(
      `Typesense import returned ${results.length} results for ${records.length} records.`,
    );
  }
  const failedIndex = results.findIndex((result) => result?.success !== true);
  if (failedIndex !== -1) {
    const reason = String(results[failedIndex]?.error ?? 'unknown error').slice(0, 300);
    throw new Error(`Typesense rejected search record ${failedIndex + 1}: ${reason}`);
  }
  logger.log(`Imported ${records.length} records into ${collection}`);
}

export async function exportTypesenseDocumentIds({
  host,
  apiKey,
  collection,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    collectionUrl(host, collection, '/documents/export?include_fields=id'),
    {headers: requestHeaders(apiKey)},
  );
  if (!response.ok) {
    throw new Error(
      `Failed to export document ids: ${response.status}${await responseDetails(response)}`,
    );
  }

  const documents = parseJsonLines(await response.text(), 'Typesense export');
  return documents.map((document) => {
    const id = document?.id;
    if (typeof id !== 'string' || !safeDocumentIdPattern.test(id)) {
      throw new Error(`Typesense contains an unsafe document id: ${JSON.stringify(id)}.`);
    }
    return id;
  });
}

export async function deleteTypesenseDocuments({
  host,
  apiKey,
  collection,
  ids,
  fetchImpl = fetch,
  logger = console,
}) {
  for (let offset = 0; offset < ids.length; offset += deleteBatchSize) {
    const batch = ids.slice(offset, offset + deleteBatchSize);
    const params = new URLSearchParams({
      filter_by: `id:=[${batch.join(',')}]`,
      batch_size: String(batch.length),
    });
    const response = await fetchImpl(
      collectionUrl(host, collection, `/documents?${params}`),
      {
        method: 'DELETE',
        headers: requestHeaders(apiKey),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to delete stale documents: ${response.status}${await responseDetails(response)}`,
      );
    }
    const result = await response.json();
    if (result?.num_deleted !== batch.length) {
      throw new Error(
        `Typesense deleted ${result?.num_deleted ?? 0} of ${batch.length} stale documents.`,
      );
    }
  }
  if (ids.length > 0) logger.log(`Deleted ${ids.length} stale records from ${collection}`);
}

export async function syncTypesense({
  host,
  apiKey,
  collection = 'qingflow_help_docs',
  records,
  fetchImpl = fetch,
  logger = console,
}) {
  const normalizedHost = normalizeHost(host);
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required.');
  }
  if (!String(collection).trim()) throw new Error('TYPESENSE_COLLECTION must not be empty.');

  const currentIds = validateSearchRecords(records);
  const options = {
    host: normalizedHost,
    apiKey,
    collection,
    fetchImpl,
    logger,
  };
  await ensureTypesenseCollection(options);
  await importTypesenseDocuments({...options, records});
  const indexedIds = await exportTypesenseDocumentIds(options);
  const staleIds = [...new Set(indexedIds)].filter((id) => !currentIds.has(id));
  await deleteTypesenseDocuments({...options, ids: staleIds});
  return {imported: records.length, deleted: staleIds.length};
}
