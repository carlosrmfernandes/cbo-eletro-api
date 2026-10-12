import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token não informado' });
  }
  try {
    const { id, name, email } = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthUser;
    req.user = { id, name, email };
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido ou expirado' });
  }
}
