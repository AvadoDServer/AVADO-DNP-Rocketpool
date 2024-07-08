import React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWallet, faSync, faClipboard } from "@fortawesome/free-solid-svg-icons";
import InitWallet from "./InitWallet";
import FundWallet from "./FundWallet";
import RegisterNode from "./RegisterNode";
import SetWithdrawalAddress from "./SetWithdrawalAddress";
import CreateMinipool from "./CreateMinipool";
import JoinSmoothingPool from "./JoinSmoothingPool"
import { minipoolStatusType, nodeStatusType, walletStatusType } from "./Types"
import { KeyManagerHelper } from "./KeyManagerHelper";
import InitializeFeeDistributor from "./InitializeFeeDistributor";


interface Props {
    rpdDaemon: any,
    utils: any,
    updateNodeStatus: any,
    minipoolStatus: minipoolStatusType,
    nodeStatus?: nodeStatusType,
    walletStatus: walletStatusType,
    updateWalletStatus: any,
    rplPriceData: any,
    updateMiniPoolStatus: any,
    nodeFee: any,
    setNavBar: any
}

const SetupWizard = ({ utils, walletStatus, updateWalletStatus, nodeStatus, rplPriceData, updateNodeStatus, minipoolStatus, updateMiniPoolStatus, nodeFee, rpdDaemon, setNavBar }: Props) => {
    const initWallet = { id: Symbol("Init wallet").toString(), name: "Init wallet" };
    const fundNode = { id: Symbol("Fund Node").toString(), name: "Fund Node" };
    const registerNode = { id: Symbol("Register node").toString(), name: "Register node" };
    const withdrawalAddress = { id: Symbol("Withdrawal address").toString(), name: "Withdrawal address" };
    const joinSmoothingPool = { id: Symbol("Join smoothing pool").toString(), name: "Join smoothing pool" };
    const initializeFeeDistributor = { id: Symbol("Initialize Fee Distributor").toString(), name: "Initialize Fee Distributor" };
    const createMinipool = { id: Symbol("Add minipool").toString(), name: "Add minipool" };

    const [viewState, setViewState] = React.useState(initWallet);

    const setupStates = [
        initWallet,
        fundNode,
        registerNode,
        withdrawalAddress,
        joinSmoothingPool,
        initializeFeeDistributor,
        createMinipool,
    ];

    React.useEffect(() => {
        if (nodeStatus && walletStatus) {
            if (nodeStatus.status === "error" && nodeStatus.error.includes("rocketpool wallet init")) {
                setViewState(initWallet);
                return;
            }
            // if (nodeStatus.status === "success"
            //     && nodeStatus.accountAddress !== "0x0000000000000000000000000000000000000000"
            //     && !nodeStatus.registered
            //     && !nodeStatus.accountBalances.eth
            //     //TODO : && displayAsETH(nodeStatus.accountBalances.rpl) < ???
            // ) {
            //     setViewState(fundNode);
            //     return;
            // }
            if (nodeStatus.status === "success"
                && nodeStatus.accountAddress !== "0x0000000000000000000000000000000000000000"
                && !nodeStatus.registered
                && BigInt(nodeStatus.accountBalances.eth) > 0n
                && BigInt(nodeStatus.accountBalances.rpl) > BigInt(rplPriceData.minPer16EthMinipoolRplStake)
            ) {
                setViewState(registerNode);
                return;
            }
            if (nodeStatus.status === "success"
                && nodeStatus.registered
                && nodeStatus.primaryWithdrawalAddress === nodeStatus.accountAddress) {
                setViewState(withdrawalAddress);
                return;
            }
            if (nodeStatus.status === "success"
                && nodeStatus.registered
                && nodeStatus.primaryWithdrawalAddress !== nodeStatus.accountAddress) {
                if (!nodeStatus.feeRecipientInfo.isInSmoothingPool) {
                    setViewState(joinSmoothingPool);
                } else {
                    if (!nodeStatus.isFeeDistributorInitialized) {
                        setViewState(initializeFeeDistributor);
                    } else {
                        setViewState(createMinipool);
                    }
                }
                return;
            }
        }
    }, [nodeStatus, walletStatus]);


    const isActive = (element: any) => {
        return element.id == viewState.id;

    }
    const isHollow = (element: any) => {
        if (isActive(element) && element.id == createMinipool.id)
            return !nodeStatus?.minipoolCounts || nodeStatus?.minipoolCounts.total == 0;
        else
            return element.id == viewState.id;
    }

    const stateComment = (element: any) => {
        if ("comment" in element)
            return element.comment;
    }

    React.useEffect(() => {

    }, []);

    return (
        /* https://octoshrimpy.github.io/bulma-o-steps/ */
        <div>
            <br />
            <div className="columns">
                <div className="column">
                    {(
                        <ul className="steps has-content-centered">
                            {setupStates.map((element) =>
                                <li className={"steps-segment" + (isActive(element) ? " is-active" : "")} key={element.name}>
                                    <span className={"steps-marker" + (isHollow(element) ? "" : "")}></span>
                                    <div className="steps-content">
                                        <p className="is-size-4 has-text-white">{element.name}</p>
                                        <div className="extra-data has-text-white">{stateComment(element)}</div>
                                    </div>
                                </li>
                            )}
                        </ul>
                    )}
                </div>
                {nodeStatus && (
                    <div className="column is-narrow">
                        <div className="box">
                            <div className="is-size-5">Hot wallet</div>
                            <div className="columns">
                                <div className="column">
                                    <FontAwesomeIcon className="icon" icon={faWallet} title="Wallet (click icon to copy address)" onClick={() => navigator.clipboard.writeText(nodeStatus.accountAddress)} />
                                </div>
                                <div className="column">
                                    <div className="has-text-right"><a onClick={updateNodeStatus}><FontAwesomeIcon className="icon" icon={faSync} title="Refresh wallet" /></a></div>
                                </div>
                            </div>
                            {/* <p><a onClick={() => navigator.clipboard.writeText(nodeStatus.accountAddress)}><FontAwesomeIcon className="icon" icon={faClipboard} title="Copy address to clipboard" /> copy address</a></p> */}
                            <p>{utils.displayAsETH(nodeStatus.accountBalances.eth, 3)} ETH</p>
                            <p>{utils.displayAsETH(nodeStatus.accountBalances.rpl, 3)} RPL</p>
                        </div>
                    </div>
                )}
            </div>
            {nodeStatus && (
                <>
                    {(viewState.id === initWallet.id) && (<InitWallet walletStatus={walletStatus} updateWalletStatus={updateWalletStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} onFinished={() => { setViewState(fundNode) }} />)}
                    {(viewState.id === fundNode.id) && (<FundWallet utils={utils} nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rplPriceData={rplPriceData} />)}
                    {(viewState.id === registerNode.id) && (<RegisterNode utils={utils} nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />)}
                    {(viewState.id === withdrawalAddress.id) && (<SetWithdrawalAddress utils={utils} nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />)}
                    {(viewState.id === joinSmoothingPool.id) && (<JoinSmoothingPool utils={utils} nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />)}
                    {(viewState.id === initializeFeeDistributor.id) && (<InitializeFeeDistributor utils={utils} nodeStatus={nodeStatus} updateNodeStatus={updateNodeStatus} rpdDaemon={rpdDaemon} />)}
                    {(viewState.id === createMinipool.id) && (<CreateMinipool
                        utils={utils}
                        nodeStatus={nodeStatus}
                        rplPriceData={rplPriceData}
                        updateNodeStatus={updateNodeStatus}
                        updateMiniPoolStatus={updateMiniPoolStatus}
                        nodeFee={nodeFee}
                        rpdDaemon={rpdDaemon}
                        setNavBar={setNavBar}
                    />)}
                </>
            )}
        </div>
    );
};

export default SetupWizard

