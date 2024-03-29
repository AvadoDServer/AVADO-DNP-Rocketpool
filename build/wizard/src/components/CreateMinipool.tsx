import React from "react";
import web3 from "web3";
import Spinner from "./Spinner";
import ApproveRpl from "./ApproveRpl";
import StakeRPL from "./StakeRPL";
import DepositETH from "./DepositETH";
import DownloadBackup from "./DownloadBackup";
import { rplPriceDataType, nodeStatusType, nodeFeeType } from "./Types"
import MiniPoolStatus from "./MiniPoolStatus";
import CreateMinipoolSteps from "./CreateMinipoolSteps";

export const supportedMinipoolSizes = [8, 16] as const;
export type minipoolSizeType = typeof supportedMinipoolSizes[number]

interface Props {
    utils: any,
    nodeStatus: nodeStatusType,
    rplPriceData: rplPriceDataType,
    updateNodeStatus: any,
    updateMiniPoolStatus: any,
    nodeFee: nodeFeeType,
    rpdDaemon: any,
    setNavBar: any
}

const CreateMinipool = ({ utils, nodeStatus, rplPriceData, updateNodeStatus, updateMiniPoolStatus, nodeFee, rpdDaemon, setNavBar }: Props) => {
    const [targetCount, setTargetCount] = React.useState(1);
    const [targetMiniPoolSize, setTargetMiniPoolSize] = React.useState<minipoolSizeType>(8)

    const currentMiniPoolCount = () => {
        if (nodeStatus?.minipoolCounts?.total)
            return nodeStatus?.minipoolCounts?.total
        else
            return 0
    }

    const addAnother = (miniPoolSize: minipoolSizeType) => {
        setTargetCount(currentMiniPoolCount() + 1);
        setTargetMiniPoolSize(miniPoolSize)
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
                            <button className="button" onClick={() => { addAnother(8) }}>Stake more RPL</button>
                            <br />
                            {supportedMinipoolSizes.map(miniPoolSize => <>
                                <button key={miniPoolSize.toString()} className="button" onClick={() => { addAnother(miniPoolSize) }}>Add another {miniPoolSize} ETH minipool / stake more RPL</button>
                                <br />
                            </>)
                            }
                        </div>
                    ) : (
                        <CreateMinipoolSteps
                            minipoolSize={targetMiniPoolSize}
                            targetCount={targetCount}
                            utils={utils}
                            nodeStatus={nodeStatus}
                            rplPriceData={rplPriceData}
                            updateNodeStatus={updateNodeStatus}
                            updateMiniPoolStatus={updateMiniPoolStatus}
                            nodeFee={nodeFee}
                            rpdDaemon={rpdDaemon}
                            setNavBar={setNavBar}
                        />
                    )}
                </>
            )}
        </div>
    );
};

export default CreateMinipool