import React from "react";
import config from "../config";
import BackupDashboard from "./BackupDashboard";
import LogView from "./LogView";
import Spinner from "./Spinner";
import RpdCommand from "./RpdCommand";

const packageName = "rocketpool.avado.dnp.dappnode.eth";

interface Props {
    wampSession: any,
    rpdDaemon: any,
    utils: any
}

const AdminPage = ({ wampSession, rpdDaemon, utils }: Props) => {
    const [isRestartValidator, setIsRestartValidator] = React.useState(false);
    const [isRestartRpNode, setIsRestartRpNode] = React.useState(false);
    const [network, setNetwork] = React.useState("");

    React.useEffect(() => {
        if (wampSession)
            getNetwork();
    }, [wampSession]) // eslint-disable-line

    const restartRpNode = () => {
        setIsRestartRpNode(true);
        fetch(`${config.api.HTTP}/restart-rocketpool-node`)
            .then(res => res.text())
            .then(data => {
                setIsRestartRpNode(false);
                alert(data);
            }
            );
    }

    const getNetwork = async () => {
        const packagesRaw = await wampSession.call("listPackages.dappmanager.dnp.dappnode.eth", [],);
        const packages = JSON.parse(packagesRaw);
        if (packages.success) {
            setNetwork(packages.result.find((r: any) => r.name === packageName).envs.NETWORK)
        }
    }

    return (
        <div>
            {/* <p>
                <a href="http://my.ava.do/#/Packages/rocketpool.avado.dnp.dappnode.eth/detail" target="_blank">Avado Rocket Pool package details</a>
            </p> */}
            <br />
            <article className="message is-warning">
                <div className="message-header">
                    <p>Warning</p>
                    {/* <button className="delete" aria-label="delete"></button> */}
                </div>
                <div className="message-body">
                    These are some admin functions of the Rocketpool package. Please proceed with caution!
                </div>
            </article>
            <h2 className="title is-3 has-text-white">Backup and Restore</h2>
            <BackupDashboard wampSession={wampSession} />
            <LogView wampSession={wampSession} />
            <br />
            <RpdCommand rpdDaemon={rpdDaemon} />
            <br />
            <h2 className="title is-3 has-text-white">Restart RPD</h2>
            <div className="field">
                <button className="button" onClick={restartRpNode} disabled={isRestartRpNode}>Restart Rocket Pool Node{isRestartRpNode ? <Spinner /> : ""}</button>
            </div>
            <br />
            <h2 className="title is-3 has-text-white">Switch network from mainnet to testnet (Prater)</h2>
            {network && (<p><b>Current network: </b>{network}</p>)}
        </div>
    );
};

export default AdminPage