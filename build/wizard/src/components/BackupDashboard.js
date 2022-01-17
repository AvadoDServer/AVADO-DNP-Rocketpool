import React from "react";
import DownloadBackup from "./DownloadBackup";
import RestoreBackup from "./RestoreBackup";


const BackupDashboard = ({ wampSession }) => {
    const [tab, setTab] = React.useState("backup");
    return (
        <div className="setting">
            <section className="is-medium has-text-white">
                <div className="columns">
                    <div className="column is-half">

                        <nav className="panel is-half">
                            <p className="panel-heading">Backup and Restore</p>

                            <p className="panel-tabs">
                                <a className={`${tab === "backup" ? "is-active  has-text-weight-bold" : ""} has-text-white`} onClick={() => { setTab("backup") }} >Backup</a>
                                <a className={`${tab === "restore" ? "is-active has-text-weight-bold" : ""} has-text-white`} onClick={() => { setTab("restore") }} >Restore</a>
                            </p>
                            <div className="panel-block">

                                {tab === "backup" && (
                                    <section className="is-medium has-text-white">
                                        <p className="">TODO: add info about downloading backup (security advisory too (contains password)).</p>
                                        <DownloadBackup />
                                    </section>
                                )}
                                {tab === "restore" && (
                                    <section className="is-medium has-text-white">
                                        <p className="">Here you can upload your node identity keys. If you want to restore your node ID from a previous installation.</p>
                                        <RestoreBackup session={wampSession} />
                                    </section>
                                )}
                            </div>
                        </nav>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default BackupDashboard