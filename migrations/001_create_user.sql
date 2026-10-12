CREATE TABLE "User" (
  "id"        SERIAL PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "email"     TEXT NOT NULL UNIQUE,
  "password"  TEXT NOT NULL,
  "active"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- O Supabase expõe o schema public na API REST dele; com RLS ligado e sem políticas,
-- ninguém lê a tabela por lá. A cbo-eletro-api acessa direto pelo Postgres, então não é afetada.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
