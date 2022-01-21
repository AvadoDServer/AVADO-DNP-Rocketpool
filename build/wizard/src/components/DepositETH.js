import React from "react";
import BN from "bn.js"
import { confirmAlert } from 'react-confirm-alert';
import 'react-confirm-alert/src/react-confirm-alert.css';
import Spinner from "./Spinner";
import config from "../config";
import web3 from "web3";

const DepositETH = ({ utils, nodeStatus, nodeFee, rplPriceData, rplAllowanceOK, updateNodeStatus, rpdDaemon }) => {


    const [ethButtonDisabled, setEthButtonDisabled] = React.useState(true);
    const [feedback, setFeedback] = React.useState("");
    const [txHash, setTxHash] = React.useState();
    const [waitingForTx, setWaitingForTx] = React.useState(false);
    const [selectedNodeFee, setSelectedNodeFee] = React.useState();
    const ETHDepositAmmount = 16000000000000000000;

    React.useEffect(() => {
        setEthButtonDisabled(true); //set default
        if (nodeStatus && rplPriceData && rplAllowanceOK) {
            if (nodeStatus.rplStake < rplPriceData.minPerMinipoolRplStake) {
                setFeedback("You need to stake RPL first")
            } else {
                if (nodeStatus.accountBalances.eth / 1000000000000000000 < 16) {
                    setFeedback("There is not enough ETH in your wallet. You need at least 16 ETH + gas.")
                } else {
                    rpdDaemon(`node can-deposit ${ETHDepositAmmount} ${selectedNodeFee} 0`, (data) => {
                        if (data.status === "error") {
                            setFeedback(data.error);
                        } else {
                            setFeedback("");
                            setEthButtonDisabled(false);
                        }
                    });
                }
            }
        }

        if (nodeFee && nodeFee.nodeFee && !selectedNodeFee) {
            setSelectedNodeFee(nodeFee.nodeFee * 0.97); // allow 3% slippage by default
        }


    }, [nodeStatus, rplPriceData, rplAllowanceOK, nodeFee]);


    React.useEffect(() => {
        if (waitingForTx) {
            rpdDaemon(`wait ${txHash}`, (data) => {
                const w3 = new web3(utils.wsProvider());
                w3.eth.getTransactionReceipt(txHash).then((receipt) => {
                    console.log(receipt);
                    setWaitingForTx(false);
                    updateNodeStatus();
                });
            });
        }
    }, [waitingForTx,utils]);

    const depositEth = () => {
        confirmAlert({
            title: 'Are you sure you want to deposit your 16 ETH now?',
            message: 'Staking RPL consumes gas (ETH)',
            buttons: [
                {
                    label: 'Yes',
                    onClick: () => rpdDaemon(`node deposit ${ETHDepositAmmount} ${selectedNodeFee} 0`, (data) => {  //   rocketpool api node deposit amount min-fee salt
                        //{"status":"success","error":"","txHash":"0x6c8958917414479763aaa65dbff4b00e52d9ef699d64dbd0827a45e1fe8aee38","minipoolAddress":"0xc43a2d435bd48bde1e000c07e89f3e6ebe9161d4","validatorPubkey":"ac9cb87a11fd8c55a9529108964786f11623717a6e3af0db3cd5fde2da5c6a7a4f89e52d13770ad6bc080de1b63427a1","scrubPeriod":3600000000000}
                        if (data.status === "error") {
                            setFeedback(data.error);
                        }
                        setTxHash(data.txHash);
                        setWaitingForTx(true);
                        setEthButtonDisabled(true);
                    })
                },
                {
                    label: 'No',
                    onClick: () => { }
                }
            ]
        });
    }

    const slider = (e) => {
        setSelectedNodeFee(e.target.value);
    }

    return (
        <div className="">
            <h4 className="title is-4 has-text-white">Deposit ETH</h4>
            {nodeStatus && nodeStatus.minipoolCounts.total > 0 && (
                <>
                <p>16 ETH successfully deposited.</p>
                </>
            )}

            {nodeStatus && nodeStatus.minipoolCounts.total == 0 && (
                <>
                    <div className="field">
                        Your minimal nodeFee: <input id="sliderWithValue" className="slider has-output" step="0.01" min={nodeFee.minNodeFee} max={nodeFee.maxNodeFee} defaultValue={nodeFee.nodeFee} type="range" onChange={slider} />
                        {utils.displayAsPercentage(selectedNodeFee * 100)}
                    </div>
                    <div className="field">
                        <button className="button" onClick={depositEth} disabled={ethButtonDisabled}>Deposit 16 ETH{waitingForTx ? <Spinner /> : ""}</button>
                    </div>
                    {feedback && (
                        <p className="help is-danger">{feedback}</p>
                    )}
                </>
            )}
            {txHash && (
                <p>{utils.etherscanTransactionUrl(txHash, "Transaction details on Etherscan")}</p>
            )}
        </div>);
}


export default DepositETH