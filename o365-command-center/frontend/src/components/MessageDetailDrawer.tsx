import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import type { MessageDetail, MessageRow } from '../services/ApiService.js';
import { apiService } from '../services/ApiService.js';

type MessageDetailDrawerProps = {
  message: MessageRow | null;
  onClose: () => void;
};

export function sanitizeMessageHtml(html: string, loadImages = false): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['base', 'form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['srcdoc'],
  });
  const document = new DOMParser().parseFromString(clean, 'text/html');
  const blocked: string[] = [];
  for (const image of Array.from(document.querySelectorAll('img[src]'))) {
    const source = image.getAttribute('src') ?? '';
    if (/^(https?:)?\/\//i.test(source)) {
      image.setAttribute('data-blocked-src', source);
      if (loadImages) image.setAttribute('src', source);
      else image.removeAttribute('src');
    }
  }
  for (const element of Array.from(document.querySelectorAll('[style], style'))) {
    const original = element.getAttribute('style') ?? element.textContent ?? '';
    const rewritten = original.replace(/url\(\s*(['"]?)(https?:)?\/\/([^)'"\s]+)\1\s*\)/gi, (_match, _quote, protocol, hostAndPath: string) => {
      const url = `${protocol ?? 'https:'}//${hostAndPath}`;
      blocked.push(url);
      return loadImages ? `url("${url.replaceAll('"', '%22')}")` : 'none';
    });
    if (element.hasAttribute('style')) element.setAttribute('style', rewritten);
    else element.textContent = rewritten;
    if (blocked.length && element instanceof HTMLElement) {
      element.setAttribute('data-blocked-src', blocked.join(' '));
    }
  }
  for (const link of Array.from(document.querySelectorAll('a[href]'))) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  const imagePolicy = loadImages ? "img-src data: https:" : 'img-src data:';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${imagePolicy}`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${document.body.innerHTML}</body></html>`;
}

export default function MessageDetailDrawer({ message, onClose }: MessageDetailDrawerProps) {
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadImages, setLoadImages] = useState(false);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    setLoadImages(false);
    if (message) {
      void apiService.getMessage(message.id).then(({ data }) => {
        if (active) setDetail(data);
      }).catch(() => {
        if (active) setError('Could not load the live message body.');
      });
    }
    return () => { active = false; };
  }, [message?.id]);

  const srcDoc = useMemo(
    () => (detail ? sanitizeMessageHtml(detail.bodyHtml, loadImages) : ''),
    [detail, loadImages],
  );
  if (!message) return null;
  return (
    <aside className="message-detail-drawer" role="dialog" aria-modal="true" aria-label="Message details">
      <header>
        <div><h2>{message.subject || '(no subject)'}</h2><p>{message.fromName} &lt;{message.fromAddress}&gt;</p></div>
        <button type="button" onClick={onClose} aria-label="Close message">Close</button>
      </header>
      <p>{error ?? (detail ? `Received ${new Date(detail.receivedAt).toLocaleString()}` : 'Loading message…')}</p>
      {message.webLink ? <a href={message.webLink} target="_blank" rel="noopener noreferrer">Open in Outlook</a> : null}
      <div className="message-detail-actions">
        <button type="button" onClick={() => setLoadImages(true)} disabled={loadImages || !detail}>Load images</button>
      </div>
      {detail ? <iframe title="Message body" sandbox="allow-popups" srcDoc={srcDoc} /> : null}
    </aside>
  );
}
