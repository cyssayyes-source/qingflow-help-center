import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {getContentPaths} from './lib/content-source.mjs';

const {docsRoot} = getContentPaths();

async function getMarkdownFiles(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) return getMarkdownFiles(filePath);
      return entry.isFile() && /\.mdx?$/i.test(entry.name) ? [filePath] : [];
    }),
  );
  return nested.flat();
}

function normalizeSource(source) {
  let inCodeBlock = false;
  let changed = false;
  const lines = source.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) return line;

    const normalized = line
      .replace(/<img\b([^>]*?)(?<!\/)\s*>/g, '<img$1 />')
      .replace(
        /<([A-Za-z][\w:-]*)\b([^>]*?)style="color:\s*([^";]+);"/g,
        (_match, tag, attributes, color) =>
          `<${tag}${attributes}style={{color: '${color.trim()}'}}`,
      );
    changed ||= normalized !== line;
    return normalized;
  });

  return {source: lines.join('\n'), changed};
}

async function main() {
  const files = await getMarkdownFiles(docsRoot);
  let changedFiles = 0;

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    const normalized = normalizeSource(source);
    if (!normalized.changed) continue;
    await writeFile(filePath, normalized.source);
    changedFiles += 1;
  }

  console.log(`Normalized MDX markup in ${changedFiles} documents`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
