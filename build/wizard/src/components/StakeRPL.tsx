import React from "react";
import { confirmAlert } from 'react-confirm-alert';
import 'react-confirm-alert/src/react-confirm-alert.css';
import Spinner from "./Spinner";
import web3 from "web3";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { rplPriceDataType, nodeStatusType, nodeFeeType } from "./Types"
import { minipoolSizeType } from "./CreateMinipool";

interface Props {
    minipoolSize: minipoolSizeType,
    utils: any,
    nodeStatus: nodeStatusType,
    rplPriceData: rplPriceDataType,
    rplAllowanceOK: any,
    updateNodeStatus: any,
    rpdDaemon: any,
    targetCount: any
}

const StakeRPL = ({ minipoolSize, utils, nodeStatus, rplPriceData, rplAllowanceOK, updateNodeStatus, rpdDaemon, targetCount }: Props) => {

    const [rplStakeButtonDisabled, setRplStakeButtonDisabled] = React.useState(true);
    const [feedback, setFeedback] = React.useState("");
    const [txHash, setTxHash] = React.useState();
    const [waitingForTx, setWaitingForTx] = React.useState(false);

    const minMinipoolRplStake = minipoolSize === 8 ? rplPriceData.minPer8EthMinipoolRplStake : rplPriceData.minPer16EthMinipoolRplStake
    const rplBalanceInWallet = BigInt(nodeStatus.accountBalances.rpl)
    const rplMin = BigInt(minMinipoolRplStake)
    const stakedRplBalance = BigInt(nodeStatus.rplStake)
    const minimumRplStake = BigInt(nodeStatus.minimumRplStake)
    const targetCountBN: bigint = BigInt(targetCount)


    const count = () => nodeStatus.minipoolCounts.total

    React.useEffect(() => {

        setRplStakeButtonDisabled(true); //set default

        if (waitingForTx)
            return;

        if (nodeStatus && rplPriceData && rplAllowanceOK) {
            // first deposit only allowed if bigger than minium.
            // If there is a minipool already, more deposits are allowed.
            if (count() === 0 && rplBalanceInWallet < rplMin) {
                setFeedback(`Not enough RPL in your wallet (${utils.displayAsETH(rplBalanceInWallet, 4)} RPL). Must be more than ${utils.displayAsETH(minMinipoolRplStake, 4)} RPL before you can stake`);
            } else {
                if (rplBalanceInWallet > 0n) {
                    console.log(`node can-stake-rpl ${rplBalanceInWallet.toString()}`);
                    rpdDaemon(`node can-stake-rpl ${rplBalanceInWallet.toString()}`, (data: any) => {
                        //{"status":"error","error":"Error getting transaction gas info: could not estimate gas limit: Could not estimate gas needed: execution reverted: Minipool count after deposit exceeds limit based on node RPL stake","canDeposit":false,"insufficientBalance":false,"insufficientRplStake":false,"invalidAmount":false,"unbondedMinipoolsAtMax":false,"depositDisabled":false,"inConsensus":false,"minipoolAddress":"0x0000000000000000000000000000000000000000","gasInfo":{"estGasLimit":0,"safeGasLimit":0}}
                        if (data.status === "error") {
                            if (rplBalanceInWallet > 0n) {
                                setFeedback(data.error);
                            }
                        } else {
                            // rpd says that I can stake - if I have enough in my wallet, enable button
                            setFeedback("");
                            setRplStakeButtonDisabled(false);
                        }
                    });
                }
            }
        }
    }, [nodeStatus, rplPriceData, rplAllowanceOK, waitingForTx]);

    const stakeRpl = () => {
        confirmAlert({
            title: '',
            message: 'Are you sure you want to stake your RPL now?',
            buttons: [
                {
                    label: 'Yes',
                    onClick: () => {
                        setRplStakeButtonDisabled(true);
                        rpdDaemon(`node stake-rpl ${rplBalanceInWallet}`, (data: any) => {
                            //{"status":"success","error":"","stakeTxHash":"0x41a93be5b4fb06e819975acc0cdb91c1084e4c1943d625a3a5f96d823842d0e8"}
                            if (data.status === "error") {
                                setFeedback(data.error);
                            }
                            setTxHash(data.stakeTxHash);
                            setWaitingForTx(true);
                        })
                    }
                },
                {
                    label: 'No',
                    onClick: () => { }
                }
            ]
        });
    }

    React.useEffect(() => {
        if (waitingForTx && txHash) {
            rpdDaemon(`wait ${txHash}`, (data: any) => {
                const w3 = new web3(utils.wsProvider());
                w3.eth.getTransactionReceipt(txHash).then((receipt) => {
                    console.log(receipt);
                    setWaitingForTx(false);
                    updateNodeStatus();
                });
            });
        }
    }, [waitingForTx, txHash, utils]);

    return (
        <div className="">
            <h4 className="title is-4 has-text-white">2. Stake RPL</h4>
            {stakedRplBalance > 0 && rplPriceData && nodeStatus && (

                (stakedRplBalance >= (minimumRplStake + rplMin)) ? (
                    <p>You have already staked {utils.displayAsETH(stakedRplBalance, 2)} RPL <span className="tag is-success"><span><FontAwesomeIcon className="icon" icon={faCheck} /></span></span></p>
                ) : (
                    <p>The minimum stake is currently {Math.ceil(utils.displayAsETH(minMinipoolRplStake))} RPL per {minipoolSize} ETH minipool<br />
                        You have already staked {utils.displayAsETH(stakedRplBalance)} RPL for {count()} minipools.<br />
                        To add an extra {minipoolSize} ETH minipool, <b>you need to stake an extra {Math.ceil(utils.displayAsETH(minimumRplStake + rplMin - stakedRplBalance))} RPL</b> to get a total stake of {Math.ceil(utils.displayAsETH(minimumRplStake + rplMin))} RPL.</p>
                )
            )
            }

            {/* {stakedRplBalance && targetCount>1 && ( */}
            <>
                <br />
                <div className="field">
                    <button
                        className="button"
                        onClick={stakeRpl}
                        disabled={rplStakeButtonDisabled}>
                        Stake {rplBalanceInWallet ? utils.displayAsETH(rplBalanceInWallet) + " " : ""} RPL{waitingForTx ? <Spinner /> : ""}
                    </button>
                    <br />
                    {feedback && (
                        <>
                            <p className="help is-danger">{feedback}</p>
                            <br />
                        </>
                    )}
                </div>
            </>
            {/* )} */}
            {txHash && (
                <>
                    <p>{utils.etherscanTransactionUrl(txHash, "Transaction details on Etherscan")}</p>
                    <br />
                </>
            )}
            <br />
        </div>);
}


export default StakeRPL