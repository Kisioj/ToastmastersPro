-- Szybkie sprawdzanie limitów wysyłki (1 mail / 5 min na adres, limit dzienny)
CREATE INDEX mail_log_to ON mail_log(to_email, created_at);
CREATE INDEX mail_log_time ON mail_log(status, created_at);
