import React from "react";
import 'react-confirm-alert/src/react-confirm-alert.css';
import Spinner from "./Spinner";
import web3 from "web3";
import { minipoolStatusType, MinipoolDetailsType } from "./Types"

interface Props {
    minipool: MinipoolDetailsType
    minipoolStatus: minipoolStatusType,
    updateMiniPoolStatus: any,
    utils: any,
    rpdDaemon: any,
}

const UpgradeDelegate = ({ minipool, minipoolStatus, utils, rpdDaemon, updateMiniPoolStatus }: Props) => {
    const [buttonDisabled, setButtonDisabled] = React.useState(false);
    const [waitingForTx, setWaitingForTx] = React.useState(false);
    const [feedback, setFeedback] = React.useState("");
    const [txHash, setTxHash] = React.useState();

    const isUsingLatestDelegate = () => minipoolStatus.latestDelegate == minipool.delegate

    const upgradeDelegate = () => {
        setButtonDisabled(true);

        rpdDaemon(`minipool delegate-upgrade ${minipool.address} `, (data: any) => {
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
                    updateMiniPoolStatus();
                });
            });
        }
    }, [waitingForTx, txHash, utils]);

    if (isUsingLatestDelegate())
        return <>✅</>

    return <>
        <p>Minipool can be upgraded to delegate {minipoolStatus.latestDelegate}:</p>
        <br />
        <div className="field">
            <button className="button" disabled={buttonDisabled} onClick={upgradeDelegate}>Upgrade Delegate {waitingForTx ? <Spinner /> : ""}</button>
        </div>
        {txHash && <p>{utils.etherscanTransactionUrl(txHash, "Transaction details on Etherscan")}</p>}
        {feedback && <p className="help is-danger">{feedback}</p>}
    </>;
}


export default UpgradeDelegate