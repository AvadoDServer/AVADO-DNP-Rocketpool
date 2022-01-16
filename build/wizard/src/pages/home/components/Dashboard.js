import React from "react";
import axios from "axios";
import config from "../../../config";
import 'react-confirm-alert/src/react-confirm-alert.css'; // Import css
import rocketpoollogo from "../../../assets/rocketpool.png";
import autobahn from "autobahn-browser";
import MiniPoolStatus from "./MiniPoolStatus";
import NodeStatus from "./NodeStatus";
import BackupDashboard from "./BackupDashboard";
import LogView from "./LogView";
import InitWallet from "./InitWallet";
import FundWallet from "./FundWallet";
import RegisterNode from "./RegisterNode";
import SetWithdrawalAddress from "./SetWithdrawalAddress";
import CreateMinipool from "./CreateMinipool";
import NavigationBar from "./NavigationBar";
import Header from "./Header";
import Welcome from "./Welcome";
import WalletStatus from "./WalletStatus";

// https://github.com/sponnet/avado-portal/blob/master/src/pages/Home.js#L4-L7
const states = {
    WELCOME: Symbol("Welcome"),
    CREATE_WALLET: Symbol("Create Wallet"),
    FUND_NODE: Symbol("Fund Node"),
    // CHECKINTERNET: 2,
    // CHECKUPDATES: 3,
    // PROVISIONING: 4,
    // ENABLEAUTOUPDATES: 5,
    FINISHED_STATUS: Symbol("Finished - Status")
};

const Comp = () => {
    const [walletStatus, setWalletStatus] = React.useState();
    const [minipoolStatus, setMinipoolStatus] = React.useState();
    const [nodeStatus, setNodeStatus] = React.useState();
    const [nodeSyncStatus, setNodeSyncStatus] = React.useState();
    const [wampSession, setWampSession] = React.useState();
    const [viewState, setViewState] = React.useState(states.WELCOME);
    const [navBar, setNavBar] = React.useState();

    const stateName = (state) => Object.keys(states).find((k) => states[k] === state);

    React.useEffect(() => {
        console.log(`In state  ${stateName(viewState)}`);
    }, [viewState]);

    React.useEffect(() => {
        if (!navBar && walletStatus && minipoolStatus) {
            if (minipoolStatus.status === "success" && minipoolStatus.minipools.length > 0) {
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
        if (!nodeStatus) {
            setViewState(states.WELCOME);
            return;
        }
        if (nodeStatus.status === "error" && nodeStatus.error.includes("rocketpool wallet init")) {
            setViewState(states.CREATE_WALLET);
            return;
        }
        if (nodeStatus.status === "success"
            && nodeStatus.accountAddress !== "0x0000000000000000000000000000000000000000"
            && nodeStatus.registered === false
        ) {
            setViewState(states.FUND_NODE);
            return;
        }

        if (nodeStatus.status === "success") {
            setViewState(states.FINISHED_STATUS);
            return;
        }
    }, [nodeStatus, walletStatus, minipoolStatus]);


    React.useEffect(() => {
        const url = "ws://wamp.my.ava.do:8080/ws";
        const realm = "dappnode_admin";
        const connection = new autobahn.Connection({
            url,
            realm
        });
        connection.onopen = session => {
            console.debug("CONNECTED to \nurl: " + url + " \nrealm: " + realm);
            setWampSession(session);
        };
        // connection closed, lost or unable to connect
        connection.onclose = (reason, details) => {
            this.setState({ connectedToDAppNode: false });
            console.error("CONNECTION_CLOSE", { reason, details });
        };
        connection.open();
    }, []);

    const rpdDaemon = async (command, callback) => {
        await axios.post(`${config.api.HTTP}/rpd`, { command: command }, { timeout: 5 * 60 * 1000 }).then((res) => {
            const data = JSON.parse(res.data);
            console.log(`rocketpoold api ${command}: ` + res.data);
            callback(data);
        })
    }

    const updateMiniPoolStatus = () => rpdDaemon("minipool status", (data) => setMinipoolStatus(data));
    const updateNodeStatus = () => rpdDaemon("node status", (data) => setNodeStatus(data));
    const updateNodeSyncStatus = () => rpdDaemon("node sync", (data) => setNodeSyncStatus(data));
    const updateWalletStatus = () => rpdDaemon("wallet status", (data) => setWalletStatus(data));

    React.useEffect(() => {
        updateMiniPoolStatus();
        updateNodeStatus();
        updateNodeSyncStatus();
        updateWalletStatus();
    }, []); // eslint-disable-line



    return (
        <div className="dashboard has-text-white">
            <Header rocketpoollogo={rocketpoollogo} nodeSyncStatus={nodeSyncStatus} />
            <NavigationBar navBar={navBar} setNavBar={setNavBar} />

            <section className="has-text-white">
                <div className="columns is-mobile">
                    <div className="column">
                        {navBar === "Welcome" && (
                            <div>
                            <Welcome />
                            </div>
                        )}

                        {navBar === "Setup" && (
                            <div>
                                <InitWallet walletStatus={walletStatus} updateWalletStatus={updateWalletStatus} rpdDaemon={rpdDaemon} />
                                <FundWallet nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />
                                <RegisterNode nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />
                                <SetWithdrawalAddress nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />
                                <CreateMinipool nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />
                            </div>
                        )}

                        {navBar === "Status" && (
                            <div>
                                <div className="columns">
                                    <div className="column is-half">
                                        <NodeStatus nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} nodeSyncStatus={nodeSyncStatus} updateNodeSyncStatus={updateNodeSyncStatus} />
                                    </div>
                                    <div className="column is-half">
                                        <WalletStatus nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus}/>
                                    </div>
                                </div>
                                <br />
                                <MiniPoolStatus minipoolStatus={minipoolStatus} />
                            </div>
                        )}

                        {navBar === "Admin" && (
                            <div>
                                <BackupDashboard wampSession={wampSession} />
                                <br />
                                <LogView wampSession={wampSession} />
                                <br />
                                <a href="http://my.ava.do/#/Packages/rocketpool.avado.dnp.dappnode.eth/detail">Avado Rocket Pool package details</a>
                            </div>
                        )}

                    </div>
                </div>
            </section>

        </div>

    )
}


export default Comp;