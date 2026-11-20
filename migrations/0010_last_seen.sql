-- Ostatnia aktywność na stronie (zapisywana najwyżej raz na 5 minut), do kolumny „Ostatnio online” w panelu admina
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
UPDATE users SET last_seen_at = last_login_at WHERE last_login_at IS NOT NULL;
