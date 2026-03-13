'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.SWARMBOARD_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'swarmboard.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    runMigrations(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    -- ── Existing tables (v1, kept for backward compat) ──────────────────────

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT REFERENCES projects(id),
      member_name TEXT NOT NULL,
      role TEXT DEFAULT 'contributor',
      PRIMARY KEY (project_id, member_name)
    );

    CREATE TABLE IF NOT EXISTS status_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id),
      author TEXT NOT NULL,
      status_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'POST',
      headers_json TEXT,
      body_template TEXT,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS project_hooks (
      project_id TEXT REFERENCES projects(id),
      hook_id TEXT REFERENCES hooks(id),
      event_filter TEXT,
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (project_id, hook_id)
    );

    CREATE TABLE IF NOT EXISTS hook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      hook_id TEXT,
      event_type TEXT,
      status_code INTEGER,
      response_body TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ── New v2 tables ────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_task_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      deliverables TEXT,
      pr_urls TEXT,
      swarm_id TEXT,
      notify_channels TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      sort_order INTEGER DEFAULT 0,
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      assignee TEXT NOT NULL,
      role TEXT DEFAULT 'assignee',
      PRIMARY KEY (task_id, assignee)
    );

    CREATE INDEX IF NOT EXISTS idx_assignees_name ON task_assignees(assignee);

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id),
      task_id INTEGER REFERENCES tasks(id),
      author TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_log(task_id);

    -- ── Documents (attachable to projects or tasks) ──────────────────────────

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id),
      task_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT DEFAULT 'markdown',
      author TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_docs_project ON documents(project_id);
    CREATE INDEX IF NOT EXISTS idx_docs_task ON documents(task_id);
  `);

  // FTS5 must be created separately (no IF NOT EXISTS support in some SQLite versions)
  const hasFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='search_index'"
  ).get();
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        entity_type,
        entity_id,
        project_id,
        title,
        body,
        tokenize='porter unicode61'
      );
    `);
  }
}

// Add new columns to projects if they don't exist (idempotent)
function runMigrations(db) {
  const cols = db.pragma('table_info(projects)').map(c => c.name);

  if (!cols.includes('status')) {
    db.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
    db.exec("UPDATE projects SET status = CASE WHEN archived = 1 THEN 'archived' ELSE 'active' END");
  }
  if (!cols.includes('repo')) {
    db.exec('ALTER TABLE projects ADD COLUMN repo TEXT');
  }
  if (!cols.includes('start_date')) {
    db.exec('ALTER TABLE projects ADD COLUMN start_date TEXT');
  }
  if (!cols.includes('tags')) {
    db.exec('ALTER TABLE projects ADD COLUMN tags TEXT');
  }
  if (!cols.includes('updated_at')) {
    db.exec("ALTER TABLE projects ADD COLUMN updated_at TEXT");
    db.exec("UPDATE projects SET updated_at = COALESCE(created_at, datetime('now'))");
  }
}

module.exports = { getDb, DB_PATH };
