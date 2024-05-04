import React from "react";
import { DappManagerHelper } from "./DappManagerHelper";
import { RestApi } from "./RestApi";
import { networkType, consensusClientType, minipoolStatusType, nodeStatusType, consensusClients } from "./Types"
import { KeyManagerHelper } from "./KeyManagerHelper";
import { confirmAlert } from 'react-confirm-alert';

interface Props {
    dappManagerHelper?: DappManagerHelper | undefined,
    minipoolStatus: minipoolStatusType,
    nodeStatus?: nodeStatusType,
    keyManagerHelper?: KeyManagerHelper,
    setKeyManagerHelper: (keyManagerHelper: KeyManagerHelper) => void,
    utils: any
}

const ValidatorBanner = ({ dappManagerHelper, minipoolStatus, setKeyManagerHelper, keyManagerHelper, utils, nodeStatus }: Props) => {

    const [packages, setPackages] = React.useState<string[]>();
    const [network, setNetwork] = React.useState<networkType>();
    const [consensusClient, setConsensusClient] = React.useState<consensusClientType>();

    React.useEffect(() => {
        if (dappManagerHelper) {
            dappManagerHelper?.getEnvs().then(
                (envs) => {
                    setNetwork(envs["NETWORK" as keyof typeof envs] as networkType ?? "mainnet");
                    setConsensusClient(envs["CONSENSUSCLIENT" as keyof typeof envs] as consensusClientType ?? "prysm");
                }
            )
            dappManagerHelper.getPackages().then(
                (packs) => setPackages(packs)
            )
        }
    }, [dappManagerHelper]);


    const [message, setMessage] = React.useState<string>();
    React.useEffect(() => {
        if (packages && network && consensusClient && dappManagerHelper) {
            const packageNames = {
                "prater": {
                    "teku": "teku-prater.avado.dnp.dappnode.eth",
                    "nimbus": "nimbus-prater.avado.dnp.dappnode.eth",
                    "lighthouse": "lighthouse-prater.avado.dnp.dappnode.eth",
                    "prysm": "eth2validator-prater.avado.dnp.dappnode.eth"
                },
                "holesky": {
                    "teku": "teku-holesky.avado.dnp.dappnode.eth",
                    "nimbus": "nimbus-holesky.avado.dnp.dappnode.eth",
                    "lighthouse": "lighthouse-holesky.avado.dnp.dappnode.eth",
                    "prysm": "eth2validator-holesky.avado.dnp.dappnode.eth"
                },
                "mainnet": {
                    "teku": "teku.avado.dnp.dappnode.eth",
                    "nimbus": "nimbus.avado.dnp.dappnode.eth",
                    "lighthouse": "lighthouse.avado.dnp.dappnode.eth",
                    "prysm": "eth2validator.avado.dnp.dappnode.eth"
                },
            }

            const validatorPackage = packageNames[network][consensusClient]

            const supportedPackages = consensusClients.map(n => packageNames[network][n])

            const installedConsensusClients = packages.filter(name => supportedPackages.includes(name))

            if (installedConsensusClients.length > 1) {
                setMessage("You have multiple consensus clients installed. Make sure you do NOT add your keys to more than one client, or you will get slashed.")
            }

            if (!packages.includes(validatorPackage)) {
                setMessage(`Error: "${consensusClient}" validator is not installed`)

                // TODO: Propose to use other client instead (if installed)? Toggle env is easy to implement 
            } else {
                const tokenPaths = {
                    "teku": `/data/data-${network}/validator/key-manager/validator-api-bearer`,
                    "prysm": `/usr/share/nginx/wizard/auth-token.txt`,
                    "lighthouse": `/data/data-${network}/validators/api-token.txt`,
                    "nimbus": `/data/data-${network}/keymanagertoken`,
                }
                const tokenPath = tokenPaths[consensusClient];

                const keyManagerAPIUrls = {
                    "teku": "http://teku" + (network === "mainnet" ? "" : `-${network}`) + ".my.ava.do:5052",
                    "prysm": "http://eth2validator" + (network === "holesky" ? "-holesky" : "") + ".my.ava.do:7500",
                    "lighthouse": "http://lighthouse" + (network === "mainnet" ? "" : `-${network}`) + ".my.ava.do:9999/keymanager",
                    "nimbus": "https://nimbus" + (network === "mainnet" ? "" : `-${network}`) + ".my.ava.do:5052"
                };
                const keyManagerAPIUrl = keyManagerAPIUrls[consensusClient];

                dappManagerHelper.getFileContentFromContainer(tokenPath, validatorPackage).then(
                    (apiToken) => {
                        console.log(apiToken)
                        if (apiToken) {
                            const keyManagerAPI = new RestApi(keyManagerAPIUrl, apiToken)
                            const keyManagerHelper = new KeyManagerHelper(keyManagerAPI, dappManagerHelper, validatorPackage);
                            setKeyManagerHelper(keyManagerHelper)
                        }
                    }
                )
            }
        } else {
            setMessage(undefined)
        }
    }, [packages, network, consensusClient, dappManagerHelper]);


    type validatorInfoType = {
        address: string,
        feerecipient: string
    }
    const [validatorsInfo, setValidatorsInfo] = React.useState<validatorInfoType[]>();
    const ERROR = "-1"

    React.useEffect(() => {
        const activeMiniPools = minipoolStatus?.minipools?.filter(m => !m.finalised)
        if (keyManagerHelper && activeMiniPools) {

            const setAllValidatorsInfo = async () => {
                const pubKeys = activeMiniPools.map(minipool => "0x" + minipool.validatorPubkey)
                const feerecepients: validatorInfoType[] = await Promise.all(
                    pubKeys.map(async key => {
                        return {
                            address: key,
                            feerecipient: await keyManagerHelper.getFeeRecipient(key)
                        }
                    })
                )

                // feerecepients.forEach(element => console.log("recipient for " + element.address, element.feerecipient))

                setValidatorsInfo(feerecepients)
            }

            setAllValidatorsInfo();

        }
    }, [keyManagerHelper, minipoolStatus]);


    const [configuredValidators, setConfiguredValidators] = React.useState<string[]>();
    React.useEffect(() => {
        if (keyManagerHelper) {
            keyManagerHelper.getValidators().then(validators => {
                setConfiguredValidators(validators)
            })
        }
    }, [keyManagerHelper]);

    const [missingValidators, setMissingValidators] = React.useState<string[]>();
    React.useEffect(() => {
        if (validatorsInfo && configuredValidators) {
            // console.dir(validatorsInfo)
            // console.dir(configuredValidators)
            setMissingValidators(validatorsInfo.filter(i => !configuredValidators.includes(i.address)).map(_ => _.address))
        }
    }, [validatorsInfo, configuredValidators]);

    const [misconfiguredValidators, setMisconfiguredValidators] = React.useState<validatorInfoType[]>();
    React.useEffect(() => {
        if (validatorsInfo && nodeStatus) {
            // console.dir(validatorsInfo)
            const misses = validatorsInfo.filter(i => {
                return i.feerecipient !== ERROR && i.feerecipient.toUpperCase() !== nodeStatus.feeRecipientInfo.smoothingPoolAddress.toUpperCase()
            })
            setMisconfiguredValidators(misses)
        }
    }, [validatorsInfo, nodeStatus]);

    const setFeeRecipients = async () => {
        if (misconfiguredValidators) {
            // set for all minipool validators (for Prysm workaround: non persistend setting via API)
            keyManagerHelper!.setFeeRecipients(minipoolStatus, nodeStatus!.feeRecipientInfo.smoothingPoolAddress, true)
        }
    }


    const importValidators = async () => {
        console.dir(missingValidators)

        const importValidator = async (validator: string) => {
            // get keyStoreFile
            const keyStoreFile = await dappManagerHelper!.getFileContentFromContainer(`/rocketpool/data/validators/teku/keys/${validator}.json`)
            console.log(keyStoreFile)
            // get password
            const password = await dappManagerHelper!.getFileContentFromContainer(`/rocketpool/data/validators/teku/passwords/${validator}.txt`)
            console.log(password)
            // create message
            const message = {
                keystores: [keyStoreFile],
                passwords: [password]
            }

            console.log(message)

            // API call
            keyManagerHelper!.keyManagerAPI.post("/eth/v1/keystores", message, (res) => {
                //https://ethereum.github.io/keymanager-APIs/#/Local%20Key%20Manager/ImportKeystores
                const status = res.data.data[0].status
                window.location.reload()
            }, (e) => {
                console.log(e)
            });
        }

        missingValidators?.forEach(validator => importValidator(validator))
    }

    const confirmImportValidators = () => {
        confirmAlert({
            title: `Import validators into ${consensusClient}?`,
            message: "Make sure you only run each validator only once! Running a validator on multiple machines will lead to your validator being slashed.",
            buttons: [
                {
                    label: 'Yes',
                    onClick: () => {
                        importValidators();
                    }
                },
                {
                    label: 'No',
                    onClick: () => { }
                }
            ]
        });
    }

    return (
        <>
            {/* package is installed? */}
            {message && (
                <section className="hero is-danger">
                    <div className="hero-body is-small">
                        <p className="has-text-centered">{message}</p>
                    </div>
                </section>
            )}


            {/* only show this if we are not showing the update message */}
            {nodeStatus && nodeStatus.feeRecipientInfo.isInSmoothingPool && (
                <>
                    {/* all validators are running? */}
                    {missingValidators && missingValidators.length > 0 && (
                        <section className="hero is-danger">
                            <div className="hero-body is-small">
                                {missingValidators.map(validator => {
                                    return <p key={validator} className="has-text-centered">Minipool {validator} is not imported in your Beacon Chain validator.</p>
                                })}
                                <div className="has-text-centered">
                                    <div className="content">
                                        <button className="button" onClick={confirmImportValidators}>Add validators to {consensusClient}</button>
                                    </div>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* all validators have the correct fee recepient? */}
                    {misconfiguredValidators && misconfiguredValidators.length > 0 && (
                        <section className="hero is-danger">
                            <div className="hero-body is-small">
                                {misconfiguredValidators.map(validatorInfo => {
                                    return <>
                                        <p className="has-text-centered">Validator {utils.beaconchainUrl(validatorInfo.address, validatorInfo.address.substring(0, 10) + "...")} must have {utils.etherscanAddressUrl(nodeStatus.feeRecipientInfo.smoothingPoolAddress)} as fee recipient.</p>
                                    </>
                                })}
                                <div className="has-text-centered">
                                    <div className="content">
                                        <button className="button" onClick={setFeeRecipients}>Correct the fee recipient addresses</button>
                                    </div>
                                </div>
                            </div>
                        </section>
                    )}
                </>

            )}


        </>
    );
};

export default ValidatorBanner


