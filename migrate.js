#!/usr/bin/env node
'use strict';

/**
 * Swarmboard v1 → v2 migration
 * Run once: node migrate.js
 *
 * - Adds new columns to projects (already handled by db.js runMigrations)
 * - Migrates status_updates → activity_log entries (action='comment')
 * - Rebuilds FTS5 search index
 */

const { getDb } = require('./db');
const { rebuildIndex } = require('./search');

function migrate() {
  const db = getDb(); // triggers schema creation + column migrations

  console.log('Swarmboard v1 → v2 migration');
  console.log('─'.repeat(50));

  // 1. Migrate status_updates → activity_log
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM activity_log').get();
  if (existing.cnt === 0) {
    const updates = db.prepare('SELECT * FROM status_updates ORDER BY created_at ASC').all();
    if (updates.length > 0) {
      const ins = db.prepare(`
        INSERT INTO activity_log (project_id, task_id, author, action, detail, created_at)
        VALUES (?, NULL, ?, 'comment', ?, ?)
      `);
      const migrate = db.transaction(() => {
        for (const u of updates) {
          ins.run(u.project_id, u.author, u.status_text, u.created_at);
        }
      });
      migrate();
      console.log(`Migrated ${updates.length} status_updates → activity_log`);
    } else {
      console.log('No status_updates to migrate');
    }
  } else {
    console.log(`Skipping activity_log migration (${existing.cnt} entries already exist)`);
  }

  // 2. Ensure all projects have status set
  const noStatus = db.prepare("SELECT COUNT(*) AS cnt FROM projects WHERE status IS NULL").get();
  if (noStatus.cnt > 0) {
    db.prepare("UPDATE projects SET status = CASE WHEN archived = 1 THEN 'archived' ELSE 'active' END WHERE status IS NULL").run();
    console.log(`Set status on ${noStatus.cnt} projects`);
  }

  // 3. Rebuild FTS5 search index
  console.log('Rebuilding FTS5 search index...');
  const { projects, tasks } = rebuildIndex(db);
  console.log(`Indexed ${projects} projects + ${tasks} tasks`);

  console.log('─'.repeat(50));
  console.log('Migration complete.');
}

migrate();
