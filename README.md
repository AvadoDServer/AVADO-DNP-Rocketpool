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

## Prater testnet


Add Goerli RPL to metamask: contract 0x5e932688e81a182e3de211db6544f98b8e4f89c7












