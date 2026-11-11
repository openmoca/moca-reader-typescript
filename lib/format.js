// Text, JSON and SARIF renderings of diagnostics, shared by the CLIs.
import { CODES } from './codes.js';
import { countBySeverity } from './diagnostics.js';

const ORDER = { error: 0, warning: 1, info: 2 };

/**
 * @param {import('./diagnostics.js').Diagnostic[]} items
 * @param {{ color?: boolean }} [options]
 */
export function formatText(items, { color = false } = {}) {
  const paint = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const tone = { error: (s) => paint(31, s), warning: (s) => paint(33, s), info: (s) => paint(36, s) };
  if (items.length === 0) return paint(32, 'No findings.');
  const byFile = new Map();
  for (const d of items) {
    const key = d.file ?? '(package)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(d);
  }
  const lines = [];
  for (const [file, list] of byFile) {
    lines.push(paint(1, file));
    for (const d of [...list].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])) {
      lines.push(`  ${tone[d.severity](d.severity.toUpperCase())} ${d.code}  ${d.line ? `line ${d.line}: ` : ''}${d.message}`);
    }
  }
  const c = countBySeverity(items);
  lines.push('', `${c.error} error(s), ${c.warning} warning(s), ${c.info} info`);
  return lines.join('\n');
}

export function formatJson(items, extra = {}) {
  return JSON.stringify({ ...extra, diagnostics: items, summary: countBySeverity(items) }, null, 2);
}

export function formatSarif(items, { toolName = 'moca-lint' } = {}) {
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: toolName,
          informationUri: 'https://github.com/openmoca/moca-spec',
          rules: Object.entries(CODES).map(([id, v]) => ({ id, shortDescription: { text: v.summary } })),
        },
      },
      results: items.map((d) => ({
        ruleId: d.code,
        level: d.severity === 'info' ? 'note' : d.severity,
        message: { text: d.message },
        locations: d.file
          ? [{ physicalLocation: { artifactLocation: { uri: d.file }, ...(d.line ? { region: { startLine: d.line } } : {}) } }]
          : [],
      })),
    }],
  }, null, 2);
}
