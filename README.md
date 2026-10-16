# NIBB backend (transparent 1:1 API proxy)

This service exposes the same API surface as `app.nibb.work/api` by proxying
requests to the upstream while stripping browser `Origin` (otherwise the
upstream RPC rejects the call with 403).

## Run locally
npm install
cp .env.example .env
npm start
# health: http://localhost:8787/status

## Deploy to Render
- New → Web Service → connect `devnyash/nibb-backend`
- Runtime: Node (or Docker). Free plan ok.
- Set `NIBB_UPSTREAM=https://app.nibb.work`.
- Health check path: `/status`.

## Notes
Current implementation is a faithful API pass-through (it copies status code,
headers and body byte-for-byte). Stateful mutation endpoints continue to hit
the upstream service, so behavior matches the source 1:1.