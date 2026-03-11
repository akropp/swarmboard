'use strict';

const express = require('express');
const path = require('path');
const { getDb } = require('./db');
const { fireHooks } = require('./webhook-engine');

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

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), port: PORT });
});

// ─── Projects ────────────────────────────────────────────────────────────────

// POST /projects — Create project
app.post('/projects', (req, res) => {
  const { name, description, id, members } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const db = getDb();
  const projectId = id || makeProjectId(name);

  try {
    db.prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run(
      projectId, name, description || null
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
    res.status(201).json(project);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Project with that id already exists' });
    }
    throw err;
  }
});

// GET /projects — List projects
app.get('/projects', (req, res) => {
  const db = getDb();
  const includeArchived = req.query.archived === 'true';

  const rows = db.prepare(`
    SELECT p.*,
      (SELECT status_text FROM status_updates WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) AS latest_status,
      (SELECT author     FROM status_updates WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) AS latest_author,
      (SELECT created_at FROM status_updates WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) AS latest_at
    FROM projects p
    WHERE p.archived = 0 ${includeArchived ? 'OR p.archived = 1' : ''}
    ORDER BY COALESCE(latest_at, p.created_at) DESC
  `).all();

  const getMembers = db.prepare('SELECT * FROM project_members WHERE project_id = ?');
  for (const p of rows) {
    p.members = getMembers.all(p.id);
  }

  res.json(rows);
});

// GET /projects/:id — Get project + latest status
app.get('/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  project.members = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(project.id);
  project.latest_status = db.prepare(
    'SELECT * FROM status_updates WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(project.id) || null;

  res.json(project);
});

// PUT /projects/:id — Update project metadata
app.put('/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const fields = [];
  const params = [];
  if (req.body.name !== undefined)        { fields.push('name = ?');        params.push(req.body.name); }
  if (req.body.description !== undefined) { fields.push('description = ?'); params.push(req.body.description); }
  if (req.body.archived !== undefined)    { fields.push('archived = ?');    params.push(req.body.archived ? 1 : 0); }

  if (fields.length > 0) {
    params.push(project.id);
    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  updated.members = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(project.id);

  fireHooks(project.id, 'edit', null).catch(err => console.error('[hooks] edit error:', err.message));
  res.json(updated);
});

// DELETE /projects/:id — Archive project
app.delete('/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(project.id);
  fireHooks(project.id, 'archive', null).catch(err => console.error('[hooks] archive error:', err.message));
  res.json({ success: true });
});

// ─── Project Members ─────────────────────────────────────────────────────────

// GET /projects/:id/members
app.get('/projects/:id/members', (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(req.params.id));
});

// POST /projects/:id/members — Add member
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

// DELETE /projects/:id/members/:name — Remove member
app.delete('/projects/:id/members/:name', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND member_name = ?')
    .run(req.params.id, req.params.name);
  res.json({ success: true });
});

// ─── Status Updates ──────────────────────────────────────────────────────────

// POST /projects/:id/status — Post status update
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

  fireHooks(project.id, 'status', update).catch(err => console.error('[hooks] status error:', err.message));
  res.status(201).json(update);
});

// GET /projects/:id/history — Status history
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

// ─── Notifications (project ↔ hook subscriptions) ───────────────────────────

// GET /projects/:id/notifications
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

// POST /projects/:id/notifications — Subscribe to hook
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

// PUT /projects/:id/notifications/:hookId — Update subscription
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

// DELETE /projects/:id/notifications/:hookId — Unsubscribe
app.delete('/projects/:id/notifications/:hookId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_hooks WHERE project_id = ? AND hook_id = ?')
    .run(req.params.id, req.params.hookId);
  res.json({ success: true });
});

// ─── Hooks (global webhook definitions) ──────────────────────────────────────

// GET /hooks — List all hooks
app.get('/hooks', (_req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM hooks ORDER BY name').all());
});

// POST /hooks — Create hook
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

// GET /hooks/:id — Get hook
app.get('/hooks/:id', (req, res) => {
  const db = getDb();
  const hook = db.prepare('SELECT * FROM hooks WHERE id = ?').get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  res.json(hook);
});

// PUT /hooks/:id — Update hook
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

// DELETE /hooks/:id — Delete hook (and its subscriptions)
app.delete('/hooks/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_hooks WHERE hook_id = ?').run(req.params.id);
  db.prepare('DELETE FROM hooks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Hook Log ─────────────────────────────────────────────────────────────────

// GET /hooks/:id/log
app.get('/hooks/:id/log', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  res.json(
    db.prepare('SELECT * FROM hook_log WHERE hook_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(req.params.id, limit)
  );
});

// GET /hook-log — All recent hook executions
app.get('/hook-log', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  res.json(
    db.prepare('SELECT * FROM hook_log ORDER BY created_at DESC LIMIT ?').all(limit)
  );
});

// ─── Fire a hook manually (for testing) ──────────────────────────────────────

// POST /hooks/:id/test?project=<id>
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

  // Temporarily subscribe the project to this hook and fire
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
