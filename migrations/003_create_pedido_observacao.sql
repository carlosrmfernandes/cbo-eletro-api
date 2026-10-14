-- Observação livre de cada pedido, compartilhada entre os usuários (uma por pedido).
-- Fica aqui porque o SQL Server do sistema é só leitura; "pedido" é o PEDIDO de PEDIDO_MATERIAIS_CLIENTE.
CREATE TABLE "PedidoObservacao" (
  "pedido"    TEXT PRIMARY KEY,
  "texto"     TEXT NOT NULL,
  "updatedBy" INTEGER REFERENCES "User" ("id") ON DELETE SET NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE "PedidoObservacao" ENABLE ROW LEVEL SECURITY;
