import React from "react";

const packageName = "rocketpool.avado.dnp.dappnode.eth";


const LogView = ({ wampSession }) => {
    const [log, setLog] = React.useState("Loading...");

    React.useEffect(() => {
        async function getLog() {
            if (wampSession) {
                const x = await wampSession.call("logPackage.dappmanager.dnp.dappnode.eth", [],
                    {
                        id: packageName,
                        options: { tail: 20 }
                    }
                );
                const res = JSON.parse(x);
                setLog(res.result);
            }
        }
        getLog();
    }, [wampSession])

    return (
        <div>
            <h2 className="title is-3 has-text-white">Latest log entries</h2>
            <pre className="transcript">
                {log}
            </pre>
        </div>
    );
};

export default LogView