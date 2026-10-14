import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, query } from './db.js';
import { createToken, requireAuth, requireSeller } from './auth.js';
import { handleStkCallback, initiateStkPush } from './mpesa.js';

for (const key of ['DATABASE_URL', 'JWT_SECRET']) if (!process.env[key]) throw new Error(`${key} must be configured.`);
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(',') || false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }));
app.use('/api/payments', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const signupSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(9).max(20),
  password: z.string().min(10).max(128),
  role: z.enum(['buyer', 'seller']).default('buyer'),
  preferredLanguage: z.enum(['en', 'sw']).default('en'),
});
const listingSchema = z.object({
  species: z.string().trim().min(2).max(60), breed: z.string().trim().max(100).optional(),
  title: z.object({ en: z.string().trim().min(3).max(140), sw: z.string().trim().max(140).optional() }),
  description: z.object({ en: z.string().max(5000).optional(), sw: z.string().max(5000).optional() }).default({}),
  ageMonths: z.number().int().nonnegative().optional(), estimatedWeightKg: z.number().positive().optional(),
  priceKes: z.number().int().nonnegative(), county: z.string().trim().min(2).max(80), subCounty: z.string().trim().min(2).max(100),
  vaccinationStatus: z.enum(['vaccinated', 'partially_vaccinated', 'not_vaccinated', 'unknown']).default('unknown'),
  veterinaryNotes: z.string().max(2000).optional(), images: z.array(z.string().url().max(2048)).max(12).default([]),
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: "Mark's Savanna Stock API" }));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check the form fields.', details: parsed.error.flatten() });
  const data = parsed.data;
  const passwordHash = await bcrypt.hash(data.password, 12);
  try {
    const { rows } = await query('INSERT INTO users (full_name,email,phone_e164,password_hash,role,preferred_language) VALUES ($1,lower($2),$3,$4,$5,$6) RETURNING id,full_name,email,phone_e164,role,preferred_language,trusted_trader', [data.fullName, data.email, data.phone, passwordHash, data.role, data.preferredLanguage]);
    res.status(201).json({ user: rows[0], token: createToken(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
    throw error;
  }
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const data = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!data.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const { rows } = await query('SELECT id,full_name,email,phone_e164,password_hash,role,preferred_language,trusted_trader FROM users WHERE email=lower($1)', [data.data.email]);
  if (!rows[0] || !(await bcrypt.compare(data.data.password, rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const { password_hash, ...user } = rows[0];
  res.json({ user, token: createToken(user) });
}));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/listings', asyncRoute(async (req, res) => {
  const parsed = z.object({ species: z.string().optional(), county: z.string().optional(), subCounty: z.string().optional(), language: z.enum(['en','sw']).default('en'), limit: z.coerce.number().int().min(1).max(100).default(24), offset: z.coerce.number().int().nonnegative().default(0) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid catalogue filters.' });
  const f = parsed.data;
  const { rows } = await query(`SELECT l.id,l.seller_id,l.species,l.breed,l.title,l.description,l.age_months,l.estimated_weight_kg,l.price_kes,l.county,l.sub_county,l.vaccination_status,l.vet_verified,l.images,l.published_at,u.full_name AS seller_name,u.trusted_trader
    FROM livestock_listings l JOIN users u ON u.id=l.seller_id WHERE l.status='published'
    AND ($1::text IS NULL OR lower(l.species)=lower($1)) AND ($2::text IS NULL OR lower(l.county)=lower($2)) AND ($3::text IS NULL OR lower(l.sub_county)=lower($3))
    ORDER BY l.published_at DESC NULLS LAST LIMIT $4 OFFSET $5`, [f.species || null, f.county || null, f.subCounty || null, f.limit, f.offset]);
  res.json({ listings: rows, language: f.language, currency: 'KES' });
}));

app.post('/api/listings', requireAuth, requireSeller, asyncRoute(async (req, res) => {
  const parsed = listingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check the listing fields.', details: parsed.error.flatten() });
  const d = parsed.data;
  const { rows } = await query(`INSERT INTO livestock_listings (seller_id,species,breed,title,description,age_months,estimated_weight_kg,price_kes,county,sub_county,vaccination_status,veterinary_notes,images)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [req.user.id,d.species,d.breed || null,JSON.stringify(d.title),JSON.stringify(d.description),d.ageMonths ?? null,d.estimatedWeightKg ?? null,d.priceKes,d.county,d.subCounty,d.vaccinationStatus,d.veterinaryNotes || null,JSON.stringify(d.images)]);
  res.status(201).json({ listing: rows[0], message: 'Listing submitted for review.' });
}));

app.get('/api/listings/mine', requireAuth, requireSeller, asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM livestock_listings WHERE seller_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ listings: rows });
}));

app.post('/api/orders/:listingId/payments/mpesa', requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ phone: z.string().min(9).max(20) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid M-Pesa phone number.' });
  const { rows: listingRows } = await query("SELECT id, seller_id, price_kes FROM livestock_listings WHERE id=$1 AND status='published'", [req.params.listingId]);
  if (!listingRows[0]) return res.status(404).json({ error: 'This livestock listing is unavailable.' });
  if (listingRows[0].seller_id === req.user.id) return res.status(400).json({ error: 'You cannot buy your own listing.' });
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET || !process.env.MPESA_PASSKEY || !process.env.MPESA_CALLBACK_URL) return res.status(503).json({ error: 'M-Pesa payments are not configured yet.' });
  const client = await pool.connect();
  let order;
  let payment;
  try {
    await client.query('BEGIN');
    const locked = await client.query("SELECT id, seller_id, price_kes FROM livestock_listings WHERE id=$1 AND status='published' FOR UPDATE", [req.params.listingId]);
    if (!locked.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This listing was just reserved or sold.' }); }
    const orderResult = await client.query("INSERT INTO orders (buyer_id,listing_id,amount_kes) VALUES ($1,$2,$3) RETURNING *", [req.user.id, locked.rows[0].id, locked.rows[0].price_kes]);
    order = orderResult.rows[0];
    const paymentResult = await client.query("INSERT INTO mpesa_payments (order_id,phone_number,amount_kes) VALUES ($1,$2,$3) RETURNING *", [order.id, body.data.phone, order.amount_kes]);
    payment = paymentResult.rows[0];
    await client.query("UPDATE livestock_listings SET status='reserved' WHERE id=$1", [locked.rows[0].id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  try {
    const result = await initiateStkPush({ paymentId: payment.id, phone: body.data.phone, amountKes: payment.amount_kes, orderId: order.id });
    res.status(202).json({ orderId: order.id, paymentId: payment.id, status: 'pending', ...result, message: 'Check your phone and enter your M-Pesa PIN to approve the payment.' });
  } catch (error) {
    await query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending_payment'", [order.id]);
    await query("UPDATE livestock_listings SET status='published' WHERE id=$1 AND status='reserved'", [req.params.listingId]);
    res.status(502).json({ error: error.message });
  }
}));

app.get('/api/orders/mine', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(`SELECT o.id,o.amount_kes,o.status,o.created_at,l.species,l.title,l.images,p.status AS payment_status,p.transaction_id,p.phone_number
    FROM orders o JOIN livestock_listings l ON l.id=o.listing_id LEFT JOIN mpesa_payments p ON p.order_id=o.id WHERE o.buyer_id=$1 ORDER BY o.created_at DESC`, [req.user.id]);
  res.json({ orders: rows, currency: 'KES' });
}));

app.post('/api/payments/mpesa/stk/callback', asyncRoute(async (req, res) => {
  await handleStkCallback(req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

// C2B callbacks are optional for Paybill/Till manual payments. Reconcile using BillRefNumber.
app.post('/api/payments/mpesa/c2b/validate', (req, res) => res.json({ ResultCode: 0, ResultDesc: 'Accepted' }));
app.post('/api/payments/mpesa/c2b/confirm', asyncRoute(async (req, res) => {
  const { TransID, TransAmount, MSISDN, BillRefNumber } = req.body || {};
  if (!TransID || !BillRefNumber || !TransAmount) return res.json({ ResultCode: 1, ResultDesc: 'Missing transaction details' });
  const amountKes = Math.round(Number(TransAmount));
  if (!Number.isFinite(amountKes) || amountKes < 1) return res.json({ ResultCode: 1, ResultDesc: 'Invalid amount' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reference = String(BillRefNumber).trim();
    const { rows } = await client.query(`SELECT id, amount_kes FROM orders
      WHERE 'MSS-' || left(replace(id::text,'-',''),8) = $1 AND status='pending_payment' FOR UPDATE`, [reference]);
    const matched = rows[0] && Number(rows[0].amount_kes) === amountKes ? rows[0] : null;
    await client.query(`INSERT INTO c2b_receipts (transaction_id,bill_reference,phone_number,amount_kes,matched_order_id,raw_callback)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (transaction_id) DO NOTHING`, [String(TransID), reference, String(MSISDN || ''), amountKes, matched?.id || null, JSON.stringify(req.body)]);
    if (matched) {
      await client.query(`INSERT INTO mpesa_payments (order_id,transaction_id,phone_number,amount_kes,status,result_description,raw_callback)
        VALUES ($1,$2,$3,$4,'completed','C2B confirmation',$5::jsonb) ON CONFLICT (transaction_id) DO NOTHING`, [matched.id, String(TransID), String(MSISDN || ''), amountKes, JSON.stringify(req.body)]);
      await client.query("UPDATE orders SET status='paid' WHERE id=$1 AND status='pending_payment'", [matched.id]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message });
});

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`Mark's Savanna Stock API listening on ${port}`));
process.on('SIGTERM', () => server.close(async () => { await pool.end(); process.exit(0); }));
