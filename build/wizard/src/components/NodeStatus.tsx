import React from "react";
import SyncStatusTag from "./SyncStatusTag";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRocket } from "@fortawesome/free-solid-svg-icons";
import { nodeStatusType } from "./Types"
import WithdrawRpl from "./WithdrawRpl";


interface Props {
    utils?: any,
    nodeStatus?: nodeStatusType,
    nodeSyncStatus: any,
    updateNodeStatus: any,
    rpdDaemon: any,
}

const NodeStatus = ({ utils, nodeStatus, nodeSyncStatus, updateNodeStatus, rpdDaemon }: Props) => {
    return (
        <div>
            <h2 className="title is-3 has-text-white">Node status</h2>
            {nodeStatus && nodeSyncStatus && (
                <div>
                    <table className="table">
                        <tbody>
                            <tr>
                                <td><b>Execution (ETH1) node</b></td>
                                <td><SyncStatusTag progress={nodeSyncStatus.ecStatus.primaryEcStatus.syncProgress} /></td>
                            </tr>
                            <tr>
                                <td><b>Beacon chain (ETH2) node</b></td>
                                <td><SyncStatusTag progress={nodeSyncStatus.bcStatus.primaryEcStatus.syncProgress} /></td>
                            </tr>
                            <tr>
                                <td><b>Hot wallet address</b></td>
                                <td>
                                    {utils.etherscanAddressUrl(nodeStatus.accountAddress)}{" "}
                                    {utils.rocketscanUrl("/node/" + nodeStatus.accountAddress, <FontAwesomeIcon icon={faRocket} />)}
                                </td>
                            </tr>
                            <tr>
                                <td><b>Withdrawal address</b></td>
                                <td>
                                    {utils.etherscanAddressUrl(nodeStatus.withdrawalAddress)}{" "}
                                    {utils.rocketscanUrl("/address/" + nodeStatus.withdrawalAddress, <FontAwesomeIcon icon={faRocket} />)}
                                </td>
                            </tr>
                            <tr>
                                <td><b>RPL Stake</b></td>
                                <td>
                                    {utils.displayAsETH(nodeStatus.rplStake, 2)} RPL
                                    <WithdrawRpl nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} utils={utils} rpdDaemon={rpdDaemon} />
                                </td>
                            </tr>
                            <tr><td><b>Time zone</b></td><td>{nodeStatus.timezoneLocation}</td></tr>
                            <tr><td><b>Smoothing pool joined</b></td><td>{nodeStatus.feeRecipientInfo.isInSmoothingPool ? "yes" : "no"}</td></tr>
                            <tr><td><b>Fee distributor initialized</b></td><td>{nodeStatus.isFeeDistributorInitialized ? "yes" : "no"}</td></tr>
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default NodeStatus