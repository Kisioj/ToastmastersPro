-- Drobny stan aplikacji (np. „darmowy limit Workers AI wyczerpany dnia X”)
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
