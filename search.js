'use strict';

const { getDb } = require('./db');

// ── FTS5 helpers ──────────────────────────────────────────────────────────────

function buildBody(...parts) {
  return parts.filter(Boolean).join(' ');
}

// Insert or replace a project in the search index
function indexProject(db, project) {
  db.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
    .run('project', project.id);
  db.prepare(
    'INSERT INTO search_index (entity_type, entity_id, project_id, title, body) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'project',
    project.id,
    project.id,
    project.name || '',
    buildBody(project.description, project.tags)
  );
}

// Insert or replace a task in the search index
function indexTask(db, task) {
  db.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
    .run('task', String(task.id));
  db.prepare(
    'INSERT INTO search_index (entity_type, entity_id, project_id, title, body) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'task',
    String(task.id),
    task.project_id,
    task.title || '',
    buildBody(task.description, task.notes, task.deliverables)
  );
}

// Remove an entity from the search index
function removeFromIndex(db, entityType, entityId) {
  db.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
    .run(entityType, String(entityId));
}

// Rebuild entire search index from scratch
function rebuildIndex(db) {
  db.exec('DELETE FROM search_index');

  const projects = db.prepare('SELECT * FROM projects').all();
  const insertStmt = db.prepare(
    'INSERT INTO search_index (entity_type, entity_id, project_id, title, body) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertStmt.run(...r);
  });

  const projectRows = projects.map(p => [
    'project', p.id, p.id,
    p.name || '',
    buildBody(p.description, p.tags)
  ]);

  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  const taskRows = tasks.map(t => [
    'task', String(t.id), t.project_id,
    t.title || '',
    buildBody(t.description, t.notes, t.deliverables)
  ]);

  insertMany([...projectRows, ...taskRows]);
  return { projects: projectRows.length, tasks: taskRows.length };
}

// Full-text search
function search(query, { type, status, projectId, limit = 50 } = {}) {
  const db = getDb();

  // Escape FTS5 special characters
  const safeQuery = query.replace(/['"*^]/g, ' ').trim();
  if (!safeQuery) return [];

  let sql = `
    SELECT s.entity_type, s.entity_id, s.project_id, s.title,
           snippet(search_index, 4, '<mark>', '</mark>', '...', 20) AS snippet,
           rank
    FROM search_index s
    WHERE search_index MATCH ?
  `;
  const params = [safeQuery];

  if (type) {
    sql += ' AND s.entity_type = ?';
    params.push(type);
  }
  if (projectId) {
    sql += ' AND s.project_id = ?';
    params.push(projectId);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  let results = db.prepare(sql).all(...params);

  // If status filter needed, join to tasks table
  if (status && type === 'task') {
    const taskIds = new Set(results.map(r => r.entity_id));
    if (taskIds.size > 0) {
      const placeholders = [...taskIds].map(() => '?').join(',');
      const taskStatuses = db.prepare(
        `SELECT id, status FROM tasks WHERE id IN (${placeholders})`
      ).all(...taskIds);
      const statusMap = Object.fromEntries(taskStatuses.map(t => [String(t.id), t.status]));
      const statusList = status.split(',');
      results = results.filter(r => statusList.includes(statusMap[r.entity_id]));
    }
  }

  return results;
}

module.exports = { indexProject, indexTask, removeFromIndex, rebuildIndex, search };
