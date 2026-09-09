import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {Transform, Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {getContentPaths} from './lib/content-source.mjs';

const cwd = process.cwd();
const {docsRoot, source: contentSource} = getContentPaths(cwd);
const assetsRoot = path.join(cwd, 'static', 'doc-assets');
const manifestFile = path.join(cwd, 'data', 'doc-assets.json');
const reportFile = path.join(cwd, 'data', 'doc-assets-report.json');
const probeFile = path.join(cwd, '.tmp', 'doc-assets-probe.json');
const concurrency = Number.parseInt(process.env.ASSET_CONCURRENCY ?? '16', 10);
const maxAssetBytes = 95 * 1024 * 1024;
const maxRepositoryMigrationBytes = 1024 * 1024 * 1024;
const imagePattern = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
const referrers = {
  none: null,
  site: 'https://help-center.qingflow.com/',
  yuque: 'https://www.yuque.com/',
};
const noReferrerHosts = new Set(['cdn.nlark.com', 'www.yuque.com']);

const contentTypeExtensions = new Map([
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/svg+xml', 'svg'],
  ['image/webp', 'webp'],
]);

async function getMarkdownFiles() {
  return (await readdir(docsRoot))
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => path.join(docsRoot, name))
    .sort();
}

async function collectExternalImages() {
  const files = await getMarkdownFiles();
  const references = new Map();

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    for (const match of source.matchAll(imagePattern)) {
      const url = match[1] ?? match[2];
      if (!/^https?:\/\//i.test(url)) {
        continue;
      }
      const fileReferences = references.get(url) ?? new Set();
      fileReferences.add(filePath);
      references.set(url, fileReferences);
    }
  }

  return {files, references};
}

function hashUrl(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

function normalizeContentType(value) {
  return value?.split(';')[0].trim().toLowerCase() ?? '';
}

function extensionFor(url, contentType) {
  const mapped = contentTypeExtensions.get(normalizeContentType(contentType));
  if (mapped) {
    return mapped;
  }

  const extension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(extension) ? extension : 'bin';
}

function localAssetPath(url, contentType) {
  const hash = hashUrl(url);
  return `/doc-assets/${hash.slice(0, 2)}/${hash}.${extensionFor(url, contentType)}`;
}

function diskPathFor(localPath) {
  return path.join(cwd, 'static', localPath.replace(/^\//, ''));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchWithRetry(url, options, attempts = 3) {
  const referrerMode = options.referrerMode ?? 'browser';
  if (referrerMode !== 'browser' && !(referrerMode in referrers)) {
    throw new Error(
      `Unknown asset referrer mode: ${referrerMode}. Expected browser, none, site, or yuque.`,
    );
  }

  const referrer =
    referrerMode === 'browser'
      ? noReferrerHosts.has(new URL(url).hostname)
        ? null
        : referrers.site
      : referrers[referrerMode];
  const headers = {
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'User-Agent': 'Qingflow-Help-Center-Asset-Migrator/1.0',
  };
  if (referrer) {
    headers.Referer = referrer;
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeout),
        method: options.method,
        headers,
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  }
  throw lastError;
}

async function mapConcurrent(items, worker, limit = concurrency, onBatch) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
    await onBatch?.(results.length, items.length);
  }
  return results;
}

async function probeAssets() {
  const {references} = await collectExternalImages();
  const urls = [...references.keys()];
  const startedAt = new Date().toISOString();
  const referrerMode = process.env.ASSET_REFERRER_MODE ?? 'browser';
  const results = await mapConcurrent(
    urls,
    async (url) => {
      try {
        const response = await fetchWithRetry(
          url,
          {method: 'HEAD', timeout: 30_000, referrerMode},
          2,
        );
        const contentLength = Number.parseInt(
          response.headers.get('content-length') ?? '',
          10,
        );
        return {
          url,
          ok: response.ok,
          status: response.status,
          contentType: normalizeContentType(response.headers.get('content-type')),
          size: Number.isFinite(contentLength) ? contentLength : null,
        };
      } catch (error) {
        return {url, ok: false, error: error.message};
      }
    },
    concurrency,
    (completed, total) => console.log(`Probed ${completed}/${total} assets`),
  );
  const knownSize = results.reduce((sum, result) => sum + (result.size ?? 0), 0);
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    referrerMode,
    total: results.length,
    available: results.filter((result) => result.ok).length,
    unavailable: results.filter((result) => !result.ok).length,
    withKnownSize: results.filter((result) => result.size != null).length,
    knownSize,
    oversized: results.filter((result) => (result.size ?? 0) > maxAssetBytes),
    failures: results.filter((result) => !result.ok),
    assets: results,
  };
  await writeJson(probeFile, report);
  console.log(
    `Probe complete: ${report.available}/${report.total} available, ${report.withKnownSize} report a size, ${(knownSize / 1024 / 1024).toFixed(1)} MiB known total`,
  );
}

async function existingManifestEntry(url, entry) {
  if (!entry?.localPath || !entry?.size) {
    return null;
  }
  try {
    const fileStat = await stat(diskPathFor(entry.localPath));
    return fileStat.size === entry.size ? entry : null;
  } catch {
    return null;
  }
}

async function downloadAsset(url, identityUrl = url) {
  const response = await fetchWithRetry(url, {
    method: 'GET',
    timeout: 120_000,
    referrerMode: 'yuque',
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  const sourceExtension = extensionFor(url, contentType);
  if (!contentType.startsWith('image/') && sourceExtension === 'bin') {
    throw new Error(`Unexpected content type: ${contentType || 'missing'}`);
  }

  const contentLength = Number.parseInt(
    response.headers.get('content-length') ?? '',
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) {
    throw new Error(`Asset exceeds 95 MiB: ${contentLength} bytes`);
  }

  const localPath = localAssetPath(identityUrl, contentType);
  const outputPath = diskPathFor(localPath);
  const temporaryPath = `${outputPath}.part`;
  await mkdir(path.dirname(outputPath), {recursive: true});

  let size = 0;
  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxAssetBytes) {
        callback(new Error(`Asset exceeds 95 MiB while downloading: ${size} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      sizeGuard,
      createWriteStream(temporaryPath),
    );
    if (size === 0) {
      throw new Error('Downloaded an empty file');
    }
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, {force: true});
    throw error;
  }

  return {localPath, size, contentType};
}

async function migrateAssets() {
  const {files, references} = await collectExternalImages();
  const urls = [...references.keys()];
  const probe = await readJson(probeFile, null);
  if (
    probe?.knownSize > maxRepositoryMigrationBytes &&
    process.env.ASSET_ALLOW_LARGE_DOWNLOAD !== 'true'
  ) {
    throw new Error(
      `Refusing to add ${(probe.knownSize / 1024 / 1024).toFixed(1)} MiB to the repository. Set ASSET_ALLOW_LARGE_DOWNLOAD=true only when external asset storage is configured.`,
    );
  }
  const manifest = await readJson(manifestFile, {});
  const failures = [];
  let downloaded = 0;
  let reused = 0;

  await mapConcurrent(
    urls,
    async (url) => {
      const existing = await existingManifestEntry(url, manifest[url]);
      if (existing) {
        reused += 1;
        return;
      }

      try {
        manifest[url] = await downloadAsset(url);
        downloaded += 1;
      } catch (error) {
        failures.push({url, error: error.message});
      }
    },
    concurrency,
    async (completed, total) => {
      await writeJson(manifestFile, manifest);
      console.log(
        `Processed ${completed}/${total} assets (${downloaded} downloaded, ${reused} reused, ${failures.length} failed)`,
      );
    },
  );

  let changedDocuments = 0;
  let replacedReferences = 0;
  for (const filePath of files) {
    let source = await readFile(filePath, 'utf8');
    const original = source;
    for (const match of original.matchAll(imagePattern)) {
      const url = match[1] ?? match[2];
      const localPath = manifest[url]?.localPath;
      if (localPath && source.includes(url)) {
        source = source.replaceAll(url, localPath);
        replacedReferences += 1;
      }
    }
    if (source !== original) {
      await writeFile(filePath, source);
      changedDocuments += 1;
    }
  }

  const report = {
    completedAt: new Date().toISOString(),
    uniqueExternalAssets: urls.length,
    downloaded,
    reused,
    failed: failures.length,
    changedDocuments,
    replacedReferences,
    totalLocalBytes: Object.values(manifest).reduce(
      (sum, entry) => sum + (entry.size ?? 0),
      0,
    ),
    failures,
  };
  await writeJson(reportFile, report);
  console.log(
    `Migration complete: ${replacedReferences} references in ${changedDocuments} documents localized; ${failures.length} assets failed`,
  );
  if (failures.length > 0) {
    process.exitCode = 2;
  }
}

async function recoverAssets(mappingFile) {
  const manifest = await readJson(manifestFile, {});
  const sourceMap = mappingFile
    ? await readJson(path.resolve(cwd, mappingFile), null)
    : Object.fromEntries(
        Object.entries(manifest)
          .filter(([, entry]) => entry.recoveryUrl)
          .map(([url, entry]) => [url, entry.recoveryUrl]),
      );
  if (!sourceMap || Array.isArray(sourceMap)) {
    throw new Error('Recovery mapping must be an object of original URL to recovery URL');
  }
  if (Object.keys(sourceMap).length === 0) {
    throw new Error('No recovery sources are available');
  }

  const {files} = await collectExternalImages();
  const entries = Object.entries(sourceMap);
  const failures = [];
  let downloaded = 0;
  let reused = 0;

  await mapConcurrent(
    entries,
    async ([originalUrl, recoveryUrl]) => {
      const existing = await existingManifestEntry(originalUrl, manifest[originalUrl]);
      if (existing) {
        manifest[originalUrl] = {...existing, recoveryUrl};
        reused += 1;
        return;
      }
      try {
        manifest[originalUrl] = {
          ...(await downloadAsset(recoveryUrl, originalUrl)),
          recoveryUrl,
        };
        downloaded += 1;
      } catch (error) {
        failures.push({url: originalUrl, recoveryUrl, error: error.message});
      }
    },
    concurrency,
    async (completed, total) => {
      await writeJson(manifestFile, manifest);
      console.log(
        `Recovered ${completed}/${total} assets (${downloaded} downloaded, ${reused} reused, ${failures.length} failed)`,
      );
    },
  );

  let changedDocuments = 0;
  let replacedReferences = 0;
  for (const filePath of files) {
    let source = await readFile(filePath, 'utf8');
    const original = source;
    for (const originalUrl of Object.keys(sourceMap)) {
      const localPath = manifest[originalUrl]?.localPath;
      if (!localPath || !source.includes(originalUrl)) {
        continue;
      }
      const occurrences = source.split(originalUrl).length - 1;
      source = source.replaceAll(originalUrl, localPath);
      replacedReferences += occurrences;
    }
    if (source !== original) {
      await writeFile(filePath, source);
      changedDocuments += 1;
    }
  }

  const report = {
    completedAt: new Date().toISOString(),
    recoverySources: entries.length,
    downloaded,
    reused,
    failed: failures.length,
    changedDocuments,
    replacedReferences,
    recoveredBytes: entries.reduce(
      (sum, [url]) => sum + (manifest[url]?.size ?? 0),
      0,
    ),
    failures,
  };
  await writeJson(reportFile, report);
  console.log(
    `Recovery complete: ${replacedReferences} references in ${changedDocuments} documents localized; ${failures.length} assets failed`,
  );
  if (failures.length > 0) {
    process.exitCode = 2;
  }
}

async function checkAssets() {
  const {files, references} = await collectExternalImages();
  const missing = [];
  const knownBroken =
    contentSource === 'legacy'
      ? [...references.keys()].filter((url) => new URL(url).hostname === 'hc.qingflow.com')
      : [];
  let localReferences = 0;

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    for (const match of source.matchAll(imagePattern)) {
      const url = match[1] ?? match[2];
      if (!url.startsWith('/doc-assets/')) {
        continue;
      }
      localReferences += 1;
      try {
        await access(diskPathFor(url));
      } catch {
        missing.push({file: path.relative(cwd, filePath), url});
      }
    }
  }

  if (knownBroken.length > 0 || missing.length > 0) {
    throw new Error(
      `${knownBroken.length} known-broken external image URLs and ${missing.length} missing local assets remain`,
    );
  }
  console.log(
    `Validated ${localReferences} local image references across ${files.length} documents; ${references.size} external image URLs remain`,
  );
}

const command = process.argv[2] ?? 'check';
if (contentSource !== 'legacy' && command !== 'check') {
  throw new Error(
    `Asset ${command} is disabled for Outline content because remote media must not be downloaded.`,
  );
}
if (command === 'probe') {
  await probeAssets();
} else if (command === 'migrate') {
  await migrateAssets();
} else if (command === 'recover') {
  await recoverAssets(process.argv[3]);
} else if (command === 'check') {
  await checkAssets();
} else {
  throw new Error(`Unknown command: ${command}`);
}
