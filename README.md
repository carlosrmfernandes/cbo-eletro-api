# cbo-eletro-api

API Node + Express + TypeScript.

- **Dados do dashboard:** SQL Server `AmbarCBOEletro` (somente leitura).
- **Usuários:** tabela `"User"` no Postgres do Supabase. Senha com bcrypt, login devolve um JWT.

## Rodando

```bash
npm install
cp .env.example .env   # SQL Server, SUPABASE_DB_URL e JWT_SECRET
npm run migrate        # cria a tabela "User" (só na primeira vez)
npm run dev            # http://localhost:3333
```

## Migrações

Os arquivos ficam em `migrations/` (`001_...sql`, `002_...sql`, …) e rodam em ordem no banco
do `SUPABASE_DB_URL`, uma única vez cada (controle na tabela `public.schema_migrations`).
Para alterar o banco, crie o próximo arquivo numerado; nunca edite um que já foi aplicado.

## Endpoints

| Método | Rota                     | Auth | Descrição                                  |
|--------|--------------------------|------|--------------------------------------------|
| GET    | /api/health              | -    | Health check                               |
| POST   | /api/auth/register       | -    | `{ name, email, password }` → token + user |
| POST   | /api/auth/login          | -    | `{ email, password }` → token + user       |
| GET    | /api/auth/me             | JWT  | Usuário logado                             |
| GET    | /api/dashboard/resumo    | JWT  | Totais de NFs únicas por status            |
| GET    | /api/dashboard/rastreio/:codigo | JWT | Histórico do objeto na API dos Correios (credenciais lidas de `ECOM_CORREIOSSETUP`) |

## Adicionando funcionalidades

Crie um router em `src/routes/`, proteja com `requireAuth` (o usuário logado fica em `req.user`)
e registre em `src/server.ts`.
