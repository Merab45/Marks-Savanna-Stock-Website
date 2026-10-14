import { query } from './db.js';

const apiRoot = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';
let cachedToken;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const credentials = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const url = `${apiRoot}/oauth/v1/generate?grant_type=client_credentials`;
  const response = await fetch(url, { headers: { Authorization: `Basic ${credentials}` } });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Daraja authorization failed (${response.status}).`);
  cachedToken = body.access_token;
  tokenExpiry = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000;
  return cachedToken;
}

function kenyaPhone(input) {
  const digits = String(input).replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  throw new Error('Enter a valid Kenyan M-Pesa number, for example 0712345678.');
}

function stkPassword(timestamp) {
  return Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
}

export async function initiateStkPush({ paymentId, phone, amountKes, orderId }) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const token = await getAccessToken();
  const payload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: stkPassword(timestamp),
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Number(amountKes),
    PartyA: kenyaPhone(phone),
    PartyB: process.env.MPESA_SHORTCODE,
    PhoneNumber: kenyaPhone(phone),
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: `MSS-${String(orderId).slice(0, 8)}`,
    TransactionDesc: 'Livestock order payment',
  };
  const response = await fetch(`${apiRoot}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || body.ResponseCode !== '0') {
    await query("UPDATE mpesa_payments SET status='failed', result_description=$2 WHERE id=$1", [paymentId, body.errorMessage || body.ResponseDescription || 'STK request rejected']);
    throw new Error(body.errorMessage || body.ResponseDescription || 'M-Pesa did not accept the payment request.');
  }
  await query('UPDATE mpesa_payments SET checkout_request_id=$2, merchant_request_id=$3 WHERE id=$1', [paymentId, body.CheckoutRequestID, body.MerchantRequestID]);
  return { checkoutRequestId: body.CheckoutRequestID, merchantRequestId: body.MerchantRequestID, customerMessage: body.CustomerMessage };
}

// Callback is asynchronous; only a successful Daraja callback marks order paid.
export async function handleStkCallback(callback) {
  const result = callback?.Body?.stkCallback;
  if (!result?.CheckoutRequestID) return;
  const success = Number(result.ResultCode) === 0;
  const metadata = result.CallbackMetadata?.Item || [];
  const value = (name) => metadata.find((item) => item.Name === name)?.Value;
  const receipt = value('MpesaReceiptNumber') || null;
  const phone = value('PhoneNumber') ? String(value('PhoneNumber')) : null;
  const amount = value('Amount');
  const client = await (await import('./db.js')).pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('UPDATE mpesa_payments SET status=$2, transaction_id=$3, phone_number=COALESCE($4, phone_number), amount_kes=COALESCE($5, amount_kes), result_code=$6, result_description=$7, raw_callback=$8 WHERE checkout_request_id=$1 RETURNING order_id', [result.CheckoutRequestID, success ? 'completed' : 'failed', receipt, phone, amount ? Math.round(Number(amount)) : null, String(result.ResultCode), result.ResultDesc || null, JSON.stringify(callback)]);
    if (rows[0] && success) await client.query("UPDATE orders SET status='paid' WHERE id=$1 AND status='pending_payment'", [rows[0].order_id]);
    if (rows[0] && !success) {
      const { rows: failedOrders } = await client.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending_payment' RETURNING listing_id", [rows[0].order_id]);
      if (failedOrders[0]) await client.query("UPDATE livestock_listings SET status='published' WHERE id=$1 AND status='reserved'", [failedOrders[0].listing_id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export { kenyaPhone };
