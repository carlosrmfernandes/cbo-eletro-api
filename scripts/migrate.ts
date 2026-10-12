// Aplica os arquivos de migrations/*.sql no Postgres do Supabase, em ordem.
// Cada arquivo roda uma única vez (controle na tabela public.schema_migrations).
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('Defina SUPABASE_DB_URL no .env (Supabase → Project Settings → Database → Connection string).');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      nome text primary key,
      aplicada_em timestamptz not null default now()
    );
    -- RLS sem políticas: a tabela não fica acessível pela API pública do Supabase.
    alter table public.schema_migrations enable row level security;`);

  const { rows } = await client.query<{ nome: string }>('select nome from public.schema_migrations');
  const aplicadas = new Set(rows.map((r) => r.nome));

  const dir = path.resolve('migrations');
  const arquivos = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const pendentes = arquivos.filter((f) => !aplicadas.has(f));

  if (!pendentes.length) {
    console.log('Nenhuma migração pendente.');
  }

  for (const arquivo of pendentes) {
    console.log(`Aplicando ${arquivo}...`);
    const sql = await readFile(path.join(dir, arquivo), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public.schema_migrations (nome) values ($1)', [arquivo]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      console.error(`Falha em ${arquivo}; nada desse arquivo foi aplicado.`);
      throw err;
    }
  }

  if (pendentes.length) console.log('Migrações concluídas.');
} finally {
  await client.end();
}
