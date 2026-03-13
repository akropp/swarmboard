import { html, useState, useEffect } from 'https://esm.sh/htm/preact/standalone';
import { StatusBadge, PriorityBadge, Spinner, ErrorAlert, relativeTime, apiFetch } from './common.js';

export function TaskDetailModal({ taskId, onClose, onUpdated }) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [posting, setPosting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const t = await apiFetch('GET', `/tasks/${taskId}`);
      setTask(t);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [taskId]);

  async function postComment(e) {
    e.preventDefault();
    if (!commentText.trim()) return;
    setPosting(true);
    try {
      await apiFetch('POST', `/tasks/${task.id}/activity`, {
        author: commentAuthor || 'user',
        action: 'comment',
        detail: commentText.trim()
      });
      setCommentText('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  }

  async function updateStatus(status) {
    try {
      await apiFetch('PUT', `/tasks/${task.id}/status`, { status, author: 'user' });
      await load();
      onUpdated?.();
    } catch (e) {
      setError(e.message);
    }
  }

  return html`
    <div class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60"
         onclick=${e => e.target === e.currentTarget && onClose()}>
      <div class="bg-card border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <!-- Header -->
        <div class="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-card">
          <h2 class="text-base font-semibold">${task ? `Task #${task.id}` : 'Task'}</h2>
          <button onclick=${onClose} class="text-muted hover:text-white text-xl leading-none">×</button>
        </div>

        <${ErrorAlert} message=${error} />

        ${loading ? html`<${Spinner} />` : task ? html`
          <div class="p-6 space-y-5">
            <!-- Title + status -->
            <div>
              <h3 class="text-xl font-bold mb-2">${task.title}</h3>
              <div class="flex flex-wrap gap-2 items-center">
                <${StatusBadge} status=${task.status} />
                <${PriorityBadge} priority=${task.priority} />
                ${task.parent_task_id && html`
                  <span class="text-xs text-muted">Sub-task of #${task.parent_task_id}</span>
                `}
              </div>
            </div>

            <!-- Quick status change -->
            <div class="flex flex-wrap gap-2">
              ${['todo','in_progress','in_review','completed','blocked'].map(s => html`
                <button onclick=${() => updateStatus(s)}
                        class="px-3 py-1 text-xs rounded-full border transition-colors ${task.status === s ? 'border-accent text-accent' : 'border-border text-muted hover:text-white'}">
                  ${s.replace('_', ' ')}
                </button>
              `)}
            </div>

            <!-- Description -->
            ${task.description && html`
              <div>
                <h4 class="text-xs text-muted uppercase mb-1">Description</h4>
                <p class="text-sm text-gray-300 whitespace-pre-wrap">${task.description}</p>
              </div>
            `}

            <!-- Assignees -->
            ${task.assignees?.length > 0 && html`
              <div>
                <h4 class="text-xs text-muted uppercase mb-2">Assignees</h4>
                <div class="flex flex-wrap gap-2">
                  ${task.assignees.map(a => html`
                    <div class="flex items-center gap-1.5 bg-gray-800 px-3 py-1 rounded-full text-sm">
                      <span class="w-5 h-5 rounded-full bg-gray-600 flex items-center justify-center text-xs">
                        ${a.assignee[0].toUpperCase()}
                      </span>
                      ${a.assignee}
                      <span class="text-muted text-xs">(${a.role})</span>
                    </div>
                  `)}
                </div>
              </div>
            `}

            <!-- Deliverables -->
            ${task.deliverables && html`
              <div>
                <h4 class="text-xs text-muted uppercase mb-1">Deliverables</h4>
                <p class="text-sm text-gray-300 whitespace-pre-wrap">${task.deliverables}</p>
              </div>
            `}

            <!-- PR URLs -->
            ${Array.isArray(task.pr_urls) && task.pr_urls.length > 0 && html`
              <div>
                <h4 class="text-xs text-muted uppercase mb-2">Pull Requests</h4>
                <div class="space-y-1">
                  ${task.pr_urls.map(url => html`
                    <a href=${url} target="_blank"
                       class="block text-sm text-accent hover:underline truncate">${url}</a>
                  `)}
                </div>
              </div>
            `}

            <!-- Notes -->
            ${task.notes && html`
              <div>
                <h4 class="text-xs text-muted uppercase mb-1">Notes</h4>
                <p class="text-sm text-gray-300 whitespace-pre-wrap">${task.notes}</p>
              </div>
            `}

            <!-- Sub-tasks -->
            ${task.sub_tasks?.length > 0 && html`
              <div>
                <h4 class="text-xs text-muted uppercase mb-2">Sub-tasks (${task.sub_tasks.length})</h4>
                <div class="space-y-2">
                  ${task.sub_tasks.map(s => html`
                    <div class="flex items-center gap-3 bg-gray-900/50 rounded-lg px-3 py-2 text-sm">
                      <${StatusBadge} status=${s.status} />
                      <span class="flex-1">#${s.id} ${s.title}</span>
                    </div>
                  `)}
                </div>
              </div>
            `}

            <!-- Activity thread -->
            <div>
              <h4 class="text-xs text-muted uppercase mb-3">Activity</h4>
              ${task.activity?.length > 0 ? html`
                <div class="space-y-3 mb-4">
                  ${[...task.activity].reverse().map(a => html`
                    <div class="flex gap-3 text-sm">
                      <div class="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center text-xs flex-shrink-0 mt-0.5">
                        ${a.author?.[0]?.toUpperCase() || '?'}
                      </div>
                      <div class="flex-1">
                        <div class="flex items-center gap-2 mb-0.5">
                          <span class="font-medium">${a.author}</span>
                          <span class="text-xs text-muted">${relativeTime(a.created_at)}</span>
                          <span class="text-xs text-muted">${a.action}</span>
                        </div>
                        ${a.action === 'status_change' ? html`
                          <span class="text-muted">${a.old_value} → ${a.new_value}</span>
                        ` : html`<p class="text-gray-300">${a.detail}</p>`}
                      </div>
                    </div>
                  `)}
                </div>
              ` : html`<p class="text-sm text-muted mb-4">No activity yet.</p>`}

              <!-- Comment form -->
              <form onsubmit=${postComment} class="space-y-2">
                <textarea value=${commentText} rows="2"
                          oninput=${e => setCommentText(e.target.value)}
                          class="w-full px-3 py-2 text-sm rounded-lg resize-none"
                          placeholder="Leave a comment…"></textarea>
                <div class="flex gap-2">
                  <input type="text" value=${commentAuthor}
                         oninput=${e => setCommentAuthor(e.target.value)}
                         class="flex-1 px-3 py-1.5 text-sm rounded-lg"
                         placeholder="Your name" />
                  <button type="submit" disabled=${posting || !commentText.trim()}
                          class="px-4 py-1.5 text-sm bg-accent text-white rounded-lg disabled:opacity-50">
                    ${posting ? '…' : 'Comment'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        ` : null}
      </div>
    </div>
  `;
}
