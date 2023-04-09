import React, { useContext } from "react";
import axios from "axios";
import config from "../config";
import 'react-confirm-alert/src/react-confirm-alert.css'; // Import css
import rocketpoollogo from "../assets/rocketpool.png";
import MiniPoolStatus from "./MiniPoolStatus";
import NodeStatus from "./NodeStatus";
import NavigationBar from "./NavigationBar";
import Header from "./Header";
import Welcome from "./Welcome";
import WalletStatus from "./WalletStatus";
import SetupWizard from "./SetupWizard";
import AdminPage from "./AdminPage";
import RewardsPage from "./RewardsPage"
import NetworkBanner from "./NetworkBanner";
import Utils from "./utils";
import ValidatorBanner from "./ValidatorBanner";
import { DappManagerHelper } from "./DappManagerHelper";
import SmoothingPoolBanner from "./SmoothingPoolBanner";
import { minipoolStatusType, nodeFeeType, nodeStatusType, nodeSyncProgressResponseType, rplPriceDataType, walletStatusType } from "./Types";
import { KeyManagerHelper } from "./KeyManagerHelper";

export const packageName = "rocketpool.avado.dnp.dappnode.eth";

const autobahn = require('autobahn-browser')
// const JSONbig = require('json-bigint');

const Comp = () => {
    const [network, setNetwork] = React.useState<string>();
    const [utils, setUtils] = React.useState<Utils>();

    const [walletStatus, setWalletStatus] = React.useState<walletStatusType>({
        "status": "success",
        "error": "",
        "passwordSet": false,
        "walletInitialized": false,
        "accountAddress": ""
    });
    const [minipoolStatus, setMinipoolStatus] = React.useState<minipoolStatusType>({
        "status": "error",
        "error": "",
        "minipools": [],
        "latestDelegate": "",
        isAtlasDeployed: false
    });
    const [nodeStatus, setNodeStatus] = React.useState<nodeStatusType>();
    const [nodeSyncStatus, setNodeSyncStatus] = React.useState<nodeSyncProgressResponseType>();
    const [nodeFee, setNodeFee] = React.useState<nodeFeeType>();
    const [rplPriceData, setRplPriceData] = React.useState<rplPriceDataType>();

    const [wampSession, setWampSession] = React.useState();
    const [navBar, setNavBar] = React.useState("Welcome");

    const dappManagerHelper = React.useMemo(() => wampSession ? new DappManagerHelper(packageName, wampSession) : undefined, [wampSession]);

    const [keyManagerHelper, setKeyManagerHelper] = React.useState<KeyManagerHelper>();

    React.useEffect(() => {
        if (walletStatus && minipoolStatus) {
            // debugger;
            if (minipoolStatus.status === "success" && minipoolStatus.minipools && minipoolStatus.minipools.length > 0) {
                setNavBar("Status");
                return;
            }
            if (!walletStatus.walletInitialized) {
                setNavBar("Welcome");
                return;
            }
            if (walletStatus.passwordSet) {
                setNavBar("Setup");
                return;
            }
        }
    }, [walletStatus, minipoolStatus]);

    React.useEffect(() => {
        axios.get(`${config.api.HTTP}/network`).then((res) => {
            const network = res.data;
            setNetwork(network);
            console.log(`Using the ${network} network`);

            const utils = new Utils(network);
            setUtils(utils);
        })
    }, []);

    React.useEffect(() => {
        const url = "ws://wamp.my.ava.do:8080/ws";
        const realm = "dappnode_admin";
        const connection = new autobahn.Connection({
            url,
            realm
        });
        connection.onopen = (session: any) => {
            console.debug("CONNECTED to \nurl: " + url + " \nrealm: " + realm);
            setWampSession(session);
        };
        // connection closed, lost or unable to connect
        connection.onclose = (reason: any, details: any) => {
            console.error("CONNECTION_CLOSE", { reason, details });
            setWampSession(undefined);

        };
        connection.open();
    }, []);

    const rpdDaemon = async (command: string, callback: (data: any) => void, error?: (error: any) => void) => {
        await axios.post(`${config.api.HTTP}/rpd`, { command: command }, { timeout: 5 * 60 * 1000 }).then((res) => {
            // put quotes about bigNumbers to avoid parsing issues
            var json = res.data.replace(/([\[:])?(\d{9,})([,\}\]])/g, "$1\"$2\"$3");
            console.log(`rocketpoold api ${command}: ` + json);
            const data = JSON.parse(res.data);
            callback(data);
        }).catch(e => { if (error) error(e) })
    }

    const updateMiniPoolStatus = () => rpdDaemon("minipool status", (data) => setMinipoolStatus(data));
    const updateNodeStatus = () => rpdDaemon("node status", (data) => setNodeStatus(data));
    const updateNodeSyncStatus = () => rpdDaemon("node sync", (data) => setNodeSyncStatus(data));
    const updateWalletStatus = () => rpdDaemon("wallet status", (data) => setWalletStatus(data));
    const updateNodeFee = () => rpdDaemon("network node-fee", (data) => setNodeFee(data));
    const updateRplPriceData = () => rpdDaemon("network rpl-price", (data) => setRplPriceData(data));

    React.useEffect(() => {
        updateMiniPoolStatus();
        updateNodeStatus();
        updateNodeSyncStatus();
        updateWalletStatus();
        updateNodeFee();
        updateRplPriceData();
    }, []); // eslint-disable-line

    React.useEffect(() => {
        const interval = setInterval(() => {
            updateNodeFee();
            updateNodeSyncStatus();
            updateRplPriceData();
        }, 60 * 1000); // 60 seconds refresh
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="dashboard has-text-white">
            <NetworkBanner network={network} />
            <ValidatorBanner dappManagerHelper={dappManagerHelper} minipoolStatus={minipoolStatus} keyManagerHelper={keyManagerHelper} setKeyManagerHelper={setKeyManagerHelper} utils={utils} nodeStatus={nodeStatus} />
            <SmoothingPoolBanner rpdDaemon={rpdDaemon} utils={utils} updateNodeStatus={updateNodeStatus} nodeStatus={nodeStatus} keyManagerHelper={keyManagerHelper} minipoolSatus={minipoolStatus} />

            <Header utils={utils} rocketpoollogo={rocketpoollogo} nodeSyncStatus={nodeSyncStatus} nodeFee={nodeFee} rplPriceData={rplPriceData} minipoolStatus={minipoolStatus} />
            <NavigationBar navBar={navBar} setNavBar={setNavBar} />

            {!wampSession && (
                <p>Avado Connection problem. Check your browser's console log for more details.</p>
            )}

            <section className="has-text-white">
                <div className="columns is-mobile">
                    <div className="column">
                        {navBar === "Welcome" && (
                            <div>
                                <Welcome utils={utils} rplPriceData={rplPriceData} nodeSyncStatus={nodeSyncStatus} setNavBar={setNavBar} />
                            </div>
                        )}

                        {navBar === "Setup" && (
                            <div>
                                <SetupWizard
                                    utils={utils}
                                    walletStatus={walletStatus}
                                    updateWalletStatus={updateWalletStatus}
                                    nodeStatus={nodeStatus}
                                    updateNodeStatus={updateNodeStatus}
                                    rplPriceData={rplPriceData}
                                    minipoolStatus={minipoolStatus}
                                    updateMiniPoolStatus={updateMiniPoolStatus}
                                    nodeFee={nodeFee}
                                    setNavBar={setNavBar}
                                    rpdDaemon={rpdDaemon} />
                            </div>
                        )}

                        {navBar === "Status" && (
                            <div>
                                <div className="columns">
                                    <div className="column is-half">
                                        <NodeStatus utils={utils} nodeStatus={nodeStatus} nodeSyncStatus={nodeSyncStatus} />
                                    </div>
                                    <div className="column is-half">
                                        <WalletStatus utils={utils} nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} />
                                    </div>
                                </div>
                                <br />
                                <MiniPoolStatus utils={utils} minipoolStatus={minipoolStatus} />
                            </div>
                        )}

                        {navBar === "Rewards" && (
                            <RewardsPage utils={utils} rpdDaemon={rpdDaemon} />
                        )}
                        {navBar === "Admin" && (
                            <AdminPage utils={utils} wampSession={wampSession} rpdDaemon={rpdDaemon} />
                        )}
                    </div>
                </div>
            </section>

        </div>

    )
}


export default Comp;