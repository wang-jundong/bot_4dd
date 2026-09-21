# Solana Target Sell Reversal

Live TypeScript implementation of the `target_sell_reversal` strategy for Pump bonding curves and PumpSwap. It consumes processed transactions from Vibe Station Yellowstone gRPC, decodes official Anchor events, builds venue instructions with the official Pump SDK, and submits signed v0 transactions through Helius Sender.

## Commands

```sh
npm install
npm test
npm run test:grpc
npm run build
npm run start:prod
npm run logs
npm run stop
```

Copy `.env.example` to `.env` and fill every blank. Never commit `.env`, private keys, or API keys. `EXECUTION_MODE` accepts only `live`; starting the process can spend real funds whenever the configured strategy qualifies.

`npm run start:prod` builds and starts or restarts the single PM2 process named `solana-tsr-bot`. It also refreshes PM2's environment. `npm run logs` prints the latest 1,000 retained lines and follows new entries.

Use `LOG_LEVEL=info` in production. `debug` emits multiple records per streamed transaction and should be enabled only for short diagnostic sessions. PM2 log rotation should also be enabled on the host to enforce a disk-size limit.

## Live integrations

- Vibe Station uses the standard Yellowstone client and supplies the configured token as `X-Token`.
- Pump and PumpSwap instruction builders and event coders come from `@pump-fun/pump-sdk`.
- Helius RPC authentication is derived from `HELIUS_RPC_URL` and `HELIUS_API_KEY`.
- Helius Sender transactions include a priority fee and a transfer to an official tip account. SWQOS-only requires at least 5,000 tip lamports; Sender Max requires at least 1,000,000.

## Operational risks

The official Pump SDK dependency tree currently reports npm security advisories inherited from Anchor and legacy Solana Web3/SPL packages. On startup, the recovery journal is reconciled against confirmed wallet token balances before open positions are restored and pool monitoring resumes. Keep the journal intact and monitor the process and wallet continuously.
