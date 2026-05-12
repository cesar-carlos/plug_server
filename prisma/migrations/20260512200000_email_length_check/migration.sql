-- Enforce a practical maximum length on CITEXT emails (same ceiling as typical VARCHAR(255) UX).
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_len_chk" CHECK (char_length("email"::text) <= 255);

ALTER TABLE "clients"
  ADD CONSTRAINT "clients_email_len_chk" CHECK (char_length("email"::text) <= 255);
