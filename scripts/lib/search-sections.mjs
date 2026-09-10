import GithubSlugger from 'github-slugger';

function parseExplicitHeadingId(value) {
  const match = String(value).match(/\s*\{#([^{}]+)\}\s*$/);
  if (!match) return {text: String(value), id: ''};
  return {
    text: String(value).slice(0, match.index),
    id: match[1].trim(),
  };
}

function decodeNumericCharacterReferences(value) {
  return String(value).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (reference, hex, decimal) => {
    const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : reference;
  });
}

function getHeadingText(value) {
  return decodeNumericCharacterReferences(value)
    .replace(/\s+#+\s*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
}

function normalizeHeadingForComparison(value) {
  return String(value).toLocaleLowerCase().replace(/[\s\u3000]+/g, '').trim();
}

export function extractSearchSections(body, documentTitle = '') {
  const lines = String(body).split('\n');
  const headings = [];
  const slugger = new GithubSlugger();
  let codeFence;

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      codeFence = codeFence === marker ? undefined : codeFence ?? marker;
      return;
    }
    if (codeFence) return;

    const match = line.match(/^(#{1,6})(?!#)\s+(.+?)\s*$/);
    if (!match) return;
    const parsed = parseExplicitHeadingId(match[2]);
    const headingText = getHeadingText(parsed.text);
    const title = headingText.trim();
    if (!title) return;
    headings.push({
      level: match[1].length,
      title,
      slug: parsed.id || slugger.slug(headingText),
      lineIndex,
    });
  });

  const normalizedDocumentTitle = normalizeHeadingForComparison(documentTitle);

  return headings
    .map((heading, index) => {
      const nextHeading = headings[index + 1];
      return {
        ...heading,
        body: lines.slice(heading.lineIndex + 1, nextHeading?.lineIndex ?? lines.length)
          .join('\n')
          .trim(),
      };
    })
    .filter(
      (section, index) =>
        !(
          index === 0 &&
          section.level === 1 &&
          normalizedDocumentTitle &&
          normalizeHeadingForComparison(section.title) === normalizedDocumentTitle
        ),
    );
}
