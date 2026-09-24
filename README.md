# AVADO RocketPool

## Installation & Documentation

https://wiki.ava.do/en/tutorials/rocketpool

Corresponding CLI tool: https://github.com/rocket-pool/smartnode

The package runs Smartnode `v1.24.2` (`rocketpoold`, pinned by sha256 in `build/Dockerfile`) in native
mode, a small Node backend (`build/backend`) and the Rocket Pool app of
[AVADO-Client-UI](https://github.com/AvadoDServer/AVADO-Client-UI).

## Ports

| Port | Where | What |
|---|---|---|
| 80 | container | The backend: the UI at `/`, the package API at `/api/avado/*`, and an allow-listed proxy to Smartnode at `/api/sn/*`. The UI opens at http://rocketpool.my.ava.do. |
| 8280 | `127.0.0.1` inside the container only | Smartnode's HTTP API. Only the backend talks to it, with the token from `api-tokens.json`. |

Nothing listens on 9999 any more (0.0.106's API). No other package uses it.

The `/api` routes only answer requests addressed to the box (Host allow-list) and every POST needs
`X-Avado-Request: 1` from the package's own page (CSRF guard). There is no login: like the AVADO Admin,
the trust boundary is the LAN/VPN.

## Volumes

One volume, `rocketpool:/rocketpool`, the same as 0.0.106:

- `/rocketpool/data`: Smartnode's data dir: `wallet`, `password`, `validators/`, `api-tokens.json`,
  `address`, `custom-keys/`, and the package's own state files (`.avado-package-version`,
  `.avado-backup-fingerprint`, the approved-keys list). No code path moves, overwrites or deletes
  `wallet` or `password`.
- `/rocketpool/backups`: wallet backups (below).

The rendered Smartnode settings (`/srv/rocketpool/user-settings.yml`, from `build/user-settings.template`)
are rewritten on every start and are not on the volume. The environment (`NETWORK`, `EXECUTIONCLIENT`,
`CONSENSUSCLIENT`) comes from the package settings in the AVADO Admin.

## Backups

Every backup is a directory in `/rocketpool/backups`, mode 700, with byte-for-byte verified copies.

| Name | Made by | Kind (`backup-info.json`) | Pruned? |
|---|---|---|---|
| `<old version>-<YYYYMMDDTHHMMSSZ>` (`legacy-<ts>` for a 0.0.x install without a version marker) | `start-node.sh`, before the daemon starts, when the package version or the wallet fingerprint changed | `package-upgrade` | The newest 3 are kept. `"keepForever": true` ones are never pruned and don't count toward the 3: the first upgrade backup, and the first upgrade from a pre-1.0 install. |
| `<ts>-after-wallet-create` | the backend, right after `wallet/recover` or `wallet/search-and-recover` first saves a wallet | `wallet-create`, `keepForever: true` | never |
| `<ts>-manual-download` | the backend, when the owner downloads the current wallet | `manual`, `keepForever: true` | never |
| `<ts>-before-wallet-change` | older builds | none | never |
| `mnemonic-archive-<ts>` | the owner, archiving 0.0.x's plaintext `mnemonic` file (copied, verified, then removed) | `mnemonic-archive` | never |

Pruning only ever removes `<version>-<ts>` directories whose `backup-info.json` has kind `package-upgrade`.
A failed upgrade backup (for example a full disk) stops the daemon (exit 78) and the UI shows why.

`GET /api/avado/status` lists the backups (`name`, `createdAt`, `kind`). The owner can download one:

```
POST /api/avado/backups/download
Content-Type: application/json
X-Avado-Request: 1

{"name": "<backup directory name>"}   or   {"name": "current"}
```

The answer is a zip (`Content-Disposition: attachment; filename="avado-rocketpool-backup-<first 8 hex of
the node address>-<YYYYMMDD>.zip"`) with a `README.txt` on restoring, and the backup directory. `"current"`
first makes a fresh `<ts>-manual-download` backup. Names are matched against the actual directory list;
anything else is 404. At most 2 downloads run at once (429 otherwise). The zip holds the wallet and its
password: whoever has it controls the node wallet.

## Rollback to 0.0.106

Support only, and only if 1.0 can't run on a box:

1. **Turn off autoupdate for the Rocket Pool package first.** The DAPPMANAGER autoupdater installs any
   higher version, so it would put 1.0.x back within an hour.
2. Install 0.0.106. It uses the same volume, wallet and password; the backup from before 1.0 is still
   in `/rocketpool/backups`.
3. If the owner archived the legacy `mnemonic` file in 1.0, 0.0.106's "restore backup" refuses zips
   without `data/mnemonic`. Copy it back from `backups/mnemonic-archive-<ts>/mnemonic` if needed.

Re-installing 1.0 later makes a new backup only if the wallet changed in the meantime.

## Release prerequisites

- **Teku ≥ 0.0.76 with the keymanager log fix** (AVADO-DNP-Teku `drop-rp-lookup`) must be released
  before this package reaches production. The backend only imports keys into Teku from that version
  on (`TEKU_SAFE_IMPORT_VERSION` in `build/backend/src/reconcile/clients.ts`), because older Teku logs
  the keystore and password of a failed import. With an older Teku, new megapool keys wait in
  "client-update-needed".
- **The UI tag in `CLIENT_UI_VERSION`** (`build/Dockerfile`) must exist in AVADO-Client-UI. The release
  build clones it; until it exists, the build fails.

## Testing

- Backend: `cd build/backend && yarn install --frozen-lockfile && yarn lint && yarn test` (Node 22).
  The same `yarn test` runs in the Dockerfile's backend stage, so an image can't be built on a failing
  suite. Tests use fixed clocks; none may depend on today's date.
- Start script and backups: `build/tests/run.sh` (runs `build/tests/test-start-node.sh` in the runtime's
  Debian base with Docker; `--local` runs it in the current shell).
- Image: `docker compose build`, then `build/tests/boot-test.sh` (set `BOOT_OLD_DAEMON` to a Smartnode
  v1.13.5 `rocketpoold` binary to test with a wallet made the way package 0.0.106 made it).
- The GitHub CI only builds the image (which runs the backend tests). It does not run the shell tests or
  the boot test, so run them before a release.

## Web UI

The UI is the Rocket Pool app of [AVADO-Client-UI](https://github.com/AvadoDServer/AVADO-Client-UI)
(`yarn build:rocketpool`), built in `build/Dockerfile` from the tag in `CLIENT_UI_VERSION` and served
by the backend (`build/backend`) from `/usr/local/ui`.

Test builds of an unreleased UI: `scripts/stage-local-client-ui.sh /path/to/AVADO-Client-UI`, then
`docker compose build --build-arg CLIENT_UI_SOURCE=local`. Releases always use the pinned tag.

## Base images

`build/Dockerfile` pins `node:22.23.2-bookworm` and `node:22.23.2-bookworm-slim` by digest (`NODE_IMAGE`,
`NODE_SLIM_IMAGE`). Update tag and digest together (`docker buildx imagetools inspect node:<tag>`).

## Development

Install the AVADO SDK:
```
npm i -g https://github.com/AvadoDServer/AVADOSDK.git
```

`avadosdk build` builds the package and uploads it to your AVADO box's IPFS server.

## Update flow & tagging your repo

This is a suggested flow to upgrade your package when you want to release a new version:

```
avadosdk increase patch
avadosdk build --provider http://80.208.229.228:5001
git add dappnode_package.json docker-compose.yml releases.json
git commit -m"new release"
git push
npx release-it
```
