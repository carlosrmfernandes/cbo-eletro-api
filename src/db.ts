import sql from 'mssql';
import { env } from './env.js';

let pool: Promise<sql.ConnectionPool> | null = null;

export function getPool() {
  if (!pool) {
    pool = new sql.ConnectionPool({
      server: env.DB_SERVER,
      port: env.DB_PORT,
      database: env.DB_DATABASE,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      options: { encrypt: true, trustServerCertificate: true },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    })
      .connect()
      .catch((err) => {
        pool = null;
        throw err;
      });
  }
  return pool;
}

export { sql };
