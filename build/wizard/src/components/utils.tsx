import React from 'react';
import web3 from "web3";

class Utils {
    network: "prater" | "holesky" | "mainnet";
    beaconChainBaseUrl: string;
    etherscanBaseUrl: string;
    ecwsurl: string;

    constructor(settings: any) {
        this.network = settings.network;

        this.ecwsurl = settings.ecwsurl;

        this.beaconChainBaseUrl = ({
            "prater": "https://prater.beaconcha.in",
            "holesky": "https://holesky.beaconcha.in",
            "mainnet": "https://beaconcha.in",
        })[this.network];

        this.etherscanBaseUrl = ({
            "prater": "https://goerli.etherscan.io",
            "holesky": "https://holesky.etherscan.io",
            "mainnet": "https://etherscan.io",
        })[this.network];
    }

    beaconchainUrl(validatorPubkey: string, text: string) {
        return <a target="_blank" rel="noopener noreferrer" href={this.beaconChainBaseUrl + "/validator/" + validatorPubkey + "#rocketpool"}>{text ? text : validatorPubkey}</a>;
    }

    etherscanAddressUrl(address: string, text: string) {
        return <a target="_blank" rel="noopener noreferrer" href={this.etherscanBaseUrl + "/address/" + address}>{text ? text : address}</a>;
    }

    etherscanTransactionUrl(txHash: string, text: string) {
        return <a target="_blank" rel="noopener noreferrer" href={this.etherscanBaseUrl + "/tx/" + txHash}>{text ? text : txHash}</a>;
    }

    rocketscanUrl(path: string, child: React.ReactNode) {
        const prefix = (this.network === "prater") ? "prater." : ((this.network === "holesky") ? "holesky." : "")
        return <a target="_blank" rel="noopener noreferrer" href={"https://" + prefix + "rocketscan.io" + path} >{child}</a>
    }

    displayAsETH(number: bigint, fractionDigits: number) {
        if (!number)
            return 0;
        // https://web3js.readthedocs.io/en/v1.2.0/web3-utils.html#fromwei
        const result = web3.utils.fromWei(number.toString(), 'ether');
        if (fractionDigits)
            return parseFloat(result).toFixed(fractionDigits)
        return result
    }

    displayAsPercentage(number: string) {
        if (!number)
            return "- %";
        return parseFloat(number).toFixed(2) + "%";
    }

    //TODO
    wsProvider() {
        return this.ecwsurl;
    }
}

export default Utils