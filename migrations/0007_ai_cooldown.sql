-- Przerwa między ocenami AI jednej osoby (ochrona darmowej puli Workers AI)
ALTER TABLE ai_usage ADD COLUMN last_at INTEGER;
