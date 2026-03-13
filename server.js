'use strict';

const express = require('express');
const path = require('path');
const { getDb } = require('./db');
const { fireHooks } = require('./webhook-engine');
const { indexProject, indexTask, removeFromIndex, rebuildIndex, search } = require('./search');

const app = express();
const PORT = process.env.PORT || 18800;
const PULSE_API_KEY = process.env.PULSE_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireApiKey(req, res, next) {
  if (!PULSE_API_KEY) return next();
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

  const authHeader = req.get('authorization');
  if (authHeader !== `Bearer ${PULSE_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

app.use(requireApiKey);

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function makeProjectId(name) {
  const base = slugify(name);
  return base + '-' + Math.random().toString(36).slice(2, 7);
}

function logActivity(db, { project_id, task_id = null, author, action, detail, old_value, new_value }) {
  return db.prepare(`
    INSERT INTO activity_log (project_id, task_id, author, action, detail, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(project_id, task_id, author, action, detail || null, old_value || null, new_value || null);
}

function getTaskWithDetails(db, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId);
  if (!task) return null;
  task.assignees = db.prepare('SELECT * FROM task_assignees WHERE task_id = ?').all(taskId);
  task.sub_tasks = db.prepare(
    'SELECT t.*, GROUP_CONCAT(a.assignee) AS assignee_names FROM tasks t LEFT JOIN task_assignees a ON a.task_id = t.id WHERE t.parent_task_id = ? AND t.deleted_at IS NULL GROUP BY t.id ORDER BY t.sort_order, t.created_at'
  ).all(taskId);
  // Parse JSON fields
  if (task.pr_urls) { try { task.pr_urls = JSON.parse(task.pr_urls); } catch (_) { task.pr_urls = []; } }
  if (task.notify_channels) { try { task.notify_channels = JSON.parse(task.notify_channels); } catch (_) { task.notify_channels = []; } }
  // Attach documents
  task.documents = db.prepare(
    'SELECT id, title, content_type, author, created_at, updated_at FROM documents WHERE task_id = ? ORDER BY created_at DESC'
  ).all(taskId);
  return task;
}

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), port: PORT });
});

// ─── Projects ────────────────────────────────────────────────────────────────

// POST /projects — Create project
app.post('/projects', (req, res) => {
  const { name, description, id, members, repo, status, start_date, tags } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const db = getDb();
  const projectId = id || makeProjectId(name);

  try {
    db.prepare(`
      INSERT INTO projects (id, name, description, status, repo, start_date, tags, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      projectId, name, description || null,
      status || 'active',
      repo || null,
      start_date || null,
      tags ? JSON.stringify(tags) : null
    );

    if (Array.isArray(members)) {
      const ins = db.prepare(
        'INSERT OR REPLACE INTO project_members (project_id, member_name, role) VALUES (?, ?, ?)'
      );
      for (const m of members) {
        ins.run(projectId, m.name, m.role || 'contributor');
      }
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    project.members = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(projectId);

    // Index in FTS5
    indexProject(db, project);

    logActivity(db, { project_id: projectId, author: 'system', action: 'created', detail: `Project "${name}" created` });

    res.status(201).json(project);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Project with that id already exists' });
    }
    throw err;
  }
});

// GET /projects — List projects with filters
app.get('/projects', (req, res) => {
  const db = getDb();
  const { status, tag, assignee, q, archived } = req.query;

  let sql = `
    SELECT DISTINCT p.*,
      (SELECT al.detail FROM activity_log al WHERE al.project_id = p.id ORDER BY al.created_at DESC LIMIT 1) AS latest_activity,
      (SELECT al.created_at FROM activity_log al WHERE al.project_id = p.id ORDER BY al.created_at DESC LIMIT 1) AS latest_at,
      (SELECT su.status_text FROM status_updates su WHERE su.project_id = p.id ORDER BY su.created_at DESC LIMIT 1) AS latest_status,
      (SELECT su.author FROM status_updates su WHERE su.project_id = p.id ORDER BY su.created_at DESC LIMIT 1) AS latest_author
    FROM projects p
  `;

  const conditions = [];
  const params = [];

  if (archived !== 'true') {
    conditions.push("p.archived = 0");
  }
  if (status) {
    conditions.push("p.status = ?");
    params.push(status);
  }
  if (tag) {
    conditions.push("p.tags LIKE ?");
    params.push(`%${tag}%`);
  }
  if (assignee) {
    sql += ` JOIN project_members pm ON pm.project_id = p.id AND pm.member_name = ?`;
    params.unshift(assignee);
  }

  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY COALESCE(latest_at, p.updated_at, p.created_at) DESC';

  let rows = db.prepare(sql).all(...params);

  // Text search filter (FTS5)
  if (q) {
    const searchResults = search(q, { type: 'project', limit: 200 });
    const matchIds = new Set(searchResults.map(r => r.entity_id));
    rows = rows.filter(p => matchIds.has(p.id));
  }

  const getMembers = db.prepare('SELECT * FROM project_members WHERE project_id = ?');
  const getTaskCounts = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM tasks
    WHERE project_id = ? AND deleted_at IS NULL
    GROUP BY status
  `);

  for (const p of rows) {
    p.members = getMembers.all(p.id);
    const counts = getTaskCounts.all(p.id);
    p.task_counts = {};
    let total = 0;
    for (const c of counts) {
      p.task_counts[c.status] = c.cnt;
      total += c.cnt;
    }
    p.task_counts.total = total;
    if (p.tags) { try { p.tags = JSON.parse(p.tags); } catch (_) { p.tags = []; } }
  }

  res.json(rows);
});

// GET /projects/:id — Get project + task counts + recent activity
app.get('/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  project.members = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(project.id);

  // Task counts by status
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM tasks
    WHERE project_id = ? AND deleted_at IS NULL
    GROUP BY status
  `).all(project.id);
  project.task_counts = {};
  let total = 0;
  for (const c of counts) { project.task_counts[c.status] = c.cnt; total += c.cnt; }
  project.task_counts.total = total;

  // Recent activity
  project.recent_activity = db.prepare(`
    SELECT * FROM activity_log WHERE project_id = ?
    ORDER BY created_at DESC LIMIT 10
  `).all(project.id);

  // Documents
  project.documents = db.prepare(
    'SELECT id, title, content_type, author, created_at, updated_at FROM documents WHERE project_id = ? AND task_id IS NULL ORDER BY created_at DESC'
  ).all(project.id);

  // Legacy latest_status
  project.latest_status = db.prepare(
    'SELECT * FROM status_updates WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(project.id) || null;

  if (project.tags) { try { project.tags = JSON.parse(project.tags); } catch (_) { project.tags = []; } }

  res.json(project);
});

// PUT /projects/:id — Update project metadata
app.put('/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const fields = ["updated_at = datetime('now')"];
  const params = [];
  const b = req.body || {};
  if (b.name !== undefined)        { fields.push('name = ?');        params.push(b.name); }
  if (b.description !== undefined) { fields.push('description = ?'); params.push(b.description); }
  if (b.archived !== undefined)    { fields.push('archived = ?');    params.push(b.archived ? 1 : 0); }
  if (b.status !== undefined)      { fields.push('status = ?');      params.push(b.status); }
  if (b.repo !== undefined)        { fields.push('repo = ?');        params.push(b.repo); }
  if (b.start_date !== undefined)  { fields.push('start_date = ?');  params.push(b.start_date); }
  if (b.tags !== undefined)        { fields.push('tags = ?');        params.push(b.tags ? JSON.stringify(b.tags) : null); }

  if (fields.length > 1) {
    params.push(project.id);
    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  updated.members = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(project.id);
  if (updated.tags) { try { updated.tags = JSON.parse(updated.tags); } catch (_) { updated.tags = []; } }

  indexProject(db, updated);
  fireHooks(project.id, 'edit', null).catch(err => console.error('[hooks] edit error:', err.message));
  res.json(updated);
});

// DELETE /projects/:id — Archive project
app.delete('/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE projects SET archived = 1, status = 'archived', updated_at = datetime('now') WHERE id = ?").run(project.id);
  fireHooks(project.id, 'archive', null).catch(err => console.error('[hooks] archive error:', err.message));
  res.json({ success: true });
});

// ─── Project Members ─────────────────────────────────────────────────────────

app.get('/projects/:id/members', (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(req.params.id));
});

app.post('/projects/:id/members', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { name, role } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  db.prepare(
    'INSERT OR REPLACE INTO project_members (project_id, member_name, role) VALUES (?, ?, ?)'
  ).run(project.id, name, role || 'contributor');

  fireHooks(project.id, 'member', { author: name, status_text: `${name} joined as ${role || 'contributor'}` })
    .catch(err => console.error('[hooks] member error:', err.message));

  res.status(201).json({ project_id: project.id, member_name: name, role: role || 'contributor' });
});

app.delete('/projects/:id/members/:name', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND member_name = ?')
    .run(req.params.id, req.params.name);
  res.json({ success: true });
});

// ─── Status Updates (legacy, kept for backward compat) ───────────────────────

app.post('/projects/:id/status', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { author, text } = req.body || {};
  if (!author) return res.status(400).json({ error: 'author is required' });
  if (!text)   return res.status(400).json({ error: 'text is required' });

  const result = db.prepare(
    'INSERT INTO status_updates (project_id, author, status_text) VALUES (?, ?, ?)'
  ).run(project.id, author, text);

  const update = db.prepare('SELECT * FROM status_updates WHERE id = ?').get(result.lastInsertRowid);

  // Also log to activity_log
  logActivity(db, { project_id: project.id, author, action: 'comment', detail: text });

  fireHooks(project.id, 'status', update).catch(err => console.error('[hooks] status error:', err.message));
  res.status(201).json(update);
});

app.get('/projects/:id/history', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const history = db.prepare(
    'SELECT * FROM status_updates WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(project.id, limit);

  res.json(history);
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

// GET /projects/:id/tasks — List tasks with optional filters
app.get('/projects/:id/tasks', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { status, assignee, priority, parent } = req.query;

  let sql = `
    SELECT t.* FROM tasks t
    WHERE t.project_id = ? AND t.deleted_at IS NULL
  `;
  const params = [req.params.id];

  if (status) {
    const statuses = status.split(',').map(s => s.trim());
    sql += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  if (priority) {
    sql += ' AND t.priority = ?';
    params.push(priority);
  }
  if (parent === 'null' || parent === '0') {
    sql += ' AND t.parent_task_id IS NULL';
  } else if (parent) {
    sql += ' AND t.parent_task_id = ?';
    params.push(parseInt(parent));
  }
  if (assignee) {
    sql += ` AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.assignee = ?)`;
    params.push(assignee);
  }

  sql += ' ORDER BY t.sort_order, t.created_at';

  const tasks = db.prepare(sql).all(...params);
  const getAssignees = db.prepare('SELECT * FROM task_assignees WHERE task_id = ?');
  for (const t of tasks) {
    t.assignees = getAssignees.all(t.id);
    if (t.pr_urls) { try { t.pr_urls = JSON.parse(t.pr_urls); } catch (_) { t.pr_urls = []; } }
  }

  res.json(tasks);
});

// POST /projects/:id/tasks — Create task
app.post('/projects/:id/tasks', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { title, description, status, priority, deliverables, pr_urls, swarm_id,
          notify_channels, notes, parent_task_id, sort_order, assignees } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  const result = db.prepare(`
    INSERT INTO tasks (project_id, parent_task_id, title, description, status, priority,
                       deliverables, pr_urls, swarm_id, notify_channels, notes, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    parent_task_id || null,
    title,
    description || null,
    status || 'todo',
    priority || 'medium',
    deliverables || null,
    pr_urls ? JSON.stringify(pr_urls) : null,
    swarm_id || null,
    notify_channels ? JSON.stringify(notify_channels) : null,
    notes || null,
    sort_order || 0
  );

  const taskId = result.lastInsertRowid;

  // Assignees
  if (Array.isArray(assignees) && assignees.length > 0) {
    const insAssignee = db.prepare(
      'INSERT OR REPLACE INTO task_assignees (task_id, assignee, role) VALUES (?, ?, ?)'
    );
    for (const a of assignees) {
      const name = typeof a === 'string' ? a : a.name;
      const role = typeof a === 'object' ? (a.role || 'assignee') : 'assignee';
      insAssignee.run(taskId, name, role);
    }
  }

  const task = getTaskWithDetails(db, taskId);

  // Index in FTS5
  indexTask(db, task);

  // Activity log
  logActivity(db, {
    project_id: req.params.id,
    task_id: taskId,
    author: (Array.isArray(assignees) && assignees[0]) ? (typeof assignees[0] === 'string' ? assignees[0] : assignees[0].name) : 'system',
    action: 'created',
    detail: `Task "${title}" created`
  });

  // Fire webhooks
  fireHooks(req.params.id, 'task_created', { task }).catch(err => console.error('[hooks] task_created error:', err.message));

  res.status(201).json(task);
});

// GET /tasks/:id — Get task detail
app.get('/tasks/:id', (req, res) => {
  const db = getDb();
  const task = getTaskWithDetails(db, req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  task.activity = db.prepare(
    'SELECT * FROM activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(task.id);

  res.json(task);
});

// PUT /tasks/:id — Update task
app.put('/tasks/:id', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const fields = ["updated_at = datetime('now')"];
  const params = [];
  const b = req.body || {};

  if (b.title !== undefined)            { fields.push('title = ?');            params.push(b.title); }
  if (b.description !== undefined)      { fields.push('description = ?');      params.push(b.description); }
  if (b.priority !== undefined)         { fields.push('priority = ?');         params.push(b.priority); }
  if (b.deliverables !== undefined)     { fields.push('deliverables = ?');     params.push(b.deliverables); }
  if (b.swarm_id !== undefined)         { fields.push('swarm_id = ?');         params.push(b.swarm_id); }
  if (b.notes !== undefined)            { fields.push('notes = ?');            params.push(b.notes); }
  if (b.sort_order !== undefined)       { fields.push('sort_order = ?');       params.push(b.sort_order); }
  if (b.parent_task_id !== undefined)   { fields.push('parent_task_id = ?');   params.push(b.parent_task_id || null); }
  if (b.pr_urls !== undefined)          { fields.push('pr_urls = ?');          params.push(b.pr_urls ? JSON.stringify(b.pr_urls) : null); }
  if (b.notify_channels !== undefined)  { fields.push('notify_channels = ?');  params.push(b.notify_channels ? JSON.stringify(b.notify_channels) : null); }

  // Status transition
  if (b.status !== undefined && b.status !== task.status) {
    fields.push('status = ?');
    params.push(b.status);
    if (b.status === 'completed') {
      fields.push("completed_at = datetime('now')");
    }
    logActivity(db, {
      project_id: task.project_id,
      task_id: task.id,
      author: b.author || 'system',
      action: 'status_change',
      detail: `Status changed from ${task.status} to ${b.status}`,
      old_value: task.status,
      new_value: b.status
    });
    fireHooks(task.project_id, 'task_status', { task_id: task.id, old: task.status, new: b.status })
      .catch(err => console.error('[hooks] task_status error:', err.message));
  }

  if (fields.length > 1) {
    params.push(task.id);
    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = getTaskWithDetails(db, task.id);
  indexTask(db, updated);
  res.json(updated);
});

// DELETE /tasks/:id — Soft delete
app.delete('/tasks/:id', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run(task.id);
  removeFromIndex(db, 'task', task.id);
  logActivity(db, {
    project_id: task.project_id,
    task_id: task.id,
    author: req.body?.author || 'system',
    action: 'deleted',
    detail: `Task "${task.title}" deleted`
  });
  res.json({ success: true });
});

// PUT /tasks/:id/status — Transition status
app.put('/tasks/:id/status', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const { status, author } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required' });

  const oldStatus = task.status;
  const fields = ["status = ?", "updated_at = datetime('now')"];
  const params = [status];
  if (status === 'completed') {
    fields.push("completed_at = datetime('now')");
  }
  params.push(task.id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  logActivity(db, {
    project_id: task.project_id,
    task_id: task.id,
    author: author || 'system',
    action: 'status_change',
    detail: `Status changed from ${oldStatus} to ${status}`,
    old_value: oldStatus,
    new_value: status
  });

  fireHooks(task.project_id, 'task_status', { task_id: task.id, old: oldStatus, new: status })
    .catch(err => console.error('[hooks] task_status error:', err.message));

  const updated = getTaskWithDetails(db, task.id);
  indexTask(db, updated);
  res.json(updated);
});

// POST /tasks/:id/assign — Add assignee
app.post('/tasks/:id/assign', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const { assignee, role } = req.body || {};
  if (!assignee) return res.status(400).json({ error: 'assignee is required' });

  db.prepare('INSERT OR REPLACE INTO task_assignees (task_id, assignee, role) VALUES (?, ?, ?)')
    .run(task.id, assignee, role || 'assignee');

  logActivity(db, {
    project_id: task.project_id,
    task_id: task.id,
    author: 'system',
    action: 'assigned',
    detail: `${assignee} assigned as ${role || 'assignee'}`
  });

  res.json(db.prepare('SELECT * FROM task_assignees WHERE task_id = ?').all(task.id));
});

// DELETE /tasks/:id/assign/:name — Remove assignee
app.delete('/tasks/:id/assign/:name', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM task_assignees WHERE task_id = ? AND assignee = ?')
    .run(req.params.id, req.params.name);
  res.json({ success: true });
});

// POST /tasks/:id/activity — Post a comment/note
app.post('/tasks/:id/activity', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const { author, action, detail } = req.body || {};
  if (!author) return res.status(400).json({ error: 'author is required' });
  if (!detail) return res.status(400).json({ error: 'detail is required' });

  const result = logActivity(db, {
    project_id: task.project_id,
    task_id: task.id,
    author,
    action: action || 'comment',
    detail
  });

  const entry = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(entry);
});

// GET /tasks/:id/activity — Get task activity
app.get('/tasks/:id/activity', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const activity = db.prepare(
    'SELECT * FROM activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(task.id, limit);

  res.json(activity);
});

// ─── Documents ────────────────────────────────────────────────────────────────

// GET /projects/:id/docs — List project documents
app.get('/projects/:id/docs', (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const docs = db.prepare(
    'SELECT * FROM documents WHERE project_id = ? AND task_id IS NULL ORDER BY created_at DESC'
  ).all(req.params.id);
  res.json(docs);
});

// GET /tasks/:id/docs — List task documents
app.get('/tasks/:id/docs', (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const docs = db.prepare(
    'SELECT * FROM documents WHERE task_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);
  res.json(docs);
});

// POST /projects/:id/docs — Attach document to project
app.post('/projects/:id/docs', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { title, content, content_type, author } = req.body || {};
  if (!title)   return res.status(400).json({ error: 'title is required' });
  if (!content) return res.status(400).json({ error: 'content is required' });

  const result = db.prepare(`
    INSERT INTO documents (project_id, task_id, title, content, content_type, author)
    VALUES (?, NULL, ?, ?, ?, ?)
  `).run(req.params.id, title, content, content_type || 'markdown', author || null);

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid);

  // Index document content in FTS5
  const { indexDocument } = require('./search');
  indexDocument(db, doc);

  res.status(201).json(doc);
});

// POST /tasks/:id/docs — Attach document to task
app.post('/tasks/:id/docs', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const { title, content, content_type, author } = req.body || {};
  if (!title)   return res.status(400).json({ error: 'title is required' });
  if (!content) return res.status(400).json({ error: 'content is required' });

  const result = db.prepare(`
    INSERT INTO documents (project_id, task_id, title, content, content_type, author)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(task.project_id, task.id, title, content, content_type || 'markdown', author || null);

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid);

  const { indexDocument } = require('./search');
  indexDocument(db, doc);

  res.status(201).json(doc);
});

// GET /docs/:id — Get document
app.get('/docs/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// PUT /docs/:id — Update document
app.put('/docs/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const fields = ["updated_at = datetime('now')"];
  const params = [];
  const b = req.body || {};
  if (b.title !== undefined)        { fields.push('title = ?');        params.push(b.title); }
  if (b.content !== undefined)      { fields.push('content = ?');      params.push(b.content); }
  if (b.content_type !== undefined) { fields.push('content_type = ?'); params.push(b.content_type); }

  if (fields.length > 1) {
    params.push(doc.id);
    db.prepare(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  const { indexDocument } = require('./search');
  indexDocument(db, updated);
  res.json(updated);
});

// DELETE /docs/:id — Delete document
app.delete('/docs/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  const { removeFromIndex } = require('./search');
  removeFromIndex(getDb(), 'document', req.params.id);
  res.json({ success: true });
});

// ─── Activity Feed ────────────────────────────────────────────────────────────

// GET /activity — Global activity feed
app.get('/activity', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const { project, author, action } = req.query;

  let sql = 'SELECT * FROM activity_log WHERE 1=1';
  const params = [];

  if (project) { sql += ' AND project_id = ?'; params.push(project); }
  if (author)  { sql += ' AND author = ?';     params.push(author); }
  if (action)  { sql += ' AND action = ?';     params.push(action); }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  res.json(db.prepare(sql).all(...params));
});

// GET /projects/:id/activity — Project activity feed
app.get('/projects/:id/activity', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const activity = db.prepare(
    'SELECT * FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(req.params.id, limit);

  res.json(activity);
});

// ─── Search ───────────────────────────────────────────────────────────────────

app.get('/search', (req, res) => {
  const { q, type, status, project } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const results = search(q, { type, status, projectId: project, limit: 50 });
    res.json(results);
  } catch (err) {
    console.error('[search] error:', err.message);
    res.json([]); // FTS syntax error → empty results
  }
});

// POST /search/rebuild — Rebuild search index
app.post('/search/rebuild', (req, res) => {
  const db = getDb();
  const stats = rebuildIndex(db);
  res.json({ success: true, ...stats });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get('/stats', (req, res) => {
  const db = getDb();

  const projectCounts = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM projects GROUP BY status
  `).all();

  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM tasks WHERE deleted_at IS NULL GROUP BY status
  `).all();

  const activeAgents = db.prepare(`
    SELECT DISTINCT assignee FROM task_assignees
    JOIN tasks ON tasks.id = task_assignees.task_id
    WHERE tasks.status IN ('in_progress', 'in_review') AND tasks.deleted_at IS NULL
  `).all().map(r => r.assignee);

  const recentActivity = db.prepare(
    'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 5'
  ).all();

  res.json({
    projects: Object.fromEntries(projectCounts.map(r => [r.status, r.cnt])),
    tasks: Object.fromEntries(taskCounts.map(r => [r.status, r.cnt])),
    active_agents: activeAgents,
    recent_activity: recentActivity
  });
});

// ─── Notifications ────────────────────────────────────────────────────────────

app.get('/projects/:id/notifications', (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const subs = db.prepare(`
    SELECT ph.project_id, ph.hook_id, ph.event_filter, ph.enabled,
           h.name AS hook_name, h.url, h.enabled AS hook_enabled
    FROM project_hooks ph
    JOIN hooks h ON h.id = ph.hook_id
    WHERE ph.project_id = ?
    ORDER BY h.name
  `).all(req.params.id);
  res.json(subs);
});

app.post('/projects/:id/notifications', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { hook_id, event_filter } = req.body || {};
  if (!hook_id) return res.status(400).json({ error: 'hook_id is required' });
  if (!db.prepare('SELECT id FROM hooks WHERE id = ?').get(hook_id)) {
    return res.status(404).json({ error: 'Hook not found' });
  }

  db.prepare(
    'INSERT OR REPLACE INTO project_hooks (project_id, hook_id, event_filter, enabled) VALUES (?, ?, ?, 1)'
  ).run(project.id, hook_id, event_filter || null);

  res.status(201).json({ project_id: project.id, hook_id, event_filter: event_filter || null });
});

app.put('/projects/:id/notifications/:hookId', (req, res) => {
  const db = getDb();
  const fields = [];
  const params = [];
  if (req.body.event_filter !== undefined) { fields.push('event_filter = ?'); params.push(req.body.event_filter || null); }
  if (req.body.enabled !== undefined)      { fields.push('enabled = ?');       params.push(req.body.enabled ? 1 : 0); }

  if (fields.length > 0) {
    params.push(req.params.id, req.params.hookId);
    db.prepare(`UPDATE project_hooks SET ${fields.join(', ')} WHERE project_id = ? AND hook_id = ?`).run(...params);
  }

  const sub = db.prepare('SELECT * FROM project_hooks WHERE project_id = ? AND hook_id = ?')
    .get(req.params.id, req.params.hookId);
  res.json(sub || { error: 'Not found' });
});

app.delete('/projects/:id/notifications/:hookId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_hooks WHERE project_id = ? AND hook_id = ?')
    .run(req.params.id, req.params.hookId);
  res.json({ success: true });
});

// ─── Hooks ────────────────────────────────────────────────────────────────────

app.get('/hooks', (_req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM hooks ORDER BY name').all());
});

app.post('/hooks', (req, res) => {
  const db = getDb();
  const { id, name, url, method, headers, body_template, enabled } = req.body || {};
  if (!id)   return res.status(400).json({ error: 'id is required' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!url)  return res.status(400).json({ error: 'url is required' });

  try {
    db.prepare(`
      INSERT INTO hooks (id, name, url, method, headers_json, body_template, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, url,
      method || 'POST',
      headers ? JSON.stringify(headers) : null,
      body_template || null,
      enabled === false ? 0 : 1
    );
    res.status(201).json(db.prepare('SELECT * FROM hooks WHERE id = ?').get(id));
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Hook with that id already exists' });
    }
    throw err;
  }
});

app.get('/hooks/:id', (req, res) => {
  const db = getDb();
  const hook = db.prepare('SELECT * FROM hooks WHERE id = ?').get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  res.json(hook);
});

app.put('/hooks/:id', (req, res) => {
  const db = getDb();
  const hook = db.prepare('SELECT * FROM hooks WHERE id = ?').get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Not found' });

  const fields = [];
  const params = [];
  const b = req.body || {};
  if (b.name !== undefined)          { fields.push('name = ?');          params.push(b.name); }
  if (b.url !== undefined)           { fields.push('url = ?');           params.push(b.url); }
  if (b.method !== undefined)        { fields.push('method = ?');        params.push(b.method); }
  if (b.headers !== undefined)       { fields.push('headers_json = ?');  params.push(b.headers ? JSON.stringify(b.headers) : null); }
  if (b.body_template !== undefined) { fields.push('body_template = ?'); params.push(b.body_template || null); }
  if (b.enabled !== undefined)       { fields.push('enabled = ?');       params.push(b.enabled ? 1 : 0); }

  if (fields.length > 0) {
    params.push(hook.id);
    db.prepare(`UPDATE hooks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  res.json(db.prepare('SELECT * FROM hooks WHERE id = ?').get(hook.id));
});

app.delete('/hooks/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_hooks WHERE hook_id = ?').run(req.params.id);
  db.prepare('DELETE FROM hooks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/hooks/:id/log', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  res.json(
    db.prepare('SELECT * FROM hook_log WHERE hook_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(req.params.id, limit)
  );
});

app.get('/hook-log', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  res.json(
    db.prepare('SELECT * FROM hook_log ORDER BY created_at DESC LIMIT ?').all(limit)
  );
});

app.post('/hooks/:id/test', async (req, res) => {
  const db = getDb();
  const hook = db.prepare('SELECT * FROM hooks WHERE id = ?').get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Not found' });

  const projectId = req.query.project || req.body?.project_id;
  const project = projectId
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
    : { id: 'test', name: 'Test Project', description: 'A test project' };

  const fakeUpdate = {
    id: 0,
    author: req.body?.author || 'test-user',
    status_text: req.body?.text || 'Test notification from Pulse',
    created_at: new Date().toISOString()
  };

  const context = {
    project: { id: project.id, name: project.name, description: project.description || '' },
    update: { id: 0, author: fakeUpdate.author, text: fakeUpdate.status_text, created_at: fakeUpdate.created_at },
    event: { type: 'status' },
    timestamp: new Date().toISOString()
  };

  const Mustache = require('mustache');
  let headers = {};
  if (hook.headers_json) {
    try { headers = JSON.parse(hook.headers_json); } catch (_) {}
  }

  let bodyStr = null;
  let isJson = false;
  if (hook.body_template) {
    bodyStr = Mustache.render(hook.body_template, context);
    try { JSON.parse(bodyStr); isJson = true; } catch (_) {}
  }

  try {
    const fetchOpts = {
      method: hook.method || 'POST',
      headers: {
        ...(isJson ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'text/plain' }),
        ...headers
      }
    };
    if (bodyStr !== null) fetchOpts.body = bodyStr;

    const response = await fetch(hook.url, fetchOpts);
    const responseText = await response.text().catch(() => '');

    db.prepare('INSERT INTO hook_log (project_id, hook_id, event_type, status_code, response_body) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, hook.id, 'test', response.status, responseText.slice(0, 2000));

    res.json({ success: true, status: response.status, body: responseText.slice(0, 500) });
  } catch (err) {
    db.prepare('INSERT INTO hook_log (project_id, hook_id, event_type, error) VALUES (?, ?, ?, ?)')
      .run(project.id, hook.id, 'test', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Swarmboard running on http://localhost:${PORT}`);
  console.log(`Data: ${require('./db').DB_PATH}`);
});

module.exports = app;
