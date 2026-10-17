# Oclo Backend

High-performance Solana-integrated backend for the Oclo platform. Handles user authentication via SIWS (Sign-In With Solana), quote calculations, catalog management, and on-chain financial settlements.

## 🚀 Tech Stack
- **Runtime**: Node.js (v20+)
- **Database**: [Turso](https://turso.tech/) (libsql) — globally distributed edge database.
- **Solana Integration**: `@solana/web3.js` & `@coral-xyz/anchor`.
- **RPC Provider**: Helius.
- **Deployment**: Render.

## ✨ Key Features
- **SIWS Authentication**: Secure, passwordless login using Solana wallet signatures (nonce-based verification).
- **Dynamic Catalog**: API for managing and retrieving available job types and pricing.
- **Quote Engine**: Real-time USD calculations for job batches.
- **On-Chain Settlement (Phase 3)**: 
  - `reserve`: Locking funds on-chain.
  - `payout`: Executing payments to users.
  - `buyback`: Processing token buybacks.
  - `deposit`: Handling fund deposits.
- **Simulation Mode**: Built-in fail-safe that allows the API to function with mock transactions if Solana configuration is missing.

## ⚙️ Configuration

Create a `.env` file in the root directory based on `.env.example`:

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 8787) | No |
| `SOLANA_CLUSTER` | `mainnet` or `devnet` | Yes |
| `SOLANA_RPC_URL` | Your Helius or Solana RPC URL | Yes |
| `HELIUS_API_KEY` | API key for Helius RPC | Yes |
| `TURSO_DATABASE_URL`| Turso DB connection string | Yes |
| `TURSO_AUTH_TOKEN` | Turso authentication token | Yes |
| `FRONTEND_ORIGIN` | CORS origin for the frontend | Yes |
| `PROGRAM_ID` | Public key of the Solana smart contract | Yes (for Real Mode) |
| `IDL_PATH` | Path to the `idl.json` file | Yes (for Real Mode) |
| `AUTHORITY_KEYPAIR` | JSON array of the admin private key | Yes (for Real Mode) |

## 🛠 Installation & Running

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run smoke tests
npm run smoke
```

## 📡 API Endpoints

### Auth
- `POST /api/auth/nonce` $\rightarrow$ Get a unique message to sign.
- `POST /api/auth/verify` $\rightarrow$ Verify signature and start session.

### Core
- `GET /status` $\rightarrow$ Service health check.
- `GET /api/catalog` $\rightarrow$ List available services.
- `POST /api/quotes` $\rightarrow$ Calculate cost for a batch of jobs.
- `GET /api/credits` $\rightarrow$ Check user balance.

### Settlement (Phase 3)
- `POST /api/reserve` $\rightarrow$ Reserve funds.
- `POST /api/payout` $\rightarrow$ Payout funds.
- `POST /api/buyback` $\rightarrow$ Execute buyback.
- `POST /api/deposit` $\rightarrow$ Deposit funds.

## 🧪 Testing
The project includes a comprehensive smoke test suite in `scripts/smoke.mjs` that verifies the server lifecycle, API availability, and SIWS flow.
