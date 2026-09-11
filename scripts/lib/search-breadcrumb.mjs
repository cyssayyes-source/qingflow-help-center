function normalizeBreadcrumbLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(]faq[)）]/g, '-faq')
    .trim();
}

export function buildBreadcrumb(category, navigationPath, title, sectionTitle) {
  const parts = [category, ...navigationPath, title, sectionTitle]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  const breadcrumb = [];

  parts.forEach((part) => {
    const previousIndex = breadcrumb.length - 1;
    const previous = breadcrumb[previousIndex];

    if (normalizeBreadcrumbLabel(previous) === normalizeBreadcrumbLabel(part)) {
      // Prefer the later label because Outline's navigation path is the
      // authoritative display name, while the route category is synthetic.
      breadcrumb[previousIndex] = part;
      return;
    }

    breadcrumb.push(part);
  });

  return breadcrumb.join(' / ');
}
