import path from 'node:path';

const supportedSources = new Set(['outline', 'legacy']);

export function getContentSource(environment = process.env) {
  const source = (environment.DOCS_CONTENT_SOURCE ?? 'outline').trim().toLowerCase();
  if (!supportedSources.has(source)) {
    throw new Error(
      `Unsupported DOCS_CONTENT_SOURCE: ${source}. Expected "outline" or "legacy".`,
    );
  }
  return source;
}

export function getContentPaths(cwd = process.cwd(), environment = process.env) {
  const source = getContentSource(environment);
  const docsBaseRoot = path.join(cwd, 'docs');
  const directoryName = source === 'legacy' ? 'migrated' : 'generated';

  return {
    source,
    directoryName,
    docsBaseRoot,
    docsRoot: path.join(docsBaseRoot, directoryName),
    sidebarPath: source === 'legacy' ? './sidebars.ts' : './sidebars.generated.ts',
  };
}
