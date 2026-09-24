# AVADO RocketPool

## Installation & Documentation

https://wiki.ava.do/en/tutorials/rocketpool

Corresponding CLI tool: https://github.com/rocket-pool/smartnode

## Development

Install the AVADO SDK:
```
npm i -g https://github.com/AvadoDServer/AVADOSDK.git`
```

## Testing locally

Modify the Dockerfile in the `build` folder and test it locally using `docker-compose build` and `docker-compose up` until it works as expected.

## Building and testing

`avadosdk build` will build the package and upload to your AVADO box's IPFS server.

## update flow & tagging your repo

This is a suggested flow to upgrade your package when you want to release a new version:

```
avadosdk increase patch
avadosdk build --provider http://80.208.229.228:5001
git add dappnode_package.json docker-compose.yml releases.json
git commit -m"new release"
git push
npx release-it
```

## Web UI

The UI is the Rocket Pool app of [AVADO-Client-UI](https://github.com/AvadoDServer/AVADO-Client-UI)
(`yarn build:rocketpool`), built in `build/Dockerfile` from the tag in `CLIENT_UI_VERSION` and served
by the backend (`build/backend`) from `/usr/local/ui`.

Test builds of an unreleased UI: `scripts/stage-local-client-ui.sh /path/to/AVADO-Client-UI`, then
`docker compose build --build-arg CLIENT_UI_SOURCE=local`. Releases always use the pinned tag.

Boot test of a built image: `build/tests/boot-test.sh` (set `BOOT_OLD_DAEMON` to a Smartnode v1.13.5
`rocketpoold` binary to test with a wallet made the way package 0.0.106 made it).
