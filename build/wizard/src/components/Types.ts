
export type networkType = "prater" | "mainnet"

export const consensusClients = ["teku", "prysm", "nimbus"] as const;
export type consensusClientType = typeof consensusClients[number];

// https://github.com/rocket-pool/smartnode/blob/master/shared/types/api/minipool.go
// https://github.com/rocket-pool/rocketpool-go/blob/master/types/minipool.go
export type minipoolStatusType = {
  "status": "success" | "error",
  "error": string,
  "minipools": MinipoolDetailsType[],
  "latestDelegate": string,
  "isAtlasDeployed": boolean
}

export type MinipoolDetailsType = {
  "address": string,
  "validatorPubkey": string,
  "status": minipoolStatusDetailsType,
  "depositType": string,
  "node": NodeDetailsType,
  "user": UserDetailsType,
  "balances": balancesDetailType,
  "nodeShareOfETHBalance": string, // bigint,
  "validator": validatorDetailsType,
  "canStake": boolean,
  // queue
  "refundAvailable": boolean,
  "withdrawalAvailable": boolean,
  "closeAvailable": boolean,
  "finalised": boolean,
  "useLatestDelegate": boolean,
  "delegate": string,
  "previousDelegate": string,
  "effectiveDelegate": string,
  "timeUntilDissolve": number,
  "penalties": number,
  "reduceBondTime": any,
  "reduceBondCancelled": boolean
}
export type minipoolStatusDetailsType = {
  "status": "Initialized" | "Prelaunch" | "Staking" | "Withdrawable" | "Dissolved",
  "statusBlock": number,
  "statusTime": string
}
export type NodeDetailsType = {
  "address": string,
  "fee": number,
  "depositBalance": string, // bigint,
  "refundBalance": number,
  "depositAssigned": boolean
}
export type UserDetailsType = {
  "depositBalance": string, // bigint,
  "depositAssigned": boolean,
  "depositAssignedTime": string
}
export type balancesDetailType = {
  "eth": string, // bigint,
  "reth": string, // bigint,
  "rpl": string, // bigint,
  "fixedSupplyRpl": bigint
}
export type validatorDetailsType = {
  "exists": boolean,
  "active": boolean,
  "index": number,
  "balance": string, // bigint,
  "nodeBalance": bigint
}

// https://github.com/rocket-pool/smartnode/blob/master/shared/types/api/node.go
export type nodeStatusType = {
  "status": "success" | "error",
  "error": string,
  "accountAddress": string,
  "withdrawalAddress": string,
  "pendingWithdrawalAddress": string,
  "registered": boolean,
  "trusted": boolean,
  "timezoneLocation": string,
  "accountBalances": {
    "eth": bigint
    "reth": string, // bigint,
    "rpl": string, // bigint,
    "fixedSupplyRpl": bigint
  },
  "withdrawalBalances": {
    "eth": bigint
    "reth": string, // bigint,
    "rpl": string, // bigint,
    "fixedSupplyRpl": bigint
  },
  "rplStake": string, // bigint,
  "effectiveRplStake": string, // bigint,
  "minimumRplStake": string, // bigint,
  "maximumRplStake": string, // bigint,
  "collateralRatio": string, // bigint,
  "votingDelegate": string,
  "minipoolLimit": number,
  "minipoolCounts": {
    "total": number,
    "initialized": number,
    "prelaunch": number,
    "staking": number,
    "withdrawable": number,
    "dissolved": number,
    "refundAvailable": number,
    "withdrawalAvailable": number,
    "closeAvailable": number,
    "finalised": number
  },
  "isFeeDistributorInitialized": boolean,
  "feeRecipientInfo": {
    "smoothingPoolAddress": string,
    "feeDistributorAddress": string,
    "isInSmoothingPool": boolean,
    "isInOptOutCooldown": boolean,
    "optOutEpoch": number
  },
  "feeDistributorBalance": string, // bigint,
  "penalizedMinipools": [string],
  "snapshotResponse": {
    "error": string,
    "proposalVotes": []
    "activeSnapshotProposals": []
  }
}

// https://github.com/rocket-pool/smartnode/blob/master/shared/types/api/node.go#L278
export type nodeSyncProgressResponseType = {
  "status": "success" | "error",
  "error": string,
  "ecStatus": ClientManagerStatusType,
  "bcStatus": ClientManagerStatusType
}
export type ClientManagerStatusType = {
  "primaryEcStatus": ClientStatusType,
  "fallbackEnabled": boolean,
  "fallbackEcStatus": ClientStatusType
}
export type ClientStatusType = {
  "isWorking": boolean
  "isSynced": boolean
  "syncProgress": number,
  "networkId": number
  "error": string
}

//https://github.com/rocket-pool/smartnode/blob/master/shared/types/api/wallet.go
export type walletStatusType = {
  "status": "success" | "error",
  "error": string,
  "passwordSet": boolean,
  "walletInitialized": boolean,
  "accountAddress": string
}

// https://github.com/rocket-pool/smartnode/blob/master/shared/types/api/network.go#L18
export type rplPriceDataType = {
  "status": string,
  "error": string,
  "rplPrice": string, // bigint,
  "rplPriceBlock": number
  "minPer8EthMinipoolRplStake": string, // bigint,
  "maxPer8EthMinipoolRplStake": string, // bigint,
  "minPer16EthMinipoolRplStake": string, // bigint,
  "maxPer16EthMinipoolRplStake": string
}

// https://github.com/rocket-pool/smartnode/blob/master/shared/types/api/network.go#L9
export type nodeFeeType = {
  "status": string,
  "error": string,
  "nodeFee": number
  "minNodeFee": number
  "targetNodeFee": number
  "maxNodeFee": number
}