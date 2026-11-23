/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import CachedDataBanner from '../src/components/CachedDataBanner.js';
import { sanitizeMessageHtml } from '../src/components/MessageDetailDrawer.js';

describe('message body sanitizer', () => {
  it('removes scripts and blocks remote images and CSS URLs until opted in', () => {
    const html = '<script>window.hacked = true</script><img src="https://remote.example/image.png"><p style="background-image:url(https://remote.example/bg.png)">Hello</p><a href="https://example.com">link</a>';
    const blocked = sanitizeMessageHtml(html);
    expect(blocked).not.toContain('<script');
    expect(blocked).toContain('data-blocked-src="https://remote.example/image.png"');
    expect(blocked).not.toMatch(/(?:^|\s)src="https:\/\/remote\.example\/image\.png"/);
    expect(blocked).toContain("img-src data:");
    expect(blocked).toContain('rel="noopener noreferrer"');
    expect(blocked).toContain('target="_blank"');
    expect(blocked).not.toContain('url(https://remote.example/bg.png)');
    expect(sanitizeMessageHtml(html, true)).toContain('src="https://remote.example/image.png"');
    expect(sanitizeMessageHtml(html, true)).toContain('img-src data: https:');
  });

  it('labels cached data as stale after a failed sync', () => {
    render(React.createElement(CachedDataBanner, { status: {
      phase: 'error', folder: null, counts: {}, lastSuccessAt: '2026-11-22T10:00:00.000Z',
      lastError: 'sync failed', nextRunAt: null, warnings: ['sync failed'],
    } }));
    expect(screen.getByRole('alert').textContent).toContain('Cached data, not current');
  });
});
