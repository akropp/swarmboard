# Swarmboard V2 — Design Document

## Overview

Evolve Swarmboard from a flat project-status tracker into a full project + task management system that serves as organizational memory for all agents and Adam.

**Key changes:**
- Projects gain metadata (repo, status, tags, start date)
- Tasks as first-class entities within projects (with sub-tasks)
- Multiple assignees per task
- Activity logs per task
- FTS5 search across everything
- Component-based frontend (Preact + HTM, no build step)
- CLI enhancements for task management
- Agent-queryable search API

---

## Data Model

### Projects (enhanced)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',        -- active, paused, completed, archived
  repo TEXT,                            -- git URL (e.g. https://github.com/akropp/edge-hunter)
  start_date TEXT,                      -- ISO date
  tags TEXT,                            -- JSON array: ["trading", "infra"]
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Tasks (new)

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_task_id INTEGER REFERENCES tasks(id),  -- sub-tasks
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo',           -- todo, in_progress, in_review, completed, blocked
  priority TEXT DEFAULT 'medium',       -- low, medium, high, critical
  deliverables TEXT,                    -- freeform: PRs, artifacts, links
  pr_urls TEXT,                         -- JSON array of PR URLs
  swarm_id TEXT,                        -- coder-swarm session reference
  notify_channels TEXT,                 -- JSON: [{"type":"discord","target":"1234"},{"type":"telegram","target":"-100xxx"}]
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
```

### Task Assignees (new)

```sql
CREATE TABLE task_assignees (
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  assignee TEXT NOT NULL,              -- agent name or "adam"
  role TEXT DEFAULT 'assignee',        -- assignee, reviewer, watcher
  PRIMARY KEY (task_id, assignee)
);
CREATE INDEX idx_assignees_name ON task_assignees(assignee);
```

### Activity Log (new — replaces status_updates as primary feed)

```sql
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  task_id INTEGER REFERENCES tasks(id),  -- NULL = project-level activity
  author TEXT NOT NULL,
  action TEXT NOT NULL,                   -- status_change, comment, pr_linked, created, assigned, completed
  detail TEXT,                            -- human-readable description
  old_value TEXT,                         -- for status changes
  new_value TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_activity_project ON activity_log(project_id);
CREATE INDEX idx_activity_task ON activity_log(task_id);
```

### FTS5 Search Index

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type,    -- 'project' or 'task'
  entity_id,      -- project id or task id
  project_id,     -- for tasks, the parent project
  title,
  body,           -- description + notes + deliverables concatenated
  tokenize='porter unicode61'
);
```

### Existing Tables (kept)

- `project_members` — unchanged
- `hooks` — unchanged
- `project_hooks` — unchanged
- `hook_log` — unchanged
- `status_updates` — kept for migration reference, eventually deprecated

---

## Migration Strategy

1. Add new columns to `projects` (status, repo, start_date, tags, updated_at)
2. Create new tables (tasks, task_assignees, activity_log, search_index)
3. Migrate existing data:
   - Each existing project gets `status = 'active'` (or `'completed'` if archived)
   - Existing `status_updates` become `activity_log` entries (action = 'comment')
   - Projects with only status updates (no real tasks) get a single "tracking" task
4. Keep `status_updates` table for backward compat, mark deprecated
5. Rebuild FTS5 index from all projects + tasks

---

## API Design

### Projects (enhanced)

| Method | Endpoint | Change |
|--------|----------|--------|
| GET | `/projects` | Add `?status=active&tag=infra&assignee=gilfoyle&q=search` filters |
| POST | `/projects` | Accept `repo`, `status`, `start_date`, `tags` |
| PUT | `/projects/:id` | Accept new fields |
| GET | `/projects/:id` | Include task counts by status, recent activity |

### Tasks (new)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects/:id/tasks` | List tasks. Filters: `?status=todo&assignee=monty&priority=high` |
| POST | `/projects/:id/tasks` | Create task |
| GET | `/tasks/:id` | Get task detail + sub-tasks + activity |
| PUT | `/tasks/:id` | Update task |
| DELETE | `/tasks/:id` | Delete task (soft? or hard with cascade) |
| POST | `/tasks/:id/assign` | Add assignee(s) |
| DELETE | `/tasks/:id/assign/:name` | Remove assignee |
| POST | `/tasks/:id/activity` | Post comment/note |
| GET | `/tasks/:id/activity` | Get task activity log |
| PUT | `/tasks/:id/status` | Transition status (logs activity automatically) |

### Search (new)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/search?q=weather+backtester` | FTS5 across projects + tasks |
| GET | `/search?q=...&type=task&status=in_progress` | Filtered search |

### Activity Feed (new)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/activity?limit=50` | Global activity feed |
| GET | `/projects/:id/activity` | Project activity feed (all tasks) |

### Dashboard Stats (new)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stats` | Project counts, task counts by status, active agents |

---

## CLI Enhancements

```bash
# Projects (existing, enhanced)
swarmboard list [--status active] [--tag infra]
swarmboard create "Name" "Desc" [--repo URL] [--tags trading,infra] [--start-date 2026-03-13]
swarmboard get <project-id>

# Tasks (new)
swarmboard task add <project-id> "Task title" [--desc "..."] [--assign gilfoyle,monty] [--priority high] [--parent 42]
swarmboard task list <project-id> [--status todo,in_progress] [--assignee monty]
swarmboard task get <task-id>
swarmboard task update <task-id> [--status in_progress] [--notes "..."] [--pr "https://..."]
swarmboard task done <task-id>                      # shortcut: status → completed
swarmboard task assign <task-id> <name> [--role reviewer]
swarmboard task unassign <task-id> <name>
swarmboard task comment <task-id> <author> "Comment text"

# Activity
swarmboard activity [--project <id>] [--limit 20]

# Search
swarmboard search "query string" [--type task] [--status in_progress]

# Legacy (backward compat)
swarmboard update <project-id> <author> "Status text"   # → creates activity_log entry
swarmboard history <project-id>                          # → reads activity_log
```

---

## Frontend Architecture

**Stack:** Preact + HTM (no build step, ES module imports from CDN)

### Pages

1. **Dashboard** (`/`)
   - Project cards in a grid
   - Each card: name, status badge, member list, task progress bar (done/total), repo link, last activity timestamp
   - Filter bar: status, tag, assignee
   - Quick search

2. **Project Detail** (`/project/:id`)
   - Project header: name, description, repo, status, members, start date
   - Task list/board view (toggle):
     - **List view:** Sortable table — title, status, assignee, priority, updated
     - **Board view:** Kanban columns (todo → in_progress → in_review → completed)
   - Activity feed sidebar
   - Add task form

3. **Task Detail** (modal or sub-page)
   - Full task info: title, description, status, priority, assignees
   - Sub-tasks list
   - Deliverables, PR links
   - Activity/comment thread
   - Edit in place

4. **Search Results** (`/search?q=...`)
   - Mixed results: projects and tasks
   - Snippet highlighting
   - Filter by type, status

5. **Activity Feed** (`/activity`)
   - Global timeline of all activity across projects
   - Filter by project, author, action type

### Routing

Hash-based routing (`#/`, `#/project/foo`, `#/search?q=bar`) — no server-side routing needed, everything served from `index.html`.

---

## File Structure

```
/home/clawd/projects/pulse/
├── server.js              # Express API (enhanced)
├── db.js                  # Schema + migrations (enhanced)
├── migrate.js             # One-time migration script (v1 → v2)
├── search.js              # FTS5 index management
├── webhook-engine.js      # Existing (unchanged)
├── bin/
│   └── swarmboard         # CLI (enhanced with task commands)
├── public/
│   ├── index.html          # Shell + Preact bootstrap
│   ├── app.js              # Main app, router
│   ├── components/
│   │   ├── dashboard.js    # Project grid
│   │   ├── project.js      # Project detail
│   │   ├── task-list.js    # Task list view
│   │   ├── task-board.js   # Kanban view
│   │   ├── task-detail.js  # Task modal/page
│   │   ├── activity.js     # Activity feed
│   │   ├── search.js       # Search results
│   │   └── common.js       # Shared components (badges, forms, etc.)
│   └── styles.css          # Styles (Tailwind via CDN or hand-rolled)
├── data/
│   └── swarmboard.db       # SQLite database
└── test/
```

---

## Implementation Plan

### Phase 1: Schema + Migration + API (~2-3 hours)
- Update `db.js` with new schema + migration logic
- Write `migrate.js` for v1 → v2 data migration
- Implement `search.js` (FTS5 index build/update)
- Add task CRUD endpoints to `server.js`
- Add search and activity endpoints
- Test with existing data

### Phase 2: CLI (~1 hour)
- Add task subcommands to `bin/swarmboard`
- Add search command
- Backward compat for existing commands

### Phase 3: Frontend (~3-4 hours)
- Scaffold Preact + HTM app structure
- Dashboard page with project cards
- Project detail with task list
- Task detail modal
- Search page
- Activity feed
- Board/kanban view (stretch)

### Phase 4: Polish + Deploy (~1 hour)
- Update SKILL.md
- Migrate production data
- Restart service
- Verify everything works

---

## Open Decisions

1. **Soft vs hard delete for tasks?** Leaning soft delete (add `deleted_at` column) so nothing is truly lost.
2. **Obsidian export** — implement now or defer? Leaning defer.
3. **Webhook integration** — fire hooks on task status changes? Probably yes, same hook system.
4. **Board view** — implement in phase 3 or defer to a follow-up?

---

## Non-Goals (for now)

- Real-time updates (WebSocket) — agents poll or use webhooks
- User authentication — internal tool, API key is sufficient
- File attachments — link to external URLs instead
- Time tracking — not needed yet
- Gantt charts — overkill
