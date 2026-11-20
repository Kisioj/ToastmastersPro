-- Uwagi opiekuna konkursu (albo admina) do zgłoszeń; autor widzi je przy swoim projekcie
CREATE TABLE entry_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL, -- kto wystawił uwagi
  verdict     TEXT,             -- ok | fix | reject | NULL (sam komentarz)
  comment     TEXT NOT NULL DEFAULT '',
  mailed      INTEGER,          -- 1: autor dostał maila
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_entry_reviews_entry ON entry_reviews(entry_id, created_at);
