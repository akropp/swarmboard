import { html } from 'https://esm.sh/htm/preact/standalone';

// ── Status badge colors ───────────────────────────────────────────────────────

const STATUS_COLORS = {
  // Project statuses
  active:      'bg-green-900 text-green-300 border border-green-800',
  paused:      'bg-yellow-900 text-yellow-300 border border-yellow-800',
  completed:   'bg-blue-900 text-blue-300 border border-blue-800',
  archived:    'bg-gray-800 text-gray-400 border border-gray-700',
  // Task statuses
  todo:        'bg-gray-800 text-gray-300 border border-gray-700',
  in_progress: 'bg-blue-900 text-blue-300 border border-blue-800',
  in_review:   'bg-purple-900 text-purple-300 border border-purple-800',
  blocked:     'bg-red-900 text-red-300 border border-red-800',
};

const PRIORITY_COLORS = {
  low:      'bg-gray-800 text-gray-400',
  medium:   'bg-yellow-900 text-yellow-300',
  high:     'bg-orange-900 text-orange-300',
  critical: 'bg-red-900 text-red-300',
};

export function StatusBadge({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-gray-800 text-gray-300';
  return html`<span class="badge ${cls}">${status?.replace('_', ' ')}</span>`;
}

export function PriorityBadge({ priority }) {
  const cls = PRIORITY_COLORS[priority] || 'bg-gray-800 text-gray-300';
  return html`<span class="badge ${cls}">${priority}</span>`;
}

// ── Loading spinner ───────────────────────────────────────────────────────────

export function Spinner() {
  return html`
    <div class="flex items-center justify-center p-8">
      <div class="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
    </div>
  `;
}

// ── Error alert ───────────────────────────────────────────────────────────────

export function ErrorAlert({ message }) {
  if (!message) return null;
  return html`
    <div class="bg-red-900/40 border border-red-800 text-red-300 rounded-lg p-4 mb-4 text-sm">
      ${message}
    </div>
  `;
}

// ── Empty state ───────────────────────────────────────────────────────────────

export function EmptyState({ icon = '📭', title, subtitle }) {
  return html`
    <div class="flex flex-col items-center justify-center py-16 text-muted">
      <div class="text-4xl mb-3">${icon}</div>
      <div class="text-base font-medium text-gray-400">${title}</div>
      ${subtitle && html`<div class="text-sm mt-1">${subtitle}</div>`}
    </div>
  `;
}

// ── Relative time ─────────────────────────────────────────────────────────────

export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── API helper ────────────────────────────────────────────────────────────────

export async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── Nav bar ───────────────────────────────────────────────────────────────────

export function NavBar({ onNavigate, currentPath }) {
  function nav(e, path) {
    e.preventDefault();
    onNavigate(path);
  }

  return html`
    <nav class="sticky top-0 z-50 bg-card border-b border-border h-14 flex items-center px-6 gap-6">
      <a href="#/" onclick=${(e) => nav(e, '/')}
         class="text-lg font-bold flex items-center gap-2 text-white hover:text-accent transition-colors">
        <span class="w-6 h-6 rounded bg-gradient-to-br from-accent to-success flex items-center justify-center text-xs">⬡</span>
        Swarmboard
      </a>
      <div class="flex items-center gap-4 text-sm">
        <a href="#/" onclick=${(e) => nav(e, '/')}
           class="${currentPath === '/' ? 'text-accent' : 'text-muted hover:text-white'} transition-colors">
          Projects
        </a>
        <a href="#/activity" onclick=${(e) => nav(e, '/activity')}
           class="${currentPath === '/activity' ? 'text-accent' : 'text-muted hover:text-white'} transition-colors">
          Activity
        </a>
      </div>
      <div class="ml-auto">
        <form onsubmit=${(e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) onNavigate(`/search?q=${encodeURIComponent(q)}`); }}>
          <input name="q" type="search" placeholder="Search…"
                 class="w-48 px-3 py-1.5 text-sm rounded-lg" />
        </form>
      </div>
    </nav>
  `;
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

export function ConfirmDialog({ message, onConfirm, onCancel }) {
  return html`
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div class="bg-card border border-border rounded-xl p-6 w-80 shadow-2xl">
        <p class="text-sm mb-6">${message}</p>
        <div class="flex gap-3 justify-end">
          <button onclick=${onCancel} class="px-4 py-2 text-sm rounded-lg border border-border text-muted hover:text-white">
            Cancel
          </button>
          <button onclick=${onConfirm} class="px-4 py-2 text-sm rounded-lg bg-danger text-white hover:bg-red-700">
            Confirm
          </button>
        </div>
      </div>
    </div>
  `;
}
