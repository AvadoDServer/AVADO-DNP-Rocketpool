import React from "react";
import Spinner from "./Spinner";
import { AutobahnContext } from "./AutobahnContext";
import { StoreContext } from "./StoreContext";
import InstallPackage from "./InstallPackage";
import { rplPriceDataType, nodeSyncProgressResponseType } from "./Types"


interface Props {
    utils: any,
    nodeSyncStatus?: nodeSyncProgressResponseType,
    setNavBar: any
    rplPriceData?: rplPriceDataType,
}

const Welcome = ({ utils, nodeSyncStatus, setNavBar, rplPriceData }: Props) => {

    const { packages } = React.useContext(AutobahnContext);
    const { store } = React.useContext(StoreContext);

    // if (packages && store) {
    //     console.log("P", packages);
    //     console.log("S", store);
    // }

    if (!packages || !store || !nodeSyncStatus) {
        return <>Loading...</>
    }


    let prerequisites = [];
    let extraSoftwareNeeded = false;

    const execution_engines = [
        "ethchain-geth.public.dappnode.eth",
        "avado-dnp-nethermind.public.dappnode.eth",
    ]

    // check if ETH1 (geth) node is installed
    const eth1Node = Object.keys(packages).find(k => execution_engines.includes(packages[k].manifest.name));
    if (!eth1Node) {
        prerequisites.push(
            {
                description: "A fully synced Ethereum node",
                suggestedpackages: store.packages.filter((p: any) => execution_engines.includes(p.manifest.name))
            }
        );
        extraSoftwareNeeded = true;
    } else {
        prerequisites.push(
            {
                description: "A fully synced Ethereum node",
                installed: packages[eth1Node]
            }
        );
    }


    // check if ETH2 BC is installed
    const eth2BC = Object.keys(packages).find((k) => {
        return ((
            packages[k].name === "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth") ||
            packages[k].name === "nimbus.avado.dnp.dappnode.eth" ||
            packages[k].name === "lighthouse.avado.dnp.dappnode.eth" ||
            packages[k].name === "teku.avado.dnp.dappnode.eth"
        )
    });
    if (!eth2BC) {
        prerequisites.push(
            {
                description: "An ETH2.0 beacon chain",
                suggestedpackages: [
                    store.packages.find((p: any) => { return p.manifest.name === "teku.avado.dnp.dappnode.eth" }),
                    store.packages.find((p: any) => { return p.manifest.name === "nimbus.avado.dnp.dappnode.eth" }),
                    // store.packages.find((p: any) => { return p.manifest.name === "lighthouse.avado.dnp.dappnode.eth" }),
                    // store.packages.find((p: any) => { return p.manifest.name === "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth" })
                ]
            }
        );
        extraSoftwareNeeded = true;
    } else {
        prerequisites.push(
            {
                description: "An ETH2.0 beacon chain",
                installed: packages[eth2BC]
            }
        );
    }

    // check if ETH2 Validator is installed
    const eth2V = Object.keys(packages).find((k) => {
        return ((
            packages[k].name === "eth2validator.avado.dnp.dappnode.eth") ||
            packages[k].name === "teku.avado.dnp.dappnode.eth"
        )
    });
    if (!eth2V) {
        prerequisites.push(
            {
                description: "An ETH2.0 validator client",
                suggestedpackages: [
                    store.packages.find((p: any) => { return p.manifest.name === "teku.avado.dnp.dappnode.eth" }),
                    store.packages.find((p: any) => { return p.manifest.name === "nimbus.avado.dnp.dappnode.eth" }),
                    store.packages.find((p: any) => { return p.manifest.name === "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth" })
                ]
            }
        );
        extraSoftwareNeeded = true;
    } else {
        prerequisites.push(
            {
                description: "An ETH2.0 validator client",
                installed: packages[eth2V]
            }
        );
    }




    const StatusButton = () => {
        if (extraSoftwareNeeded) {
            return (
                <>
                    <span className="icon-text">
                        <p><span className="icon">
                            <Spinner />
                        </span>
                            <span>Waiting for all required packages before continuing</span>
                        </p>
                    </span>
                    <br />
                    <button className="button" disabled>Start setup</button>
                </>
            )

        }
        if (!nodeSyncStatus) {
            return (
                <>
                    <span className="icon-text">
                        <p><span className="icon">
                            <Spinner />
                        </span>
                            <span>Waiting for node initialization</span>
                        </p>
                    </span>
                    <br />
                    <button className="button" disabled>Start setup</button>
                </>
            )
        }

        if (!nodeSyncStatus.ecStatus.primaryEcStatus.isSynced) {
            return (
                <>
                    <span className="icon-text">
                        <p><span className="icon">
                            <Spinner />
                        </span>
                            <span>Please wait until your ETH1 node & Beacon chain are synced</span>
                        </p>
                    </span>
                    <br />
                    <button className="button" disabled>Start setup</button>
                </>
            )
        }

        if (!nodeSyncStatus.bcStatus.primaryEcStatus.isSynced) {
            return (
                <>
                    <span className="icon-text">
                        <p><span className="icon">
                            <Spinner />
                        </span>
                            <span>Please wait until your Beacon chain node is synced</span>
                        </p>
                    </span>
                    <br />
                    <button className="button" disabled>Start setup</button>
                </>
            )
        }

        return (<button className="button" onClick={() => { setNavBar("Setup") }} >Start setup</button>)
    }

    return (
        <div>

            <div className="content">
                <div className="is-size-2">Run a RocketPool Minipool on your AVADO</div>
                <p></p>
                <p>To complete the onboarding wizard you will need these things:</p>
                <ol>
                    {prerequisites.map((prerequisite, i) => {
                        if (prerequisite.suggestedpackages) {
                            //need to install a package
                            return (<li key={i}>{prerequisite.description}<br />
                                <InstallPackage name={prerequisite.suggestedpackages[0].manifest.name} />
                            </li>);
                        } else {
                            return (<li key={i}>{prerequisite.description} - OK ✓ Installed <b>{prerequisite.installed.manifest.title}</b></li>);
                        }
                    })}
                    {/* <li>A fully synced Ethereum node. Install the <b>Ethereum Node (Geth)</b> from the <a target="_blank" href="http://my.ava.do/#/installer">DappStore</a></li>
                    <li>A fully synced Beacon chain. Install the <b>Prysm ETH2.0 Beacon Chain</b> from the <a target="_blank" href="http://my.ava.do/#/installer">DappStore</a></li> */}
                    <li>An Ethereum wallet with 16 ETH + some gas to deposit it in your minipool (0.4 ETH should be enough)</li>
                    <li>An Ethereum wallet with the necessary amount of RPL to stake. {rplPriceData && (<>Minimum stake is currently <b>{Math.ceil(utils.displayAsETH(rplPriceData.minPer16EthMinipoolRplStake))} RPL</b></>)}</li>
                    <li>An Ethereum wallet to receive your staking rewards into. This can be an empty wallet, or a cold storage wallet - as you prefer.</li>
                </ol>
                <p>Check the <a target="_blank" href="https://wiki.ava.do/en/tutorials/rocketpool">Avado Rocket Pool Wiki page</a> to learn what it takes to run a Rocket Pool node - and info on how to obtain RPL.</p>

                {/* <p>After you checked the risks and responsabilities, and have secured the necessary prerequisites, click <b>Setup</b> in the menu bar to configure your node.</p> */}

                <StatusButton />

            </div>
        </div>

    );
};

export default Welcome


