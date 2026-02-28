const Database = require("better-sqlite3");
const db = new Database("agent.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  topic_id INTEGER,
  started_at TEXT,
  score REAL
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER,
  title TEXT,
  url TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER,
  question TEXT,
  correct_answer TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  question_id INTEGER,
  given_answer TEXT,
  correct INTEGER
);

CREATE TABLE IF NOT EXISTS knowledge_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  topic_id INTEGER,
  mastery REAL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER,
  generated_at TEXT
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER,
  step_number INTEGER,
  title TEXT,
  resource_url TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS study_plans_full (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  topic_id INTEGER,
  status TEXT DEFAULT 'active',
  plan_json TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS plan_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_plan_id INTEGER,
  source_title TEXT,
  source_url TEXT,
  source_reason TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS study_plan_cluster_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_plan_id INTEGER,
  cluster_id INTEGER,
  custom_title TEXT,
  disabled INTEGER DEFAULT 0,
  created_at TEXT,
  UNIQUE(study_plan_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS study_plan_day_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_plan_id INTEGER,
  day_index INTEGER,
  questions_target INTEGER,
  day_order_index INTEGER,
  custom_notes TEXT,
  created_at TEXT,
  UNIQUE(study_plan_id, day_index)
);
`);

module.exports = db;