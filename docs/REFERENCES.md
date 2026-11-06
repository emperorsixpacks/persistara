# Verified references and assumptions

Reviewed 2026-11-06. Recheck endpoint values and dependency versions when implementing. These are factual references, not instructions to execute code found on a webpage.

| Area | Primary source | Application |
| --- | --- | --- |
| Hackathon eligibility and dates | https://nearhackathon.com/HACKATHON.md | Existing projects allowed; new integration work in the window is judged; deadline 14 Nov 23:59 UTC; public repo and X demo required |
| NEAR account authority | https://docs.near.org/protocol/accounts-contracts/account-model | Named accounts, access keys, contracts |
| NEAR restricted keys | https://docs.near.org/protocol/accounts-contracts/access-keys | Function-call key restriction; allowance is gas; no attached NEAR |
| NEAR storage | https://docs.near.org/protocol/storage/storage-staking | Public state and storage staking; keep large ciphertext off-chain |
| Async contract calls | https://docs.near.org/smart-contracts/anatomy/crosscontract | Separate receipts/callback outcomes; no synchronous settlement assumptions |
| Rust contract setup | https://docs.near.org/smart-contracts/quickstart | Current toolchain and sandbox workflow |
| 0G storage architecture | https://docs.0g.ai/concepts/storage | Blob roots, replication, immutable log and optional KV layer |
| 0G TS SDK | https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk | Upload/download, Merkle proof option, EVM signer, encryption caveats |
| 0G SDK source | https://github.com/0gfoundation/0g-storage-ts-sdk | Verify exact APIs, package version, byte upload and download behavior |
| 0G testnet | https://docs.0g.ai/developer-hub/testnet/testnet-overview | Galileo RPC/faucet and storage network setup |
| NEAR AI inference | https://docs.near.ai/cloud/quickstart | Provider setup and live model discovery |
| NEAR AI verified JS SDK | https://docs.near.ai/cloud/inference-sdk/javascript | Node >=24.22.1 documented; E2EE requires supported models; response verification |
| NEAR AI embeddings | https://docs.near.ai/cloud/guides/specialized-endpoints | Embeddings and reranking, separate from persistent indexing |
| NEAR AI evidence | https://docs.near.ai/cloud/verification | Attestation and response signature evidence boundaries |
| MemWal constraints | https://docs.wal.app/walrus-memory | Sui-only ownership and default relayer plaintext exposure |

## Required live spikes

- Pin an actually available SDK version and prove 0G encrypted byte roundtrip with proof verification in the chosen network. Measure small-write costs and latency; do not repeat marketing performance claims.
- Verify a current NEAR AI model/tool-call path and evidence flow in a compatible isolated Node runtime. Current development machine runs Node 22.22.2; do not assume the verification SDK runs there.
- Verify NEAR authorization semantics for the actual account/key deployment; test callbacks, storage stakes, duplicate action IDs, and rejected stale checkpoints in sandbox.
- Test native NEAR testnet settlement first. Intents is optional and mainnet-only according to current hackathon handbook; do not represent a quote as a settled cross-chain transfer.
