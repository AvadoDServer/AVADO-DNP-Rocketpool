import React from "react";
import BN from "bn.js"
import { confirmAlert } from 'react-confirm-alert';
import 'react-confirm-alert/src/react-confirm-alert.css';
import Spinner from "./Spinner";
import config from "../config";
import web3 from "web3";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@fortawesome/free-solid-svg-icons";

const StakeRPL = ({ utils, nodeStatus, rplPriceData, rplAllowanceOK, updateNodeStatus, rpdDaemon ,count }) => {

    const [rplStakeButtonDisabled, setRplStakeButtonDisabled] = React.useState(true);
    const [feedback, setFeedback] = React.useState("");
    const [txHash, setTxHash] = React.useState();
    const [waitingForTx, setWaitingForTx] = React.useState(false);

    const rplBalance = new BN(nodeStatus.accountBalances.rpl.toString());
    const minipoolCount = new BN(count.toString());
    const rplMin = (new BN(rplPriceData.minPerMinipoolRplStake.toString())).mul(minipoolCount);

    React.useEffect(() => {
        setRplStakeButtonDisabled(true); //set default

        if (waitingForTx)
            return;

        if (nodeStatus && rplPriceData && rplAllowanceOK) {
            if (rplBalance.lt(rplMin)) {
                setFeedback(`Not enough RPL in your wallet (${utils.displayAsETH(nodeStatus.accountBalances.rpl, 4)} RPL). Must be more than ${utils.displayAsETH(rplPriceData.minPerMinipoolRplStake, 4)} RPL before you can stake`);
            } else {
                debugger;
                if (nodeStatus.rplStake < rplMin) {
                    console.log(`node can-stake-rpl ${rplBalance.toString()}`); 
                    rpdDaemon(`node can-stake-rpl ${rplBalance.toString()}`, (data) => {
                        //{"status":"error","error":"Error getting transaction gas info: could not estimate gas limit: Could not estimate gas needed: execution reverted: Minipool count after deposit exceeds limit based on node RPL stake","canDeposit":false,"insufficientBalance":false,"insufficientRplStake":false,"invalidAmount":false,"unbondedMinipoolsAtMax":false,"depositDisabled":false,"inConsensus":false,"minipoolAddress":"0x0000000000000000000000000000000000000000","gasInfo":{"estGasLimit":0,"safeGasLimit":0}}
                        if (data.status === "error") {
                            setFeedback(data.error);
                        } else {
                            // rpd says that I can stake - if I have enough in my wallet, enable button
                            setRplStakeButtonDisabled(!rplBalance.gte(rplMin));

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
                        rpdDaemon(`node stake-rpl ${rplBalance}`, (data) => {
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
            rpdDaemon(`wait ${txHash}`, (data) => {
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
            {nodeStatus.rplStake >= rplMin && (
                <p>
                    <span className="tag is-success">{utils.displayAsETH(nodeStatus.rplStake, 2)} RPL successfully staked. <span><FontAwesomeIcon className="icon" icon={faCheck} /></span></span>
                </p>
            )}
            {nodeStatus.rplStake < rplMin && (
                <>
                    <p>Stake all RPL in my hot wallet. {rplPriceData && (<>Minimum stake is currently {Math.ceil(utils.displayAsETH(rplPriceData.minPerMinipoolRplStake))}</>)}</p><br />
                    <div className="field">
                        <button
                            className="button"
                            onClick={stakeRpl}
                            disabled={rplStakeButtonDisabled}>
                            Stake {rplBalance ? utils.displayAsETH(rplBalance) + " " : ""}RPL{waitingForTx ? <Spinner /> : ""}
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
            )}
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