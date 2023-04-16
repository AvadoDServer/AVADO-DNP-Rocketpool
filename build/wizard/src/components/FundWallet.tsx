import ClickToCopy from "./ClickToCopy";
import { rplPriceDataType, nodeStatusType } from "./Types"

interface Props {
    utils: any,
    nodeStatus: nodeStatusType,
    updateNodeStatus: any,
    rplPriceData: rplPriceDataType,
}

const FundWallet = ({ utils, nodeStatus, updateNodeStatus, rplPriceData }: Props) => {

    const ethBalance = BigInt(nodeStatus.accountBalances.eth)
    const rplBalance = BigInt(nodeStatus.accountBalances.rpl)
    const minRplStake = BigInt(rplPriceData.minPer16EthMinipoolRplStake)
    const maxRplStake = BigInt(rplPriceData.maxPer16EthMinipoolRplStake)

    if (rplPriceData)
        console.log("RPL", minRplStake);
    if (nodeStatus)
        console.log("BALANCE RPL", rplBalance)
    return (
        <div>
            <>
                <h2 className="title is-3 has-text-white">Fund wallet</h2>
                {rplPriceData && (
                    <div className="content">
                        <p>Now you need to fund your Rocketpool hot wallet.</p>
                        <ol>
                            <li>Send 16.4 ETH to <ClickToCopy text={nodeStatus.accountAddress}>{utils.etherscanAddressUrl(nodeStatus.accountAddress)}</ClickToCopy> (16 ETH + 0.2 ETH gas money)</li>
                            <br />(0.4 is a safe margin to create everything - including the expensive minipool contract deploy. The remaining gas can be withdrawn from this wallet later)
                            <li>Send a minimum of {Math.ceil(utils.displayAsETH(minRplStake))} RPL to <ClickToCopy text={nodeStatus.accountAddress}>{utils.etherscanAddressUrl(nodeStatus.accountAddress)}</ClickToCopy>
                                <br />(maximum allowed stake is {Math.floor(utils.displayAsETH(maxRplStake))} RPL - the more you stake, the more you will earn. More details on the <a target="_blank" href="https://wiki.ava.do/en/tutorials/rocketpool">Avado Rocket Pool Wiki page</a> )
                                <br />(All RPL sent to this wallet will be used as your stake later - so please send exactly the desired stake amount)
                            </li>
                        </ol>
                        <p>Current Wallet balances:</p>
                        <ul>
                            <li><b>ETH: </b>{(ethBalance < 16000000000000000000n) ?
                                (<span className="tag is-danger ">{utils.displayAsETH(ethBalance)} ETH</span>)
                                :
                                (<span className="tag is-success ">{utils.displayAsETH(ethBalance)} ETH</span>)
                            }
                            </li>

                            <li><b>RPL: </b>{(rplBalance < minRplStake) ?
                                (<span className="tag is-danger ">{utils.displayAsETH(rplBalance)} RPL</span>)
                                :
                                (<span className="tag is-success ">{utils.displayAsETH(rplBalance)} RPL</span>)
                            }
                            </li>
                        </ul>

                    </div>
                )}
                <button className="button" onClick={updateNodeStatus}>Refresh balances</button>
                <br />
                <br />
                <p>You will go to the next step once you have funded your wallet sufficiently.</p>
            </>
        </div>
    );
};

export default FundWallet