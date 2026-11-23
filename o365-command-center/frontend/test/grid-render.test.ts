import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceDirectory = join(process.cwd(), 'frontend', 'src');
const stylesheet = readFileSync(join(sourceDirectory, 'index.css'), 'utf8');
const emailGrid = readFileSync(join(sourceDirectory, 'components', 'EmailGrid.tsx'), 'utf8');

describe('email grid rendering safeguards', () => {
  it('gives the grid a definite height and fits columns when the grid is ready', () => {
    const gridStyles = stylesheet.match(/\.email-grid\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(gridStyles).toMatch(/(?:^|[;\s])height\s*:\s*[^;]+/);
    expect(emailGrid).toContain('event.api.sizeColumnsToFit?.();');
  });
});
