// Formatting and small rendering helpers shared by the input, run and results
// views. No state, no DOM queries.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 4350 -> "1:12:30"; 83 -> "1:23". Clock time, not a duration label. */
export function clock(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 83 -> "1m 23s" — for lengths, where a clock reads as a position. */
export function length(seconds) {
  if (seconds == null) return '';
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function bytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function when(epochSeconds) {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One muted hue per speaker, assigned in order of appearance and reused across
 *  the ribbon, the index rail and the detail pane. The values themselves live in
 *  the stylesheet as --hue-1…6 so they follow the light/dark theme. */
const HUE_COUNT = 6;

export function speakerPalette(names) {
  const map = new Map();
  names.forEach((n, i) => map.set(n, `var(--hue-${(i % HUE_COUNT) + 1})`));
  return map;
}

/** The captions are prose with hashtags; tint the tags so the two read apart. */
export function captionHtml(text) {
  return esc(text).replace(/(^|\s)(#[\w-]+)/g, '$1<span class="tag">$2</span>');
}

/** The deliverables are plain markdown paragraphs with the occasional bold or
 *  italic run — enough of a renderer for exactly that, and no dependency. */
export function markdownHtml(md) {
  return esc(md)
    .split(/\n{2,}/)
    .map((para) => {
      const heading = para.match(/^(#{2,4})\s+(.*)$/s);
      if (heading) return `<h4>${inline(heading[2])}</h4>`;
      return `<p>${inline(para.replace(/\n/g, ' '))}</p>`;
    })
    .join('');
}

function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
