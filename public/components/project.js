import { html } from 'https://esm.sh/htm/preact/standalone';
import { useState, useEffect } from 'https://esm.sh/preact/hooks';
import { StatusBadge, PriorityBadge, Spinner, ErrorAlert, EmptyState, relativeTime, apiFetch } from './common.js';
import { TaskDetailModal } from './task-detail.js';

const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'completed', 'blocked'];

export function ProjectDetail({ projectId, onNavigate }) {
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('list'); // 'list' | 'board'
  const [filters, setFilters] = useState({ status: '', assignee: '', priority: '' });
  const [showAddTask, setShowAddTask] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [editingProject, setEditingProject] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters.status)   params.set('status', filters.status);
      if (filters.assignee) params.set('assignee', filters.assignee);
      if (filters.priority) params.set('priority', filters.priority);
      const [p, ts, act] = await Promise.all([
        apiFetch('GET', `/projects/${projectId}`),
        apiFetch('GET', `/projects/${projectId}/tasks?${params}`),
        apiFetch('GET', `/projects/${projectId}/activity?limit=20`)
      ]);
      setProject(p);
      setTasks(ts);
      setActivity(act);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [projectId, filters]);

  if (loading) return html`<${Spinner} />`;
  if (!project && !loading) return html`<div class="p-8 text-danger">${error || 'Project not found'}</div>`;

  return html`
    <div class="max-w-7xl mx-auto px-6 py-6">
      <!-- Back -->
      <button onclick=${() => onNavigate('/')}
              class="text-sm text-muted hover:text-white mb-4 flex items-center gap-1">
        ← Projects
      </button>

      <${ErrorAlert} message=${error} />

      ${project && html`
        <!-- Project header -->
        <div class="bg-card border border-border rounded-xl p-6 mb-6">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-3 mb-1 flex-wrap">
                <h1 class="text-2xl font-bold">${project.name}</h1>
                <${StatusBadge} status=${project.status || 'active'} />
              </div>
              ${project.description && html`<p class="text-muted text-sm">${project.description}</p>`}
              <div class="flex flex-wrap gap-4 mt-3 text-sm text-muted">
                ${project.repo && html`
                  <a href=${project.repo} target="_blank" class="text-accent hover:underline flex items-center gap-1">
                    ⎇ ${project.repo.replace(/^https?:\/\/(www\.)?/, '')}
                  </a>
                `}
                ${project.start_date && html`<span>Started ${project.start_date}</span>`}
                ${Array.isArray(project.tags) && project.tags.length ? html`
                  <div class="flex gap-1 flex-wrap">
                    ${project.tags.map(t => html`
                      <span class="bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full text-xs">${t}</span>
                    `)}
                  </div>
                ` : null}
              </div>
              ${project.members?.length > 0 && html`
                <div class="flex items-center gap-2 mt-3">
                  <span class="text-xs text-muted">Members:</span>
                  ${project.members.map(m => html`
                    <span class="w-7 h-7 rounded-full bg-gray-700 border border-border flex items-center justify-center text-xs"
                          title=${`${m.member_name} (${m.role})`}>
                      ${m.member_name[0].toUpperCase()}
                    </span>
                  `)}
                </div>
              `}
            </div>
            <div class="flex flex-col gap-2 items-end flex-shrink-0">
              ${project.task_counts?.total > 0 && html`
                <div class="text-right text-xs text-muted">
                  ${project.task_counts.completed||0} / ${project.task_counts.total} tasks done
                </div>
              `}
              <button onclick=${() => setEditingProject(true)}
                      class="px-3 py-1.5 text-xs border border-border rounded-lg text-muted hover:text-white">
                Edit
              </button>
            </div>
          </div>
        </div>

        <!-- Tasks section -->
        <div class="flex gap-6">
          <!-- Main content -->
          <div class="flex-1 min-w-0">
            <!-- Toolbar -->
            <div class="flex items-center gap-3 mb-4 flex-wrap">
              <h2 class="text-base font-semibold flex-1">Tasks</h2>

              <!-- Filters -->
              <select onchange=${e => setFilters(f => ({ ...f, status: e.target.value }))}
                      class="px-2 py-1.5 text-xs rounded-lg">
                <option value="">All statuses</option>
                ${TASK_STATUSES.map(s => html`<option value=${s}>${s.replace('_', ' ')}</option>`)}
              </select>
              <select onchange=${e => setFilters(f => ({ ...f, priority: e.target.value }))}
                      class="px-2 py-1.5 text-xs rounded-lg">
                <option value="">All priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>

              <!-- View toggle -->
              <div class="flex border border-border rounded-lg overflow-hidden text-xs">
                <button onclick=${() => setView('list')}
                        class="${view === 'list' ? 'bg-gray-700 text-white' : 'text-muted hover:text-white'} px-3 py-1.5">
                  List
                </button>
                <button onclick=${() => setView('board')}
                        class="${view === 'board' ? 'bg-gray-700 text-white' : 'text-muted hover:text-white'} px-3 py-1.5">
                  Board
                </button>
              </div>

              <button onclick=${() => setShowAddTask(true)}
                      class="px-3 py-1.5 bg-accent text-white rounded-lg text-xs hover:bg-blue-500">
                + Task
              </button>
            </div>

            ${view === 'list'
              ? html`<${TaskListView} tasks=${tasks} onSelect=${setSelectedTask} onRefresh=${load} />`
              : html`<${TaskBoardView} tasks=${tasks} onSelect=${setSelectedTask} onRefresh=${load} />`
            }
          </div>

          <!-- Activity sidebar -->
          <div class="w-72 flex-shrink-0 hidden lg:block">
            <h2 class="text-sm font-semibold mb-3 text-muted">Recent Activity</h2>
            <div class="space-y-2">
              ${activity.length === 0 ? html`<p class="text-xs text-muted">No activity yet.</p>` :
                activity.map(a => html`
                  <div class="text-xs bg-gray-900/50 rounded-lg p-3">
                    <div class="flex items-center gap-1 mb-1">
                      <span class="font-medium">${a.author}</span>
                      ${a.task_id && html`<span class="text-muted">· #${a.task_id}</span>`}
                      <span class="text-muted ml-auto">${relativeTime(a.created_at)}</span>
                    </div>
                    <p class="text-gray-400 line-clamp-2">${a.detail}</p>
                  </div>
                `)
              }
            </div>
          </div>
        </div>
      `}

      <!-- Add task modal -->
      ${showAddTask && html`
        <${AddTaskModal}
          projectId=${projectId}
          onClose=${() => setShowAddTask(false)}
          onCreated=${() => { setShowAddTask(false); load(); }}
        />
      `}

      <!-- Task detail modal -->
      ${selectedTask !== null && html`
        <${TaskDetailModal}
          taskId=${selectedTask}
          onClose=${() => setSelectedTask(null)}
          onUpdated=${() => { setSelectedTask(null); load(); }}
        />
      `}

      <!-- Edit project modal -->
      ${editingProject && html`
        <${EditProjectModal}
          project=${project}
          onClose=${() => setEditingProject(false)}
          onSaved=${(p) => { setProject(p); setEditingProject(false); }}
        />
      `}
    </div>
  `;
}

// ── Task list view ────────────────────────────────────────────────────────────

function TaskListView({ tasks, onSelect, onRefresh }) {
  if (!tasks.length) {
    return html`<${EmptyState} icon="✓" title="No tasks" subtitle="Add the first task to this project" />`;
  }

  return html`
    <div class="rounded-xl border border-border overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-gray-900/50">
            <th class="text-left px-4 py-2.5 text-xs text-muted font-medium">Title</th>
            <th class="text-left px-3 py-2.5 text-xs text-muted font-medium w-28">Status</th>
            <th class="text-left px-3 py-2.5 text-xs text-muted font-medium w-20">Priority</th>
            <th class="text-left px-3 py-2.5 text-xs text-muted font-medium w-32">Assignees</th>
            <th class="text-left px-3 py-2.5 text-xs text-muted font-medium w-24">Updated</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(t => html`
            <tr key=${t.id} onclick=${() => onSelect(t.id)}
                class="border-b border-border hover:bg-gray-900/50 cursor-pointer transition-colors last:border-0">
              <td class="px-4 py-3 font-medium">
                ${t.title}
                ${t.parent_task_id ? html`<span class="ml-1 text-xs text-muted">↳ sub-task</span>` : null}
              </td>
              <td class="px-3 py-3"><${StatusBadge} status=${t.status} /></td>
              <td class="px-3 py-3"><${PriorityBadge} priority=${t.priority} /></td>
              <td class="px-3 py-3 text-xs text-muted">
                ${t.assignees?.map(a => a.assignee).join(', ') || '—'}
              </td>
              <td class="px-3 py-3 text-xs text-muted">${relativeTime(t.updated_at)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

// ── Task board (kanban) view ──────────────────────────────────────────────────

function TaskBoardView({ tasks, onSelect, onRefresh }) {
  const cols = ['todo', 'in_progress', 'in_review', 'completed'];
  const grouped = Object.fromEntries(cols.map(s => [s, tasks.filter(t => t.status === s)]));
  // Add blocked to todo column
  grouped.todo = [...(grouped.todo || []), ...tasks.filter(t => t.status === 'blocked')];

  return html`
    <div class="flex gap-4 overflow-x-auto pb-4">
      ${cols.map(status => html`
        <div key=${status} class="kanban-col flex-shrink-0">
          <div class="flex items-center gap-2 mb-3">
            <${StatusBadge} status=${status} />
            <span class="text-xs text-muted">${grouped[status].length}</span>
          </div>
          <div class="space-y-2">
            ${grouped[status].map(t => html`
              <div key=${t.id} onclick=${() => onSelect(t.id)}
                   class="bg-card border border-border rounded-lg p-3 cursor-pointer hover:border-gray-500 transition-colors">
                <p class="text-sm font-medium mb-2 line-clamp-2">${t.title}</p>
                <div class="flex items-center justify-between">
                  <${PriorityBadge} priority=${t.priority} />
                  ${t.assignees?.length ? html`
                    <span class="text-xs text-muted">${t.assignees[0].assignee}</span>
                  ` : null}
                </div>
              </div>
            `)}
          </div>
        </div>
      `)}
    </div>
  `;
}

// ── Add task modal ────────────────────────────────────────────────────────────

function AddTaskModal({ projectId, onClose, onCreated }) {
  const [form, setForm] = useState({
    title: '', description: '', priority: 'medium', assignees: '', notes: '', deliverables: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        title: form.title,
        priority: form.priority,
        description: form.description || undefined,
        notes: form.notes || undefined,
        deliverables: form.deliverables || undefined,
        assignees: form.assignees ? form.assignees.split(',').map(s => s.trim()).filter(Boolean) : undefined
      };
      await apiFetch('POST', `/projects/${projectId}/tasks`, body);
      onCreated();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return html`
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
         onclick=${e => e.target === e.currentTarget && onClose()}>
      <div class="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl">
        <h2 class="text-lg font-semibold mb-4">New Task</h2>
        <${ErrorAlert} message=${error} />
        <form onsubmit=${submit} class="space-y-4">
          <div>
            <label class="block text-sm text-muted mb-1">Title *</label>
            <input type="text" required value=${form.title}
                   oninput=${e => setForm(f => ({ ...f, title: e.target.value }))}
                   class="w-full px-3 py-2 text-sm rounded-lg" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm text-muted mb-1">Priority</label>
              <select value=${form.priority}
                      onchange=${e => setForm(f => ({ ...f, priority: e.target.value }))}
                      class="w-full px-3 py-2 text-sm rounded-lg">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label class="block text-sm text-muted mb-1">Assignees (comma-sep)</label>
              <input type="text" value=${form.assignees}
                     oninput=${e => setForm(f => ({ ...f, assignees: e.target.value }))}
                     class="w-full px-3 py-2 text-sm rounded-lg" placeholder="gilfoyle, monty" />
            </div>
          </div>
          <div>
            <label class="block text-sm text-muted mb-1">Description</label>
            <textarea rows="3" value=${form.description}
                      oninput=${e => setForm(f => ({ ...f, description: e.target.value }))}
                      class="w-full px-3 py-2 text-sm rounded-lg resize-none"></textarea>
          </div>
          <div>
            <label class="block text-sm text-muted mb-1">Deliverables</label>
            <textarea rows="2" value=${form.deliverables}
                      oninput=${e => setForm(f => ({ ...f, deliverables: e.target.value }))}
                      class="w-full px-3 py-2 text-sm rounded-lg resize-none"></textarea>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="button" onclick=${onClose}
                    class="flex-1 px-4 py-2 text-sm border border-border rounded-lg text-muted hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled=${saving}
                    class="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-blue-500 disabled:opacity-50">
              ${saving ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ── Edit project modal ────────────────────────────────────────────────────────

function EditProjectModal({ project, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: project.name || '',
    description: project.description || '',
    repo: project.repo || '',
    status: project.status || 'active',
    tags: Array.isArray(project.tags) ? project.tags.join(', ') : (project.tags || ''),
    start_date: project.start_date || ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch('PUT', `/projects/${project.id}`, {
        name: form.name,
        description: form.description || null,
        repo: form.repo || null,
        status: form.status,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        start_date: form.start_date || null
      });
      onSaved(updated);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return html`
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
         onclick=${e => e.target === e.currentTarget && onClose()}>
      <div class="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h2 class="text-lg font-semibold mb-4">Edit Project</h2>
        <${ErrorAlert} message=${error} />
        <form onsubmit=${submit} class="space-y-4">
          <div>
            <label class="block text-sm text-muted mb-1">Name *</label>
            <input type="text" required value=${form.name}
                   oninput=${e => setForm(f => ({ ...f, name: e.target.value }))}
                   class="w-full px-3 py-2 text-sm rounded-lg" />
          </div>
          <div>
            <label class="block text-sm text-muted mb-1">Status</label>
            <select value=${form.status} onchange=${e => setForm(f => ({ ...f, status: e.target.value }))}
                    class="w-full px-3 py-2 text-sm rounded-lg">
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </select>
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
                   class="w-full px-3 py-2 text-sm rounded-lg" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm text-muted mb-1">Start Date</label>
              <input type="date" value=${form.start_date}
                     oninput=${e => setForm(f => ({ ...f, start_date: e.target.value }))}
                     class="w-full px-3 py-2 text-sm rounded-lg" />
            </div>
            <div>
              <label class="block text-sm text-muted mb-1">Tags</label>
              <input type="text" value=${form.tags}
                     oninput=${e => setForm(f => ({ ...f, tags: e.target.value }))}
                     class="w-full px-3 py-2 text-sm rounded-lg" placeholder="tag1, tag2" />
            </div>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="button" onclick=${onClose}
                    class="flex-1 px-4 py-2 text-sm border border-border rounded-lg text-muted hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled=${saving}
                    class="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-blue-500 disabled:opacity-50">
              ${saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}
