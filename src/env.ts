import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3333),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // SQL Server: fonte dos dados do dashboard
  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().default(1433),
  DB_DATABASE: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),

  // Postgres do Supabase: tabela "User" (login/cadastro)
  SUPABASE_DB_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('8h'),
});

export const env = schema.parse(process.env);
