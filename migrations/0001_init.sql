-- Strefa członka Toastmasters Częstochowa — schemat początkowy

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,            -- zawsze małymi literami
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member',  -- member | admin
  password_hash TEXT,                            -- NULL = hasło jeszcze nie ustawione
  active        INTEGER NOT NULL DEFAULT 1,
  invited_at    INTEGER,
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL
);

-- Jednorazowe linki: ustawienie hasła (zaproszenie) i logowanie mailem
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,                   -- SHA-256 tokenu; sam token jest tylko w linku
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL,                      -- set_password | login
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX tokens_user ON tokens(user_id, purpose);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE contests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'text',      -- text (np. hasła) | rollup (pliki graficzne)
  phase       TEXT NOT NULL DEFAULT 'draft',     -- draft | submissions | voting | closed
  methods     TEXT NOT NULL DEFAULT '["top3"]',  -- JSON: włączone sposoby głosowania (>1 = tryb testowy)
  results     TEXT NOT NULL DEFAULT 'admin',     -- admin | after_vote | closed
  settings    TEXT NOT NULL DEFAULT '{}',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id      INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  author_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_key        TEXT,
  file_name       TEXT,
  file_type       TEXT,
  file_size       INTEGER,
  file_parts      INTEGER,
  upload_complete INTEGER NOT NULL DEFAULT 1,
  preview_key     TEXT,
  report          TEXT,                          -- JSON: raport techniczny (DPI, wymiary…)
  ai_report       TEXT,                          -- JSON: ocena zgodności z brand manualem
  hidden          INTEGER NOT NULL DEFAULT 0,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX entries_contest ON entries(contest_id);

CREATE TABLE ballots (
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method     TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (contest_id, user_id, method)
);

-- Tryb testowy: który sposób głosowania członkom podoba się najbardziej
CREATE TABLE method_feedback (
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferred  TEXT NOT NULL,
  comment    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (contest_id, user_id)
);

CREATE TABLE mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,                      -- sent | error | not_configured
  error      TEXT,
  created_at INTEGER NOT NULL
);

-- Ochrona przed zgadywaniem haseł
CREATE TABLE login_failures (
  email TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX login_failures_email ON login_failures(email, at);

CREATE TABLE ai_usage (
  user_id INTEGER NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
