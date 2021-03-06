import React from "react";
import web3 from "web3";
import Spinner from "./Spinner";
import ApproveRpl from "./ApproveRpl";
import StakeRPL from "./StakeRPL";
import DepositETH from "./DepositETH";
import DownloadBackup from "./DownloadBackup";

const CreateMinipool = ({ utils, nodeStatus, rplPriceData, updateNodeStatus, minipoolStatus, updateMiniPoolStatus, nodeFee, rpdDaemon, setNavBar }) => {
    const minNodeFee = 0.05;
    const maxNodeFee = 0.2;
    const [rplAllowanceOK, setRplAllowanceOK] = React.useState(false);
    const [targetCount, setTargetCount] = React.useState(1);

    React.useEffect(() => {
        if (nodeFee && nodeFee.status === "success") {
            console.assert(nodeFee.minNodeFee, minNodeFee);
            console.assert(nodeFee.maxNodeFee, maxNodeFee);
        }
    }, [nodeFee]);

    const currentMiniPoolCount = () => {
        if (nodeStatus?.minipoolCounts?.total)
            return nodeStatus?.minipoolCounts?.total
        else
            return 0
    }

    const addAnother = () => {
        setTargetCount(currentMiniPoolCount() + 1);
    }

    return (
        <div>
            {nodeStatus && nodeFee?.status === "success" && (
                <>
                    {/* <pre>{JSON.stringify(nodeStatus, 0, 2)}</pre> */}
                    <h3 className="title is-3 has-text-white">Minipool</h3>
                    {(currentMiniPoolCount() >= targetCount) ? (
                        <div className="content">
                            {/* we will only show this part when you have new- non staking minipools */}
                            {nodeStatus && nodeStatus.minipoolCounts && (nodeStatus.minipoolCounts.initialized > 0 || nodeStatus.minipoolCounts.prelaunch > 0) && (
                                <>
                                    <p>Congratulations the minipool on your node has been created. Now, you have to wait for the other half to be deposited (after a 12 hour safety period).</p>
                                    <p>Depositing this second half will require gas, so leave some ETH in your wallet to pay for the gas.</p>
                                    <p>Once the second half is deposited, remember to import the validator key (inside the backup file) into your Ethereum Validator.</p>
                                    <p>After downloading your backup, you can follow the status on the <a onClick={() => { setNavBar("Status") }}>Status</a> page</p>
                                </>
                            )}
                            <br />
                            <div className="columns">
                                <div className="column is-two-thirds">
                                    <article className="message is-warning ">
                                        <div className="message-header">
                                            <p>Download backup</p>
                                        </div>
                                        <div className="message-body">
                                            <p>Please download a backup of your whole minipool configuration now!</p>
                                            <DownloadBackup />
                                        </div>
                                    </article>
                                </div>
                            </div>
                            <br />
                            <button className="button" onClick={() => { addAnother() }}>Add another minipool / stake more RPL</button>
                        </div>
                    ) : (
                        <div>
                            <p>Create a minipool. This involves 3 steps</p>
                            <br />
                            <div>
                                <ApproveRpl utils={utils} rplAllowanceOK={rplAllowanceOK} setRplAllowanceOK={setRplAllowanceOK} rpdDaemon={rpdDaemon} />
                                <StakeRPL
                                    targetCount={targetCount}
                                    utils={utils}
                                    nodeStatus={nodeStatus}
                                    rplPriceData={rplPriceData}
                                    rplAllowanceOK={rplAllowanceOK}
                                    updateNodeStatus={updateNodeStatus}
                                    rpdDaemon={rpdDaemon}
                                />
                                <DepositETH
                                    targetCount={targetCount}
                                    utils={utils}
                                    nodeStatus={nodeStatus}
                                    nodeFee={nodeFee}
                                    rplPriceData={rplPriceData}
                                    rplAllowanceOK={rplAllowanceOK}
                                    updateNodeStatus={updateNodeStatus}
                                    updateMiniPoolStatus={updateMiniPoolStatus}
                                    rpdDaemon={rpdDaemon}
                                    setNavBar={setNavBar}
                                />
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default CreateMinipool