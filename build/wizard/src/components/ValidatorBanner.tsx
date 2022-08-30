import React from "react";
import { DappManagerHelper } from "./DappManagerHelper";
import { RestApi } from "./RestApi";
import { networkType, consusClientType, minipoolStatusType, nodeStatusType } from "./Types"
import { KeyManagerHelper } from "./KeyManagerHelper";

interface Props {
    dappManagerHelper: DappManagerHelper,
    minipoolStatus: minipoolStatusType,
    nodeStatus: nodeStatusType,
    keyManagerHelper: KeyManagerHelper,
    setKeyManagerHelper: (keyManagerHelper: KeyManagerHelper) => void,
    utils: any
}

const ValidatorBanner = ({ dappManagerHelper, minipoolStatus, setKeyManagerHelper, keyManagerHelper, utils, nodeStatus }: Props) => {

    const [packages, setPackages] = React.useState<string[]>();
    const [network, setNetwork] = React.useState<networkType>();
    const [consensusClient, setConsensusClient] = React.useState<consusClientType>();

    React.useEffect(() => {
        if (dappManagerHelper) {
            dappManagerHelper?.getEnvs().then(
                (envs) => {
                    setNetwork(envs["NETWORK" as keyof typeof envs] as networkType ?? "mainnet");
                    setConsensusClient(envs["CONSENSUSCLIENT" as keyof typeof envs] as consusClientType ?? "prysm");
                }
            )
            dappManagerHelper.getPackages().then(
                (packs) => setPackages(packs)
            )
        }
    }, [dappManagerHelper]);


    const [message, setMessage] = React.useState<string>();
    React.useEffect(() => {
        if (packages && network && consensusClient) {
            const packageNames = {
                "prater": {
                    "teku": "teku.avado.dnp.dappnode.eth",
                    "prysm": "eth2validator-prater.avado.dnp.dappnode.eth"
                },
                "mainnet": {
                    "teku": "teku.avado.dnp.dappnode.eth",
                    "prysm": "eth2validator.avado.dnp.dappnode.eth"
                },
            }

            const validatorPackage = packageNames[network][consensusClient]


            if (packages.includes(packageNames[network]["teku"]) && packages.includes(packageNames[network]["prysm"])) {
                setMessage("You have both Teku and Prysm installed. Make sure you do NOT add your keys to both, or you will get slashed.")
            }

            if (!packages.includes(validatorPackage)) {
                setMessage(`Error: "${consensusClient}" validator is not installed`)

                // TODO: Propose to use other client instead (if installed)? Toggle env is easy to implement 
            } else {
                const tokenPath = (consensusClient === "teku") ? `/data/data-${network}/validator/key-manager/validator-api-bearer` : `/usr/share/nginx/wizard/auth-token.txt`;
                const keyManagerAPIUrl = (consensusClient === "teku") ? "https://teku.my.ava.do:5052" : "http://eth2validator" + (network === "prater" ? "-prater" : "") + ".my.ava.do:7500"

                dappManagerHelper.getFileContentFromContainer(tokenPath, validatorPackage).then(
                    (apiToken) => {
                        // console.log(apiToken)
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
        if (keyManagerHelper && minipoolStatus.minipools) {

            const setAllValidatorsInfo = async () => {
                const pubKeys = minipoolStatus.minipools.map(minipool => "0x" + minipool.validatorPubkey)
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
        if (validatorsInfo) {
            // console.dir(validatorsInfo)
            const misses = validatorsInfo.filter(i => {
                return i.feerecipient !== ERROR && i.feerecipient.toUpperCase() !== nodeStatus.feeRecipientInfo.smoothingPoolAddress.toUpperCase()
            })
            setMisconfiguredValidators(misses)
        }
    }, [validatorsInfo]);

    const setFeeRecipients = async () => {
        if (misconfiguredValidators) {
            // set for all minipool validators (for Prysm workaround: non persistend setting via API)
            keyManagerHelper.setFeeRecipients(minipoolStatus, nodeStatus.feeRecipientInfo.smoothingPoolAddress, true)
        }
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
                                    return <p className="has-text-centered">Minipool {validator} is not imported in your Beacon Chain validator.</p>
                                    //TODO: import now
                                })}
                            </div>
                        </section>
                    )}

                    {/* all validators have the correct fee recepient? */}
                    {misconfiguredValidators && misconfiguredValidators.length > 0 && (
                        <section className="hero is-danger">
                            <div className="hero-body is-small">
                                {misconfiguredValidators.map(validatorInfo => {
                                    return <>
                                        <p className="has-text-centered">Validator {utils.beaconchainUrl(validatorInfo.address, "0x" + validatorInfo.address.substring(0, 10) + "...")} must have {utils.etherscanAddressUrl(nodeStatus.feeRecipientInfo.smoothingPoolAddress)} as fee recipient.</p>
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

