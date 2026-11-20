-- Historia powiadomień mailowych do klubowiczów (np. „ruszyło głosowanie”)
CREATE TABLE contest_announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  phase      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  recipients INTEGER NOT NULL,
  skipped    INTEGER NOT NULL DEFAULT 0,
  sent_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX contest_announcements_contest ON contest_announcements(contest_id, created_at);
