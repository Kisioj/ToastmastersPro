-- Opiekunowie konkursów: osoby, które zarządzają konkretnym konkursem (bez uprawnień admina systemu)
CREATE TABLE contest_managers (
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (contest_id, user_id)
);
CREATE INDEX contest_managers_user ON contest_managers(user_id);
