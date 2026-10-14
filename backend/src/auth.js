import jwt from 'jsonwebtoken';
import { query } from './db.js';

export function createToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query('SELECT id, full_name, email, phone_e164, role, preferred_language, trusted_trader FROM users WHERE id = $1', [claims.sub]);
    if (!rows[0]) return res.status(401).json({ error: 'Account not found.' });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Your session is invalid or expired. Please sign in again.' });
  }
}

export function requireSeller(req, res, next) {
  if (!['seller', 'admin'].includes(req.user?.role)) return res.status(403).json({ error: 'A seller account is required.' });
  next();
}
