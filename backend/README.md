# Mark's Savanna Stock API

Node.js + Express + PostgreSQL backend boilerplate for the existing static livestock website. It provides account registration/sign-in, a bilingual catalogue, seller listing submission, orders, and Daraja STK Push/C2B callback routes. The code is a foundation: production use still needs HTTPS hosting, an admin review workflow, image storage, email/phone verification, privacy terms, and live Daraja onboarding.

## Setup

Requirements: Node.js 20+ and PostgreSQL 14+.

1. Create a PostgreSQL database named `marks_savanna_stock`.
2. Run the schema: `psql "$DATABASE_URL" -f schema.sql`.
3. Copy `.env.example` to `.env`; set `DATABASE_URL`, a long random `JWT_SECRET`, and your frontend origin.
4. For Daraja sandbox, create a sandbox app in the [Safaricom Daraja Portal](https://developer.safaricom.co.ke/), then put its Consumer Key and Consumer Secret in `.env`. Set the sandbox shortcode and passkey supplied by the portal/simulator.
5. Install and run: `npm install`, then `npm run dev`.

Never commit `.env`, expose Daraja keys in frontend code, or use sandbox keys in production. `MPESA_ENV=sandbox` is the default; only set `production` after Safaricom approves the shortcode/app for go-live and you replace every credential with production credentials. The callback URL must be reachable on the public internet over HTTPS. For local development, use a secure HTTPS tunnel and set `MPESA_CALLBACK_URL` to its public URL. Daraja credentials are server-only. The OAuth token is cached until shortly before expiry.

## Routes

- `POST /api/auth/register` — create buyer/seller account; passwords use bcrypt.
- `POST /api/auth/login`, `GET /api/auth/me` — sign in and retrieve current profile.
- `GET /api/listings?species=goat&county=Kajiado&language=sw` — published catalogue (prices are `price_kes` whole KSh integers).
- `POST /api/listings`, `GET /api/listings/mine` — seller listing submission and seller records. New entries enter `pending_review`; an administrator must approve them by setting status `published` and `published_at`.
- `POST /api/orders/:listingId/payments/mpesa` — creates an order, reserves the animal, records a pending payment, and requests an STK prompt.
- `POST /api/payments/mpesa/stk/callback` — records Safaricom's asynchronous result and marks successful orders paid.
- `POST /api/payments/mpesa/c2b/validate` and `/confirm` — optional C2B endpoints. Register URLs through Daraja before using C2B. Receipts are stored even if unmatched; a pending order is marked paid only when `BillRefNumber` matches the generated `MSS-XXXXXXXX` reference and the received KSh amount equals the order total. Unmatched/mismatched receipts require reconciliation.
- `GET /api/orders/mine`, `GET /api/health`.

All listing titles/descriptions are JSON objects with `en` and `sw` keys. The vet verification flag and trusted-trader flag are controlled by the admin and default to false; sellers cannot self-verify through the public API. Images are URL arrays; upload files to a dedicated object-storage service before creating the listing.

## Data flow

The website sends JSON to Express. Registration hashes the password and stores a user in PostgreSQL; successful login returns a short-lived JWT for later `Authorization: Bearer …` requests. Sellers submit animal details (species, breed, estimated age/weight, health status, county/sub-county, bilingual title/description, KSh price, and image URLs). Listings remain pending until staff review. Buyers choose an approved listing and phone number; the server creates the order/payment rows, requests a Daraja STK Push, and returns a pending response. Safaricom later posts the callback to the backend; only callback result code `0` makes the payment completed and order paid. Store the returned receipt ID for reconciliation and customer support.

## Frontend integration

Serve the existing static HTML pages from an HTTP origin and set `FRONTEND_ORIGIN` to that origin. Replace the demo `localStorage` account logic with `fetch('http://localhost:4000/api/auth/login', ...)` and send the returned JWT as a Bearer token. For STK checkout, call `/api/orders/{listingId}/payments/mpesa` with `{ "phone": "07..." }`, then show a pending state and poll a future authenticated payment-status route or refresh the order list. Do not claim payment succeeded based only on the initial STK response.

## M-Pesa reference

Safaricom's Daraja portal documents sandbox apps and OAuth access tokens. The API is asynchronous: STK payment completion is confirmed by the callback, not the immediate request response. See [Daraja portal](https://developer.safaricom.co.ke/), [Authorization API](https://developer.safaricom.co.ke/apis/Authorization), and [C2B API](https://developer.safaricom.co.ke/apis/CustomerToBusiness).
