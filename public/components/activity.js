import { html, useState, useEffect } from 'https://esm.sh/htm/preact/standalone';
import { Spinner, ErrorAlert, EmptyState, relativeTime, apiFetch } from './common.js';

const ACTION_ICONS = {
  comment:       '💬',
  status_change: '🔄',
  created:       '✨',
  assigned:      '👤',
  completed:     '✅',
  pr_linked:     '🔗',
  deleted:       '🗑️',
};

export function ActivityFeed({ onNavigate }) {
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ project: '', author: '', action: '', limit: '50' });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: filters.limit });
      if (filters.project) params.set('project', filters.project);
      if (filters.author)  params.set('author', filters.author);
      if (filters.action)  params.set('action', filters.action);
      const data = await apiFetch('GET', `/activity?${params}`);
      setActivity(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filters]);

  // Group by date
  const grouped = [];
  let lastDate = '';
  for (const a of activity) {
    const d = a.created_at ? new Date(a.created_at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : '';
    if (d !== lastDate) {
      grouped.push({ type: 'date', label: d });
      lastDate = d;
    }
    grouped.push({ type: 'entry', entry: a });
  }

  return html`
    <div class="max-w-3xl mx-auto px-6 py-6">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold">Activity</h1>
        <button onclick=${load} class="text-sm text-muted hover:text-white">↺ Refresh</button>
      </div>

      <!-- Filters -->
      <div class="flex items-center gap-3 mb-6 flex-wrap">
        <input type="text" placeholder="Filter by project ID…" value=${filters.project}
               oninput=${e => setFilters(f => ({ ...f, project: e.target.value }))}
               class="px-3 py-2 text-sm rounded-lg w-48" />
        <input type="text" placeholder="Filter by author…" value=${filters.author}
               oninput=${e => setFilters(f => ({ ...f, author: e.target.value }))}
               class="px-3 py-2 text-sm rounded-lg w-40" />
        <select onchange=${e => setFilters(f => ({ ...f, action: e.target.value }))}
                class="px-3 py-2 text-sm rounded-lg">
          <option value="">All actions</option>
          <option value="comment">Comment</option>
          <option value="status_change">Status change</option>
          <option value="created">Created</option>
          <option value="assigned">Assigned</option>
          <option value="completed">Completed</option>
          <option value="pr_linked">PR linked</option>
        </select>
        <select onchange=${e => setFilters(f => ({ ...f, limit: e.target.value }))}
                class="px-3 py-2 text-sm rounded-lg">
          <option value="20">20 entries</option>
          <option value="50">50 entries</option>
          <option value="100">100 entries</option>
        </select>
      </div>

      <${ErrorAlert} message=${error} />

      ${loading ? html`<${Spinner} />` : activity.length === 0 ? html`
        <${EmptyState} icon="📜" title="No activity yet" />
      ` : html`
        <div class="space-y-1">
          ${grouped.map((item, i) => item.type === 'date' ? html`
            <div key=${i} class="text-xs text-muted font-medium py-3 ${i > 0 ? 'mt-4' : ''}">${item.label}</div>
          ` : html`
            <${ActivityEntry} key=${item.entry.id} entry=${item.entry} onNavigate=${onNavigate} />
          `)}
        </div>
      `}
    </div>
  `;
}

function ActivityEntry({ entry: a, onNavigate }) {
  const icon = ACTION_ICONS[a.action] || '•';

  return html`
    <div class="flex gap-3 py-2 hover:bg-gray-900/30 rounded-lg px-2 -mx-2 transition-colors">
      <div class="w-7 h-7 rounded-full bg-gray-700 border border-border flex items-center justify-center text-xs flex-shrink-0 mt-0.5">
        ${a.author?.[0]?.toUpperCase() || '?'}
      </div>
      <div class="flex-1 min-w-0 text-sm">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-medium">${a.author}</span>
          <span class="text-xs">${icon} ${a.action?.replace('_', ' ')}</span>
          ${a.project_id && html`
            <button onclick=${() => onNavigate(`/project/${a.project_id}`)}
                    class="text-xs text-accent hover:underline">${a.project_id}</button>
          `}
          ${a.task_id && html`<span class="text-xs text-muted">task #${a.task_id}</span>`}
          <span class="text-xs text-muted ml-auto">${relativeTime(a.created_at)}</span>
        </div>
        ${a.detail && html`<p class="text-gray-400 mt-0.5 text-xs line-clamp-2">${a.detail}</p>`}
        ${a.action === 'status_change' && a.old_value && html`
          <p class="text-xs text-muted mt-0.5">${a.old_value} → ${a.new_value}</p>
        `}
      </div>
    </div>
  `;
}
