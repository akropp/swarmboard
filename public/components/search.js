import { html } from 'https://esm.sh/htm/preact/standalone';
import { useState, useEffect } from 'https://esm.sh/preact/hooks';
import { StatusBadge, Spinner, ErrorAlert, EmptyState, apiFetch } from './common.js';
import { TaskDetailModal } from './task-detail.js';

export function SearchPage({ query, onNavigate }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ type: '', status: '' });
  const [selectedTask, setSelectedTask] = useState(null);
  const [localQuery, setLocalQuery] = useState(query || '');

  async function doSearch(q = localQuery) {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q });
      if (filters.type)   params.set('type', filters.type);
      if (filters.status) params.set('status', filters.status);
      const data = await apiFetch('GET', `/search?${params}`);
      setResults(data);
    } catch (e) {
      setError(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (query) { setLocalQuery(query); doSearch(query); } }, [query]);
  useEffect(() => { if (localQuery) doSearch(); }, [filters]);

  function submit(e) {
    e.preventDefault();
    const newQ = localQuery.trim();
    if (newQ) {
      onNavigate(`/search?q=${encodeURIComponent(newQ)}`);
      doSearch(newQ);
    }
  }

  return html`
    <div class="max-w-3xl mx-auto px-6 py-6">
      <h1 class="text-2xl font-bold mb-6">Search</h1>

      <!-- Search form -->
      <form onsubmit=${submit} class="flex gap-3 mb-4">
        <input type="search" value=${localQuery}
               oninput=${e => setLocalQuery(e.target.value)}
               class="flex-1 px-4 py-2.5 text-sm rounded-lg"
               placeholder="Search projects and tasks…" autofocus />
        <button type="submit" class="px-5 py-2.5 bg-accent text-white rounded-lg text-sm hover:bg-blue-500">
          Search
        </button>
      </form>

      <!-- Filters -->
      <div class="flex items-center gap-3 mb-6">
        <select onchange=${e => setFilters(f => ({ ...f, type: e.target.value }))}
                class="px-3 py-1.5 text-sm rounded-lg">
          <option value="">All types</option>
          <option value="project">Projects</option>
          <option value="task">Tasks</option>
        </select>
        <select onchange=${e => setFilters(f => ({ ...f, status: e.target.value }))}
                class="px-3 py-1.5 text-sm rounded-lg">
          <option value="">Any status</option>
          <option value="todo">Todo</option>
          <option value="in_progress">In Progress</option>
          <option value="in_review">In Review</option>
          <option value="completed">Completed</option>
          <option value="blocked">Blocked</option>
          <option value="active">Active (project)</option>
        </select>
      </div>

      <${ErrorAlert} message=${error} />

      ${loading ? html`<${Spinner} />` : !localQuery.trim() ? html`
        <${EmptyState} icon="🔍" title="Enter a search query" />
      ` : results.length === 0 ? html`
        <${EmptyState} icon="🔎" title="No results" subtitle=${`Nothing found for "${localQuery}"`} />
      ` : html`
        <p class="text-sm text-muted mb-4">${results.length} result${results.length !== 1 ? 's' : ''}</p>
        <div class="space-y-3">
          ${results.map(r => html`
            <${SearchResult} key=${`${r.entity_type}-${r.entity_id}`}
              result=${r} onNavigate=${onNavigate} onSelectTask=${setSelectedTask} />
          `)}
        </div>
      `}

      ${selectedTask !== null && html`
        <${TaskDetailModal}
          taskId=${selectedTask}
          onClose=${() => setSelectedTask(null)}
          onUpdated=${() => setSelectedTask(null)}
        />
      `}
    </div>
  `;
}

function SearchResult({ result: r, onNavigate, onSelectTask }) {
  const isTask = r.entity_type === 'task';

  function handleClick() {
    if (isTask) {
      onSelectTask(r.entity_id);
    } else {
      onNavigate(`/project/${r.entity_id}`);
    }
  }

  // Render HTML snippet safely (search snippet uses <mark> tags)
  function SnippetHtml({ snippet }) {
    return html`<span dangerouslySetInnerHTML=${{ __html: snippet }}></span>`;
  }

  return html`
    <div onclick=${handleClick}
         class="bg-card border border-border rounded-xl p-4 cursor-pointer hover:border-gray-500 transition-colors">
      <div class="flex items-start gap-3">
        <div class="text-lg flex-shrink-0 mt-0.5">${isTask ? '✓' : '📁'}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-medium">${r.title}</span>
            <span class="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">${r.entity_type}</span>
            ${isTask && html`<span class="text-xs text-muted">#${r.entity_id}</span>`}
            ${r.project_id && !isTask ? null : html`
              <button onclick=${e => { e.stopPropagation(); onNavigate(`/project/${r.project_id}`); }}
                      class="text-xs text-accent hover:underline">${r.project_id}</button>
            `}
          </div>
          ${r.snippet && html`
            <p class="text-sm text-gray-400">
              <${SnippetHtml} snippet=${r.snippet} />
            </p>
          `}
        </div>
      </div>
    </div>
  `;
}
