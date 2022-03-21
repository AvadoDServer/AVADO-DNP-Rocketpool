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
    const [miniPoolsCount,setMiniPoolsCount] = React.useState(minipoolStatus?.minipools?.length || 1);

    React.useEffect(() => {
        if (nodeFee && nodeFee.status === "success") {
            console.assert(nodeFee.minNodeFee, minNodeFee);
            console.assert(nodeFee.maxNodeFee, maxNodeFee);
        }
    }, [nodeFee]);

    const addAnother = () => {
        setMiniPoolsCount(miniPoolsCount+1);
    }

    return (
        <div>
            {nodeStatus && nodeFee?.status === "success" && (
                <>
                    <h3 className="title is-3 has-text-white">Add minipool</h3>
                    {(minipoolStatus && minipoolStatus.minipools && minipoolStatus.minipools.length >= miniPoolsCount) ? (
                        <div className="content">
                            <p>Congratulations the minipool on your node has been created. Now, you have to wait for the other half to be deposited (after a 12 hour safety period).</p>
                            <p>Depositing this second half will require gas, so leave some ETH in your wallet to pay for the gas.</p>
                            <br />
                            <div class="columns">
                                <div class="column is-two-thirds">
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
                            <p>After downloading your backup, you can follow the status on the <a onClick={() => { setNavBar("Status") }}>Status</a> page</p>
                            <button className="button" onClick={()=>{addAnother()}}>Add another</button>
                        </div>
                    ) : (
                        <div>
                            <p>Create a minipool. This involves 3 steps</p>
                            <br />
                            <div>
                                <ApproveRpl utils={utils} rplAllowanceOK={rplAllowanceOK} setRplAllowanceOK={setRplAllowanceOK} rpdDaemon={rpdDaemon} />
                                <StakeRPL
                                    count = {miniPoolsCount}
                                    utils={utils}
                                    nodeStatus={nodeStatus}
                                    rplPriceData={rplPriceData}
                                    rplAllowanceOK={rplAllowanceOK}
                                    updateNodeStatus={updateNodeStatus}
                                    rpdDaemon={rpdDaemon}
                                />
                                <DepositETH
                                    count = {miniPoolsCount}
                                    utils={utils}
                                    nodeStatus={nodeStatus}
                                    nodeFee={nodeFee}
                                    rplPriceData={rplPriceData}
                                    rplAllowanceOK={rplAllowanceOK}
                                    nodeStatus={nodeStatus}
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