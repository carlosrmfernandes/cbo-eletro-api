-- Preferências de tela por usuário (ex.: colunas ocultas da lista de pedidos).
-- "value" é JSON livre; cada tela define o formato da sua chave.
CREATE TABLE "UserPreference" (
  "userId"    INTEGER NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "key"       TEXT NOT NULL,
  "value"     JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("userId", "key")
);

ALTER TABLE "UserPreference" ENABLE ROW LEVEL SECURITY;
