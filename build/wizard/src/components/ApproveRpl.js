import React from "react";
import BN from "bn.js"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { confirmAlert } from 'react-confirm-alert';
import 'react-confirm-alert/src/react-confirm-alert.css';
import Spinner from "./Spinner";
import config from "../config";
import { etherscanTransactionUrl } from './utils.js';
import web3 from "web3";

const ApproveRpl = ({ utils, rplAllowanceOK, setRplAllowanceOK, rpdDaemon }) => {
    const [rplApproveButtonDisabled, setRplApproveButtonDisabled] = React.useState(true);
    const [txHash, setTxHash] = React.useState();
    const [waitingForTx, setWaitingForTx] = React.useState(false);
    const [feedback, setFeedback] = React.useState("");

    React.useEffect(() => {
        checkAllowance();
    }, []);

    const checkAllowance = () => {
        setRplApproveButtonDisabled(false);

        rpdDaemon(`node stake-rpl-allowance`, (data) => {
            if (data.status === "error") {
                setFeedback(data.error);
            } else {
                const allowance = new BN(data.allowance.toString())
                if (allowance.gt(new BN(0))) {
                    setRplApproveButtonDisabled(true);
                    setRplAllowanceOK(true);
                } else {
                    setRplApproveButtonDisabled(false);
                    setRplAllowanceOK(false);
                }
            }
        });
    }

    const approveRpl = () => {
        //2**256-1
        var maxApproval = new BN(2)
        maxApproval = maxApproval.pow(new BN(256))
        maxApproval = maxApproval.sub(new BN(1))

        confirmAlert({
            title: 'Are you sure you want to approve RPL for your wallet now?',
            message: 'Aprroving RPL consumes gas (ETH)',
            buttons: [
                {
                    label: 'Yes',
                    onClick: () => rpdDaemon(`node stake-rpl-approve-rpl ${maxApproval}`, (data) => {
                        if (data.status === "error") {
                            setFeedback(data.error);
                        }
                        setTxHash(data.approveTxHash);
                        setWaitingForTx(true);
                        setRplApproveButtonDisabled(true);
                    })
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
                    checkAllowance();
                });
            });
        }
    }, [waitingForTx,txHash,utils]);

    return (
        <div className="">
            <h4 className="title is-4 has-text-white">Approve RPL</h4>
            {!rplAllowanceOK && (
                <>
                    <p>Before staking RPL, you must first give the staking contract approval to interact with your RPL.
                        This only needs to be done once for your node.</p>
                    <div className="field">
                        <button className="button"
                            onClick={approveRpl}
                            disabled={rplApproveButtonDisabled}>
                            Approve RPL{waitingForTx ? <Spinner /> : ""}
                        </button>
                    </div>
                </>
            )}
            {feedback && (
                <p className="help is-danger">{feedback}</p>
            )}
            {rplAllowanceOK && (
                <span className="tag is-success">Approved <span><FontAwesomeIcon className="icon" icon={faCheck} /></span></span>
            )}
            {txHash && (
                <p>{utils.etherscanTransactionUrl(txHash, "Transaction details on Etherscan")}</p>
            )}
        </div>);
}


export default ApproveRpl