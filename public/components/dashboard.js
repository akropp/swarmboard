import { html, useState, useEffect } from 'https://esm.sh/htm/preact/standalone';
import { StatusBadge, Spinner, ErrorAlert, EmptyState, relativeTime, apiFetch } from './common.js';

export function Dashboard({ onNavigate }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ status: '', tag: '', q: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [stats, setStats] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.tag)    params.set('tag', filters.tag);
      if (filters.q)      params.set('q', filters.q);
      const [ps, st] = await Promise.all([
        apiFetch('GET', `/projects?${params}`),
        apiFetch('GET', '/stats').catch(() => null)
      ]);
      setProjects(ps);
      setStats(st);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filters]);

  return html`
    <div class="max-w-7xl mx-auto px-6 py-6">
      <!-- Header -->
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold">Projects</h1>
          ${stats && html`
            <p class="text-sm text-muted mt-1">
              ${stats.projects?.active || 0} active ·
              ${stats.tasks?.total || Object.values(stats.tasks || {}).reduce((a, b) => a + b, 0)} tasks ·
              ${stats.active_agents?.length || 0} active agents
            </p>
          `}
        </div>
        <button onclick=${() => setShowCreate(true)}
                class="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors">
          + New Project
        </button>
      </div>

      <!-- Filter bar -->
      <div class="flex items-center gap-3 mb-6 flex-wrap">
        <input type="search" placeholder="Search projects…" value=${filters.q}
               onInput=${e => setFilters(f => ({ ...f, q: e.target.value }))}
               class="px-3 py-2 text-sm rounded-lg w-56" />
        <select onchange=${e => setFilters(f => ({ ...f, status: e.target.value }))}
                class="px-3 py-2 text-sm rounded-lg">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <input type="text" placeholder="Filter by tag…" value=${filters.tag}
               onInput=${e => setFilters(f => ({ ...f, tag: e.target.value }))}
               class="px-3 py-2 text-sm rounded-lg w-40" />
        <button onclick=${load} class="px-3 py-2 text-sm border border-border rounded-lg text-muted hover:text-white">
          ↺
        </button>
      </div>

      <${ErrorAlert} message=${error} />

      ${loading ? html`<${Spinner} />` : html`
        ${!projects.length ? html`
          <${EmptyState} icon="📁" title="No projects yet" subtitle="Create your first project to get started" />
        ` : html`
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            ${projects.map(p => html`
              <${ProjectCard} key=${p.id} project=${p} onNavigate=${onNavigate} onRefresh=${load} />
            `)}
          </div>
        `}
      `}

      ${showCreate && html`
        <${CreateProjectModal} onClose=${() => setShowCreate(false)} onCreated=${(p) => {
          setShowCreate(false);
          onNavigate(`/project/${p.id}`);
        }} />
      `}
    </div>
  `;
}

function ProjectCard({ project: p, onNavigate, onRefresh }) {
  const tc = p.task_counts || {};
  const total = tc.total || 0;
  const done = tc.completed || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const tags = Array.isArray(p.tags) ? p.tags : [];

  return html`
    <div class="bg-card border border-border rounded-xl p-5 hover:border-gray-500 transition-colors cursor-pointer"
         onclick=${() => onNavigate(`/project/${p.id}`)}>
      <!-- Header -->
      <div class="flex items-start justify-between mb-3">
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold text-base truncate">${p.name}</h3>
          ${p.description && html`<p class="text-sm text-muted mt-0.5 line-clamp-2">${p.description}</p>`}
        </div>
        <${StatusBadge} status=${p.status || 'active'} />
      </div>

      <!-- Tags -->
      ${tags.length > 0 && html`
        <div class="flex flex-wrap gap-1 mb-3">
          ${tags.map(t => html`
            <span class="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded-full">${t}</span>
          `)}
        </div>
      `}

      <!-- Members -->
      ${p.members?.length > 0 && html`
        <div class="flex items-center gap-1 mb-3">
          ${p.members.slice(0, 5).map(m => html`
            <span class="w-7 h-7 rounded-full bg-gray-700 border border-border flex items-center justify-center text-xs font-medium"
                  title=${m.member_name}>
              ${m.member_name[0].toUpperCase()}
            </span>
          `)}
          ${p.members.length > 5 && html`<span class="text-xs text-muted">+${p.members.length - 5}</span>`}
        </div>
      `}

      <!-- Task progress -->
      ${total > 0 && html`
        <div class="mb-3">
          <div class="flex justify-between text-xs text-muted mb-1">
            <span>Tasks</span>
            <span>${done}/${total} (${pct}%)</span>
          </div>
          <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div class="h-full bg-success rounded-full transition-all" style="width: ${pct}%"></div>
          </div>
          <div class="flex gap-2 mt-1.5 text-xs text-muted flex-wrap">
            ${tc.todo ? html`<span>${tc.todo} todo</span>` : ''}
            ${tc.in_progress ? html`<span class="text-blue-400">${tc.in_progress} in progress</span>` : ''}
            ${tc.blocked ? html`<span class="text-red-400">${tc.blocked} blocked</span>` : ''}
          </div>
        </div>
      `}

      <!-- Footer -->
      <div class="flex items-center justify-between pt-2 border-t border-border text-xs text-muted">
        <span>${p.latest_at ? `Updated ${relativeTime(p.latest_at)}` : `Created ${relativeTime(p.created_at)}`}</span>
        ${p.repo && html`
          <a href=${p.repo} target="_blank" onclick=${e => e.stopPropagation()}
             class="text-accent hover:underline truncate max-w-[140px]">
            ⎇ repo
          </a>
        `}
      </div>
    </div>
  `;
}

function CreateProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '', repo: '', tags: '', status: 'active' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name: form.name,
        description: form.description || undefined,
        repo: form.repo || undefined,
        status: form.status,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined
      };
      const project = await apiFetch('POST', '/projects', body);
      onCreated(project);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return html`
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onclick=${e => e.target === e.currentTarget && onClose()}>
      <div class="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h2 class="text-lg font-semibold mb-4">New Project</h2>
        <${ErrorAlert} message=${error} />
        <form onsubmit=${submit} class="space-y-4">
          <div>
            <label class="block text-sm text-muted mb-1">Name *</label>
            <input type="text" required value=${form.name}
                   oninput=${e => setForm(f => ({ ...f, name: e.target.value }))}
                   class="w-full px-3 py-2 text-sm rounded-lg" placeholder="My Project" />
          </div>
          <div>
            <label class="block text-sm text-muted mb-1">Description</label>
            <textarea rows="2" value=${form.description}
                      oninput=${e => setForm(f => ({ ...f, description: e.target.value }))}
                      class="w-full px-3 py-2 text-sm rounded-lg resize-none"></textarea>
          </div>
          <div>
            <label class="block text-sm text-muted mb-1">Repo URL</label>
            <input type="url" value=${form.repo}
                   oninput=${e => setForm(f => ({ ...f, repo: e.target.value }))}
                   class="w-full px-3 py-2 text-sm rounded-lg" placeholder="https://github.com/…" />
          </div>
          <div>
            <label class="block text-sm text-muted mb-1">Tags (comma-separated)</label>
            <input type="text" value=${form.tags}
                   oninput=${e => setForm(f => ({ ...f, tags: e.target.value }))}
                   class="w-full px-3 py-2 text-sm rounded-lg" placeholder="trading, infra" />
          </div>
          <div class="flex gap-3 pt-2">
            <button type="button" onclick=${onClose}
                    class="flex-1 px-4 py-2 text-sm border border-border rounded-lg text-muted hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled=${saving}
                    class="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-blue-500 disabled:opacity-50">
              ${saving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}
