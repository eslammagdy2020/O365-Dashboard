import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceDirectory = join(process.cwd(), 'frontend', 'src');
const stylesheet = readFileSync(join(sourceDirectory, 'index.css'), 'utf8');
const entrypoint = readFileSync(join(sourceDirectory, 'main.tsx'), 'utf8');

function findTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function staticClassTokens(source: string): string[] {
  const tokens = new Set<string>();
  // Inspect literal className values and the static parts of template literals;
  // interpolated values and non-literal expressions are deliberately skipped.
  const classNamePattern = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
  for (const match of source.matchAll(classNamePattern)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? '';
    const withoutExpressions = literal.replace(/\$\{[^}]*\}/g, ' ');
    for (const token of withoutExpressions.split(/\s+/).filter(Boolean)) tokens.add(token);
  }
  return [...tokens];
}

describe('frontend stylesheet wiring', () => {
  it('defines every static custom class and imports the grid and app styles', () => {
    const tokens = findTsxFiles(sourceDirectory).flatMap((file) =>
      staticClassTokens(readFileSync(file, 'utf8')),
    );
    const customTokens = [...new Set(tokens)].filter((token) => !token.startsWith('ag-'));

    for (const token of customTokens) {
      expect(stylesheet, `Missing CSS selector for className token .${token}`).toMatch(
        new RegExp(`\\.${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`),
      );
    }

    expect(entrypoint).toContain("import 'ag-grid-community/styles/ag-grid.css';");
    expect(entrypoint).toContain("import 'ag-grid-community/styles/ag-theme-quartz.css';");
    expect(entrypoint).toContain("import './index.css';");
  });
});
