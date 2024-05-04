const restify = require("restify");
const corsMiddleware = require("restify-cors-middleware2");
const exec = require("child_process").exec;
const fs = require('fs');
const AdmZip = require("adm-zip");
const jsonfile = require('jsonfile')

console.log("Monitor starting...");

const server = restify.createServer({
    name: "MONITOR",
    version: "1.0.0"
});

const cors = corsMiddleware({
    preflightMaxAge: 5, //Optional
    origins: [
        /^http:\/\/localhost(:[\d]+)?$/,
        "http://*.dappnode.eth",
        "http://*.my.ava.do"
    ]
});

const network = process.env.NETWORK; // either "prater" or "mainnet"

server.pre(cors.preflight);
server.use(cors.actual);
server.use(restify.plugins.bodyParser());

server.post("/rpd", (req, res, next) => {
    if (!req.body) {
        res.send(400, "not enough parameters");
        return next();
    } else {
        rpd(req.body.command).then((stdout) => {
            res.send(200, stdout);
            return next();
        }).catch((e) => {
            res.send(500, e);
            return next();
        })
    }
});

const execute = (cmd) => {
    return new Promise((resolve, reject) => {
        const child = exec(cmd, (error, stdout, stderr) => {
            const debug = false;
            if (debug) {
                switch (cmd) {
                    case "wallet init":
                        return resolve('{"status":"success","error":"","mnemonic":"corn wool actor cable marine anger nothing return coast energy magnet evolve best lion dutch clerk visit begin agree about sing federal sausage ribbon","accountAddress":"0xd97afeffa7ce00aa489e5c88880e124fb75b8e05"}');
                    case "node register Europe/Brussels":
                        return resolve('{"status":"success","error":"","txHash":"0x27f5b5bb3905cd135cdef17e71f6f9ac70e3e95fd372999cb4eea918f3990310"}');
                    case "network node-fee":
                        return resolve(`{"status":"success","error":"","nodeFee":0.10941535273234365,"minNodeFee":0.05,"targetNodeFee":0.1,"maxNodeFee":0.2}`);
                    case "network rpl-price":
                        return resolve('{"status":"success","error":"","rplPrice":11613106459524954,"rplPriceBlock":6199200,"minPerMinipoolRplStake":137775366614993524895,"maxPerMinipoolRplStake":2066630499224902873416}');
                    case "node sync":
                        return resolve('{ "status": "success", "error": "", "ecStatus": { "primaryEcStatus": { "isWorking": true, "isSynced": true, "syncProgress": 0, "error": "" }, "fallbackEnabled": false, "fallbackEcStatus": { "isWorking": false, "isSynced": false, "syncProgress": 0, "error": "" } }, "eth2Progress": 1, "eth2Synced": true }');
                    //return resolve('{ "status": "success", "error": "", "ecStatus": { "primaryEcStatus": { "isWorking": true, "isSynced": false, "syncProgress": 0.10967741935483871, "error": "" }, "fallbackEnabled": false, "fallbackEcStatus": { "isWorking": false, "isSynced": false, "syncProgress": 0, "error": "" } }, "eth2Progress": 0.9912876700950112, "eth2Synced": false }')
                    case "node status":
                        return resolve('{"status":"success","error":"","accountAddress":"0xe28b9c4109a8ee3d70775a15ba219a140b06f22a","withdrawalAddress":"0x9b18e9e9aa3dd35100b385b7035c0b1e44afca14","pendingWithdrawalAddress":"0x0000000000000000000000000000000000000000","registered":true,"trusted":false,"timezoneLocation":"Europe/Brussels","accountBalances":{"eth":493680693977882429,"reth":0,"rpl":1000000000000000000,"fixedSupplyRpl":0},"withdrawalBalances":{"eth":22380804572630665781,"reth":982807350942407963,"rpl":1312981538476790019908,"fixedSupplyRpl":0},"rplStake":199000000000000000000,"effectiveRplStake":199000000000000000000,"minimumRplStake":136538053959214892496,"maximumRplStake":2048070809388223387444,"collateralRatio":0.1457469139405217,"minipoolLimit":1,"minipoolCounts":{"total":1,"initialized":0,"prelaunch":0,"staking":1,"withdrawable":0,"dissolved":0,"refundAvailable":0,"withdrawalAvailable":0,"closeAvailable":0,"finalised":0}}');
                    case "minipool status":
                        return resolve('{"status":"success","error":"","minipools":[{"address":"0x972550d31e363cb3e08f3ecf8493c67a7ef87548","validatorPubkey":"85c9488dd77302b11d1b752869a89c9a080fce47ae71d5c80dc894528453756df2fb6c2d85d9e3edae2645967e74f6dd","status":{"status":"Staking","statusBlock":6198207,"statusTime":"2022-01-14T08:44:28Z"},"depositType":"Half","node":{"address":"0xe28b9c4109a8ee3d70775a15ba219a140b06f22a","fee":0.1578276031321713,"depositBalance":16000000000000000000,"refundBalance":0,"depositAssigned":true},"user":{"depositBalance":16000000000000000000,"depositAssigned":true,"depositAssignedTime":"2022-01-10T16:36:35Z"},"balances":{"eth":0,"reth":0,"rpl":0,"fixedSupplyRpl":0},"validator":{"exists":true,"active":true,"index":271936,"balance":32007591077000000000,"nodeBalance":16004394579244050876},"refundAvailable":false,"withdrawalAvailable":false,"closeAvailable":false,"finalised":false,"useLatestDelegate":false,"delegate":"0xc6b40c1a317144a09c303c504cb525ee68ab8c8e","previousDelegate":"0x0000000000000000000000000000000000000000","effectiveDelegate":"0xc6b40c1a317144a09c303c504cb525ee68ab8c8e"}],"latestDelegate":"0xc6b40c1a317144a09c303c504cb525ee68ab8c8e"}');
                    case "wallet status":
                        return resolve('{"status":"success","error":"","passwordSet":true,"walletInitialized":true,"accountAddress":"0xe28b9c4109a8ee3d70775a15ba219a140b06f22a"}');
                    case "node can-register Europe/Brussels":
                        return resolve('{"status":"success","error":"","canRegister":true,"alreadyRegistered":false,"registrationDisabled":false,"gasInfo":{"estGasLimit":247168,"safeGasLimit":370752}}');
                    case "node deposit 16000000000000000000 0.1 0":
                        return resolve('{"status":"success","error":"","txHash":"0x5d580b252d20265c2e7a17e90c5d40f11c452a1f52af40fb0f7eb8830ceb149c","minipoolAddress":"0x62c98ff0418c36768513ae1e6d4a6f197535e142","validatorPubkey":"b9916da8896ef44e230aac1cc496eef029cc207be2560ab5b1884719b5c56722c145d1acfd882ddbb162e3f4156ec716","scrubPeriod":3600000000000}')

                    default:
                        return resolve('{"status":"success","error":""}');
                }
            } else {
                if (error) {
                    console.log(`error: ${error.message}`);
                    return reject(error.message);
                }
                if (stderr) {
                    console.log(`error: ${stderr}`);
                    return reject(stderr);
                }
                return resolve(stdout);
            }
        });
        child.stdout.on('data', (data) => console.log(data.toString()));
    });
}

const storeTxHash = (txHash) => {
    const transactionsFile = "/rocketpool/data/transactions.json";
    console.log(`Store hash ${txHash} to ${transactionsFile}`);
    try {
        const data = (fs.existsSync(transactionsFile)) ? jsonfile.readFileSync(transactionsFile) : { transactions: [] };
        data.transactions.push(txHash);
        jsonfile.writeFileSync(transactionsFile, data);
    } catch (e) {
        console.error(e)
    }
}

const rpd = (command) => {
    const cmd = `/usr/local/bin/rocketpoold --settings /srv/rocketpool/user-settings.yml api ${command}`;
    console.log(`Running ${cmd}`);
    if (command.includes("wallet") && !command.includes("status")) {
        const datafolder = "/rocketpool/data";
        if (!fs.existsSync(datafolder)) {
            console.log("Creating " + datafolder)
            fs.mkdirSync(datafolder);
        }
    }

    if (command.includes("set-smoothing-pool-status")) {
        const datafolder = "/rocketpool/data/validators";
        if (!fs.existsSync(datafolder)) {
            console.log("Creating " + datafolder)
            fs.mkdirSync(datafolder);
        }
    }

    const executionPromise = execute(cmd);

    executionPromise.then((result) => {
        const data = JSON.parse(result);
        if (command.includes("wallet init") && "mnemonic" in data) {
            // store mnemonic to file
            fs.writeFile("/rocketpool/data/mnemonic", data.mnemonic, (err) => console.log(err ? err : "Saved mnemoic"));
        }
        if ("txHash" in data) {
            storeTxHash(data.txHash);
        }
    })

    return executionPromise;
}

//restart Rocket Pool smartnode
server.get("/network", (req, res, next) => {
    res.send(200, network);
    return next();
});

server.get("/settings", (req, res, next) => {
    try {
        const settings = jsonfile.readFileSync("/srv/rocketpool/settings.json");
        res.send(200, settings);
    } catch (e) {
        console.error(e)
    }
    return next();
});

// Restart Rocket Pool smartnode
server.get("/restart-rocketpool-node", async (req, res) => {
    console.log(`Restart Rocket Pool smartnode`);
    const cmd = "supervisorctl restart rocketpool-node";

    try {
        const stdout = await execute(cmd);
        res.send(200, stdout);
    } catch (e) {
        res.send(500, e);
    }
});

// Backup
const backupFileName = "rocket-pool-backup.zip";
server.get("/" + backupFileName, (req, res, next) => {
    res.setHeader("Content-Disposition", "attachment; filename=" + backupFileName);
    res.setHeader("Content-Type", "application/zip");

    const zip = new AdmZip();
    zip.addLocalFolder("/rocketpool/data", "data");

    try {
        const buffer = zip.toBuffer();
        res.setHeader("Content-Length", buffer.length);
        res.end(buffer, "binary");
    } catch (err) {
        next(err);
    }

    return next();
});

//restore
server.post('/restore-backup', (req, res, next) => {
    console.log("upload backup zip file");
    if (req.files.file) {
        const file = req.files.file;
        req.info = file.name;
        const zipfilePath = "/tmp/" + file.name;
        fs.renameSync(file.path, zipfilePath, (err) => { if (err) console.log('ERROR: ' + err) });
        console.log("received backup file " + file.name);
        try {
            validateZipFile(zipfilePath);

            // delete existing data folder (if it exists)
            fs.rmSync("/rocketpool/data", { recursive: true, force: true /* ignore if not exists */ });

            // unzip
            const zip = new AdmZip(zipfilePath);
            zip.extractAllTo("/rocketpool/", /*overwrite*/ true);

            res.send({
                code: 200,
                message: "Successfully uploaded the Rocket Pool backup. Click restart to complete the restore.",
            });
            return next();
        } catch (e) {
            console.dir(e);
            console.log(e);
            res.send({
                code: 400,
                message: e.message,
            });
            return next();
        }
    }

    function validateZipFile(zipfilePath) {
        console.log("Validating " + zipfilePath);
        const zip = new AdmZip(zipfilePath);
        const zipEntries = zip.getEntries();

        checkFileExistsInZipFile(zipEntries, "data/password")
        checkFileExistsInZipFile(zipEntries, "data/mnemonic")
        checkFileExistsInZipFile(zipEntries, "data/wallet")
        checkFileExistsInZipFile(zipEntries, "data/validators/prysm-non-hd/direct/accounts/all-accounts.keystore.json")
        checkFileExistsInZipFile(zipEntries, "data/validators/prysm-non-hd/direct/accounts/secret")
        checkFileExistsInZipFile(zipEntries, "data/validators/prysm-non-hd/direct/keymanageropts.json")
    }

    function checkFileExistsInZipFile(zipEntries, expectedPath) {
        const containsFile = zipEntries.some((entry) => entry.entryName == expectedPath);
        if (!containsFile)
            throw { message: `Invalid backup file. The zip file must contain "${expectedPath}"` }
    }
});

server.listen(9999, function () {
    console.log("%s listening at %s", server.name, server.url);
    console.assert(network == "prater" || network == "holesky" || network == "mainnet", 'Wrongly configured NETWORK environment variable! Use either "prater" or "mainnet"');
});
