# oclo-backend

Independent backend for oclo.work / app.oclo.work.

## Run
```bash
cp .env.example .env   # fill values
npm install
npm start
```

## Env
See `.env.example`. Use a dedicated Turso database (not agentry). `SOLANA_CLUSTER=mainnet` for production.

## Smoke
```bash
npm run smoke
```

## Health
`GET /status` returns service health.