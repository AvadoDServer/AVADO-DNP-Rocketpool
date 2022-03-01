import React from "react";
import web3 from "web3";
import Spinner from "./Spinner";
import ApproveRpl from "./ApproveRpl";
import StakeRPL from "./StakeRPL";
import DepositETH from "./DepositETH";
import DownloadBackup from "./DownloadBackup";

const CreateMinipool = ({ utils, nodeStatus, rplPriceData, updateNodeStatus, minipoolStatus, updateMiniPoolStatus, nodeFee, rpdDaemon }) => {
    const minNodeFee = 0.05;
    const maxNodeFee = 0.2;
    const [rplAllowanceOK, setRplAllowanceOK] = React.useState(false);

    React.useEffect(() => {
        if (nodeFee) {
            console.assert(nodeFee.minNodeFee, minNodeFee);
            console.assert(nodeFee.maxNodeFee, maxNodeFee);
        }
    }, [nodeFee]);

    return (
        <div>
            {nodeStatus && (
                <>
                    <h3 className="title is-3 has-text-white">Add minipool</h3>
                    {(minipoolStatus && minipoolStatus.minipools && minipoolStatus.minipools.length > 0) ? (
                        <div className="content">
                            <p>Congratulations the minipool on your node has been created. Now, you have to wait for the other half to be deposited (after a 12 hour safety period).</p>
                            <p>Depositing this second half will require gas, so leave some ETH in your wallet for now.</p>
                            <p>You can follow the status on the <b>Status</b> page</p>
                            <br />
                            <p>Don't forget to download a backup once your validator is active.</p>
                            <DownloadBackup />
                        </div>
                    ) : (
                        <div>
                            <p>TODO: extra info about procedure</p>
                            <div>
                                <h4 className="title is-4 has-text-white">Parameters</h4>
                                <div className="content">
                                    <dl>
                                        <dt>Node commision fee</dt>
                                        <dd>As a node operator you earn half of the validator's total ETH rewards, plus an extra commission.
                                            The commission rate is based on how many minipools are in the queue and how much rETH is available in the staking pool, waiting to be staked. The lowest it can go is 5%, and the highest it can go is 20%. Once your minipool is created, its commission rate will be locked until you exit the validator and close the minipool. If you specify a commision that is higher than the current network's commision, ...<br />
                                            TODO: replace with fixed slippage setting and just inform user.<br />
                                            <b>Current Node commision fee: (Rocket Pool network)</b>{nodeFee.nodeFee} (Minimum: {minNodeFee}, maximum: {maxNodeFee})
                                        </dd>
                                        <dt>RPL</dt>
                                        <dd>You can ... but it must be higher than {rplPriceData ? Math.ceil(utils.displayAsETH(rplPriceData.minPerMinipoolRplStake)) : <Spinner />} RPL
                                        </dd>
                                    </dl>
                                </div>


                                <ApproveRpl utils={utils} rplAllowanceOK={rplAllowanceOK} setRplAllowanceOK={setRplAllowanceOK} rpdDaemon={rpdDaemon} />
                                <StakeRPL
                                    utils={utils}
                                    nodeStatus={nodeStatus}
                                    rplPriceData={rplPriceData}
                                    rplAllowanceOK={rplAllowanceOK}
                                    updateNodeStatus={updateNodeStatus}
                                    rpdDaemon={rpdDaemon}
                                />

                                <DepositETH
                                    utils={utils}
                                    nodeStatus={nodeStatus}
                                    nodeFee={nodeFee}
                                    rplPriceData={rplPriceData}
                                    rplAllowanceOK={rplAllowanceOK}
                                    nodeStatus={nodeStatus}
                                    updateNodeStatus={updateNodeStatus}
                                    rpdDaemon={rpdDaemon}
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