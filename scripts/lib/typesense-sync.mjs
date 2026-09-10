import {createHash} from 'node:crypto';

const safeDocumentIdPattern = /^[A-Za-z0-9_-]+$/;
const deleteBatchSize = 100;

export function getTypesenseSynonymSetName(collection) {
  const value = String(collection ?? '').trim();
  if (!value) throw new Error('TYPESENSE_COLLECTION must not be empty.');
  return `${value}-synonyms`;
}

export function buildCollectionSchema(collection, {synonymSetName} = {}) {
  return {
    name: collection,
    enable_nested_fields: false,
    fields: [
      {name: 'doc_id', type: 'string', facet: true},
      {name: 'record_type', type: 'string', facet: true},
      {name: 'title', type: 'string', locale: 'zh'},
      {name: 'document_title', type: 'string', optional: true, locale: 'zh'},
      {name: 'section', type: 'string', facet: true, locale: 'zh'},
      {name: 'breadcrumb', type: 'string', locale: 'zh'},
      {name: 'keywords', type: 'string[]', facet: true, optional: true, locale: 'zh'},
      {name: 'search_tokens', type: 'string[]', optional: true, locale: 'zh'},
      {name: 'content', type: 'string', locale: 'zh'},
      {name: 'url', type: 'string', facet: true},
      {name: 'product', type: 'string', facet: true},
      {name: 'business_priority', type: 'int32', optional: true},
      {name: 'version', type: 'string', facet: true},
      {name: 'language', type: 'string', facet: true},
      {name: 'tags', type: 'string[]', facet: true, optional: true, locale: 'zh'},
      {name: 'updated_at', type: 'string', optional: true},
      {name: 'updated_at_ts', type: 'int64'},
    ],
    default_sorting_field: 'updated_at_ts',
    ...(synonymSetName ? {synonym_sets: [synonymSetName]} : {}),
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

function synonymSetUrl(host, name) {
  return `${host}/synonym_sets/${encodeURIComponent(name)}`;
}

function normalizeSynonymTerms(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((term) => String(term ?? '').trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export function buildTypesenseSynonyms(groups) {
  if (!Array.isArray(groups)) return [];
  const seen = new Set();
  return groups.flatMap((group) => {
    const synonyms = normalizeSynonymTerms(group?.terms ?? group?.synonyms);
    if (synonyms.length < 2) return [];
    const key = synonyms.map((term) => term.toLowerCase()).join('\u0000');
    if (seen.has(key)) return [];
    seen.add(key);
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return [{id: `qingflow-${digest}`, synonyms}];
  });
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
    const existingFields = new Map(
      (existingSchema.fields ?? []).map((field) => [field.name, field]),
    );
    const missingFields = schema.fields.filter((field) => !existingFields.has(field.name));
    const localeChanges = schema.fields
      .filter((field) => existingFields.has(field.name) && field.locale)
      .filter((field) => existingFields.get(field.name)?.locale !== field.locale)
      .flatMap((field) => [{name: field.name, drop: true}, field]);
    const fields = [...missingFields, ...localeChanges];
    if (fields.length === 0) return;

    const alterResponse = await fetchImpl(collectionUrl(host, collection), {
      method: 'PATCH',
      headers: requestHeaders(apiKey, 'application/json'),
      body: JSON.stringify({fields}),
    });
    if (!alterResponse.ok) {
      throw new Error(
        `Failed to update collection schema: ${alterResponse.status}${await responseDetails(alterResponse)}`,
      );
    }
    logger.log(`Updated ${fields.length} Typesense schema fields in ${collection}`);
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

export async function ensureTypesenseSynonyms({
  host,
  apiKey,
  collection,
  synonymGroups,
  fetchImpl = fetch,
  logger = console,
}) {
  const synonymSetName = getTypesenseSynonymSetName(collection);
  const desired = buildTypesenseSynonyms(synonymGroups);
  const listResponse = await fetchImpl(synonymSetUrl(host, synonymSetName), {
    headers: requestHeaders(apiKey),
  });
  if (!listResponse.ok && listResponse.status !== 404) {
    throw new Error(
      `Failed to retrieve Typesense synonym set: ${listResponse.status}${await responseDetails(listResponse)}`,
    );
  }

  const existingSet = listResponse.status === 404 ? undefined : await listResponse.json();
  const existing = Array.isArray(existingSet?.items)
    ? existingSet.items.filter((item) => typeof item?.id === 'string')
    : [];
  const normalizeItems = (items) => items
    .map((item) => ({id: String(item.id), synonyms: normalizeSynonymTerms(item.synonyms)}))
    .sort((left, right) => left.id.localeCompare(right.id));
  const changed = JSON.stringify(normalizeItems(existing)) !== JSON.stringify(normalizeItems(desired));

  if (changed || listResponse.status === 404) {
    const response = await fetchImpl(synonymSetUrl(host, synonymSetName), {
      method: 'PUT',
      headers: requestHeaders(apiKey, 'application/json'),
      body: JSON.stringify({items: desired}),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to upsert Typesense synonym set: ${response.status}${await responseDetails(response)}`,
      );
    }
  }

  const collectionResponse = await fetchImpl(collectionUrl(host, collection), {
    method: 'PATCH',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify({synonym_sets: [synonymSetName]}),
  });
  if (!collectionResponse.ok) {
    throw new Error(
      `Failed to link Typesense synonym set: ${collectionResponse.status}${await responseDetails(collectionResponse)}`,
    );
  }

  const deleted = existing.filter(
    (item) => !desired.some((candidate) => candidate.id === item.id),
  ).length;
  const changedCount = changed || listResponse.status === 404 ? 1 : 0;
  if (changedCount > 0) logger.log(`Synchronized ${desired.length} Typesense synonyms in ${collection}`);
  return {
    setName: synonymSetName,
    synchronized: desired.length,
    changed: changedCount,
    deleted,
  };
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
  synonymGroups,
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
  if (synonymGroups !== undefined) {
    await ensureTypesenseSynonyms({...options, synonymGroups});
  }
  await importTypesenseDocuments({...options, records});
  const indexedIds = await exportTypesenseDocumentIds(options);
  const staleIds = [...new Set(indexedIds)].filter((id) => !currentIds.has(id));
  await deleteTypesenseDocuments({...options, ids: staleIds});
  return {imported: records.length, deleted: staleIds.length};
}

export async function createTypesenseSearchKey({
  host,
  apiKey,
  collection,
  description = 'Qingflow Help Center browser search',
  fetchImpl = fetch,
}) {
  const normalizedHost = normalizeHost(host);
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required to create a search key.');
  }
  if (!String(collection ?? '').trim()) {
    throw new Error('TYPESENSE_COLLECTION must not be empty.');
  }
  if (!String(description ?? '').trim()) {
    throw new Error('TYPESENSE_SEARCH_KEY_DESCRIPTION must not be empty.');
  }

  const response = await fetchImpl(`${normalizedHost}/keys`, {
    method: 'POST',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify({
      description: String(description).trim(),
      actions: ['documents:search'],
      collections: [String(collection).trim()],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create Typesense search key: ${response.status}${await responseDetails(response)}`,
    );
  }

  const result = await response.json();
  if (typeof result?.value !== 'string' || !result.value.trim()) {
    throw new Error('Typesense search key response did not include a key value.');
  }
  return result;
}
