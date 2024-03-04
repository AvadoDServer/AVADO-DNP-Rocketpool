import React from "react";
import 'react-confirm-alert/src/react-confirm-alert.css';
import Spinner from "./Spinner";
import web3 from "web3";
import { nodeStatusType } from "./Types"

interface Props {
    nodeStatus: nodeStatusType
    updateNodeStatus: any,
    utils: any,
    rpdDaemon: any,
}

const WithdrawRpl = ({ nodeStatus, updateNodeStatus, utils, rpdDaemon }: Props) => {

    const [canWithdraw, setCanWithdraw] = React.useState(false);
    const [buttonDisabled, setButtonDisabled] = React.useState(false);
    const [waitingForTx, setWaitingForTx] = React.useState(false);
    const [feedback, setFeedback] = React.useState("");
    const [txHash, setTxHash] = React.useState();

    const rplStake = BigInt(nodeStatus.rplStake);
    React.useEffect(() => {
        if (waitingForTx)
            return;

        setButtonDisabled(true); //set default
        if (nodeStatus) {
            rpdDaemon(`node can-withdraw-rpl ${rplStake}`, (data: any) => {
                if (data.status === "error") {
                    setFeedback(data.error);
                } else {
                    setFeedback("");
                    setButtonDisabled(false);
                    setCanWithdraw(true)
                }
            });
        }
    }, [nodeStatus, waitingForTx]);

    const withdrawRplStake = () => {
        setButtonDisabled(true);

        rpdDaemon(`node withdraw-rpl ${rplStake}`, (data: any) => { //rocketpool api node withdraw-rpl amount
            if (data.status === "error") {
                setFeedback(data.error);
            }
            setWaitingForTx(true);

            setTxHash(data.txHash);
        })
    }

    React.useEffect(() => {
        if (waitingForTx && txHash) {
            rpdDaemon(`wait ${txHash}`, (data: any) => {
                const w3 = new web3(utils.wsProvider());
                w3.eth.getTransactionReceipt(txHash).then((receipt) => {
                    console.log(receipt);
                    setWaitingForTx(false);
                    updateNodeStatus();
                    setCanWithdraw(false)
                });
            });
        }
    }, [waitingForTx, txHash, utils]);


    if (!canWithdraw)
        return <></>

    return <>
        <div className="field">
            <button className="button" disabled={buttonDisabled} onClick={withdrawRplStake}>Withdraw {utils.displayAsETH(nodeStatus.rplStake, 2)} RPL {waitingForTx ? <Spinner /> : ""}</button>
        </div>
        {txHash && <p>{utils.etherscanTransactionUrl(txHash, "Transaction details on Etherscan")}</p>}
        {feedback && <p className="help is-danger">{feedback}</p>}
    </>;
}


export default WithdrawRpl