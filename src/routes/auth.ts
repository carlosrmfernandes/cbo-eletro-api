import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../env.js';
import { pgPool } from '../pg.js';
import { requireAuth, type AuthUser } from '../middleware/auth.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Nome muito curto').max(120),
  email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres').max(100),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password: z.string().min(1, 'Informe a senha'),
});

function signToken(user: AuthUser) {
  return jwt.sign(user, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const { name, email, password } = parsed.data;
    const hash = await bcrypt.hash(password, 10);

    const { rows } = await pgPool.query<{ id: number }>(
      `INSERT INTO "User" ("name", "email", "password")
       VALUES ($1, $2, $3)
       ON CONFLICT ("email") DO NOTHING
       RETURNING "id"`,
      [name, email, hash],
    );
    if (!rows.length) {
      return res.status(409).json({ message: 'E-mail já cadastrado' });
    }

    const user: AuthUser = { id: rows[0].id, name, email };
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const { email, password } = parsed.data;
    const { rows } = await pgPool.query(
      'SELECT "id", "name", "email", "password", "active" FROM "User" WHERE "email" = $1',
      [email],
    );

    const row = rows[0];
    if (!row || !row.active || !(await bcrypt.compare(password, row.password))) {
      return res.status(401).json({ message: 'E-mail ou senha inválidos' });
    }

    const user: AuthUser = { id: row.id, name: row.name, email: row.email };
    res.json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
