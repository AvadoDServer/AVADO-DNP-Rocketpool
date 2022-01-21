import React from "react";
import SyncStatusTag from "./SyncStatusTag";
import web3 from "web3";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGasPump, faSatelliteDish } from "@fortawesome/free-solid-svg-icons";
import config from "../config";
import Spinner from "./Spinner";


const Header = ({ utils, rocketpoollogo, nodeSyncStatus, nodeFee, rplPriceData, minipoolStatus }) => {

    const [gasPrice, setGasPrice] = React.useState();

    React.useEffect(() => {
        if (!utils)
            return;
        console.log("Using: " + utils.wsProvider());
        const eth = new web3(utils.wsProvider()).eth;
        const interval = setInterval(() => {
            eth.getGasPrice().then((result) => {
                const currentPrice = parseFloat(web3.utils.fromWei(result, 'gwei')).toFixed(3);
                console.log("Gas: " + currentPrice);
                setGasPrice(currentPrice);
            })
        }, 15 * 1000);
        return () => clearInterval(interval);
    }, [utils]);


    const beaconChainDashboard = (indexes) => indexes ? (<a href={`${utils.beaconChainBaseUrl}/dashboard?validators=` + indexes.join(",")}><FontAwesomeIcon className="icon" icon={faSatelliteDish} /></a>) : "";

    return (
        <div className="hero-body is-small is-primary py-0">
            <div className="columns">
                <div className="column is-narrow">
                    <figure className="image is-64x64">
                        <img src={rocketpoollogo} alt="Rocket Pool logo" />
                    </figure>
                </div>
                <div className="column">
                    <span>
                        <h1 className="title is-1 has-text-white">Avado Rocket Pool</h1>
                    </span>
                    <p>Rocket Pool without the command line</p>
                </div>
            </div>

            {nodeSyncStatus && (
                <div>
                    <p className="has-text-right">
                        <SyncStatusTag progress={nodeSyncStatus.eth1Progress} label="Geth" />,
                        <SyncStatusTag progress={nodeSyncStatus.eth2Progress} label="Prysm" />
                        {minipoolStatus && minipoolStatus.minipools && (
                            beaconChainDashboard(minipoolStatus.minipools.filter((minipool) => "validator" in minipool).map((minipool) => minipool.validator.index))
                        )}

                    </p>
                    <p className="has-text-right">
                        <FontAwesomeIcon className="icon" icon={faGasPump} /> {gasPrice ? gasPrice : <Spinner />} gwei,
                        Node commision: {nodeFee && utils ? utils.displayAsPercentage(nodeFee.nodeFee * 100) : <Spinner />},
                        RPL: {rplPriceData && utils ? utils.displayAsETH(rplPriceData.rplPrice, 5) : <Spinner />} ETH
                    </p>
                </div>
            )}
        </div>
    );
};

export default Header


