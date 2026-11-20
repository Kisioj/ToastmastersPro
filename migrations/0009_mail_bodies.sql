-- Treść wysłanych maili (podgląd w panelu admina). Jedna treść może iść do wielu osób (powiadomienia w ukrytej kopii).
-- Tajna część linków do logowania i ustawienia hasła jest przed zapisem zastępowana kropkami.
CREATE TABLE mail_bodies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject    TEXT NOT NULL,
  text       TEXT NOT NULL,
  html       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
ALTER TABLE mail_log ADD COLUMN body_id INTEGER REFERENCES mail_bodies(id) ON DELETE SET NULL;
CREATE INDEX mail_log_body ON mail_log(body_id);
