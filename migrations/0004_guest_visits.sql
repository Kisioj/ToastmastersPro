-- Konkursy typu „ranking” (np. kto przyprowadzi najwięcej gości): rejestr wizyt gości
CREATE TABLE guest_visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id  INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- członek, który przyprowadził gościa
  guest_name  TEXT NOT NULL DEFAULT '',                                -- widoczne tylko dla zarządzających
  visit_date  TEXT,                                                    -- RRRR-MM-DD, opcjonalnie
  added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX guest_visits_contest ON guest_visits(contest_id, user_id);
