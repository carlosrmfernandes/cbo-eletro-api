import pg from 'pg';
import { env } from './env.js';

// Conexão com o Postgres do Supabase (usuários).
export const pgPool = new pg.Pool({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});
