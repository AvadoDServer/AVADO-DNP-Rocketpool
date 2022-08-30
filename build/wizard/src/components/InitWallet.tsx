import React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import DownloadBackup from "./DownloadBackup";
import { walletStatusType } from "./Types";

interface Props {
    walletStatus: walletStatusType
    updateWalletStatus: any,
    updateNodeStatus: any
    rpdDaemon: any,
    onFinished: any
}

const InitWallet = ({ walletStatus, updateWalletStatus, updateNodeStatus, rpdDaemon, onFinished }: Props) => {
    const [password, setPassword] = React.useState("");
    const [verifyPassword, setVerifyPassword] = React.useState("");
    const [passwordFeedback, setPasswordFeedback] = React.useState("");
    const [passwordFieldType, setPasswordFieldType] = React.useState("password");
    const [passwordFieldIcon, setPasswordFieldIcon] = React.useState(faEyeSlash);
    const [buttonDisabled, setButtonDisabled] = React.useState(false);
    const [walletMnemonic, setWalletMnemonic] = React.useState("");
    const [walletAddress, setWalletAddress] = React.useState("");
    const [initialWalletStatus, setInitialWalletStatus] = React.useState<walletStatusType>();

    const toggleViewPassword = () => {
        const currentType = passwordFieldType;
        setPasswordFieldType(currentType === "password" ? "text" : "password");
        setPasswordFieldIcon(currentType === "password" ? faEye : faEyeSlash);
    }

    React.useEffect(() => {
        //{"status":"error","error":"Invalid wallet password 'test' - must be at least 12 characters long"}
        if (password.length < 12) {
            setPasswordFeedback("Invalid wallet password - must be at least 12 characters long");
            setButtonDisabled(true);
        } else if (password !== verifyPassword) {
            setPasswordFeedback("Invalid wallet password - passwords do not match");
            setButtonDisabled(true);
        } else {
            setPasswordFeedback("");
            setButtonDisabled(false);
        }
    }, [password, verifyPassword]);

    React.useEffect(() => {
        if (!initialWalletStatus)
            setInitialWalletStatus(walletStatus);
    }, [walletStatus, initialWalletStatus]);

    // Future improvement: allow recovery (`wallet recover mnemonic`)
    const initWallet = () => {
        if (!walletStatus.passwordSet) {
            rpdDaemon("wallet set-password \"" + password + "\"", (data: {status:string, error:string}) => {
                if (data.status === "error") {
                    setPasswordFeedback(data.error);
                    return;
                }
                rpdDaemon("wallet init", (data: {status:string, error:string, accountAddress: string, mnemonic: string}) => {
                    //{"status":"success","error":"","mnemonic":"corn wool actor cable marine anger nothing return coast energy magnet evolve best lion dutch clerk visit begin agree about sing federal sausage ribbon","accountAddress":"0xd97afeffa7ce00aa489e5c88880e124fb75b8e05"}
                    if (data.status === "error") {
                        setPasswordFeedback(data.error);
                    }
                    setWalletAddress(data.accountAddress);
                    setWalletMnemonic(data.mnemonic);

                    // Do a recover to save the wallet
                    // https://github.com/rocket-pool/smartnode/blob/master/rocketpool-cli/wallet/init.go#L78
                    rpdDaemon(`wallet recover "${data.mnemonic}"`, (data: {status:string, error:string}) => {
                        //{"status":"success","error":"","mnemonic":"corn wool actor cable marine anger nothing return coast energy magnet evolve best lion dutch clerk visit begin agree about sing federal sausage ribbon","accountAddress":"0xd97afeffa7ce00aa489e5c88880e124fb75b8e05"}
                        if (data.status === "error") {
                            setPasswordFeedback(data.error);
                        }
                        setButtonDisabled(true);
                        updateWalletStatus();
                        updateNodeStatus();
                    });
                });
            });
        }

    }


    return (
        <div>
            {/* {initialWalletStatus && !initialWalletStatus.walletInitialized && */}
            <div>
                <h2 className="title is-3 has-text-white">Init wallet</h2>

                {(!walletStatus.accountAddress || walletStatus.accountAddress === "0x0000000000000000000000000000000000000000") ? (
                    <>
                        <div className="content">
                            <p>We will create a hot wallet that you will use for your minipool.</p>
                        </div>

                        <div className="field">
                            <label className="label">Rocket pool node password</label>
                            <p className="help">This is the password that will encrypt your Rocket Pool (hot) wallet - minimum length  =  12 characters</p>
                        </div>
                        <div className="field has-addons">
                            <div className="control is-expanded">
                                <input className="input" type={passwordFieldType} onChange={(e) => { setPassword(e.target.value) }} />

                            </div>
                            <div className="control">
                                {/* eslint-disable-next-line */}
                                <a onClick={toggleViewPassword} className="button is-link is-light"><FontAwesomeIcon
                                    className="icon is-small is-right avadoiconpadding"
                                    icon={passwordFieldIcon}
                                />
                                </a></div>
                        </div>

                        <div className="field">
                            <label className="label">Verify Password</label>
                            <div className="control">
                                <input className="input" type={passwordFieldType} onChange={(e) => { setVerifyPassword(e.target.value) }} />
                            </div>
                            {password && (
                                <p className="help is-danger">{passwordFeedback}</p>
                            )}
                        </div>

                        <div className="field">
                            <button className="button" onClick={initWallet} disabled={buttonDisabled}>Init Wallet</button>
                        </div>
                    </>
                ) : (
                    <div>
                        <p>Your Rocketpool hot-wallet has been created and its address is {walletStatus.accountAddress}</p>
                        <br />
                        <div className="columns">
                            <div className="column is-two-thirds">
                                <article className="message is-warning ">
                                    <div className="message-header">
                                        <p>Download backup</p>
                                    </div>
                                    <div className="message-body">
                                        <p>Please download a backup of your hot wallet before continuing!</p><br />
                                        <DownloadBackup description="Download backup of my wallet" /><br /><br />
                                    </div>
                                </article>
                            </div>
                        </div>
                        <button className="button" onClick={() => { onFinished() }}>I downloaded a backup of my wallet - continue to next step</button>
                    </div>
                )}
            </div>
            {/* } */}
        </div>
    );
};

export default InitWallet