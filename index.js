const express = require("express");
const app = express();
const https = require("httpolyglot");
const fs = require("fs");
const options = {
    // key: fs.readFileSync("./cert/keytemp.pem", "utf-8"),
    // cert: fs.readFileSync("./cert/cert.pem", "utf-8"),
};
const httpServer = https.createServer(options, app);
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const { fstat } = require("fs");
const PORT = process.env.PORT || 3001

app.use(cors());

let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const io = new Server(httpServer, {
    cors: {
        origin: "*",
    },
});

// const io = new Server(httpServer);

const peers = io.of("/mediasoup");

const createWorker = async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 2020,
    });

    console.log(`worker pid ${worker.pid}`);

    worker.on("died", (error) => {
        console.error("mediasoup worker has died");
        setTimeout(() => process.exit(1), 2000);
    });

    return worker;
};

worker = createWorker();

const mediaCodecs = [
    {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
            "x-google-start-bitrate": 1000,
        },
    },
];

io.on("connection", async (socket) => {
    console.log(socket.id);
    socket.emit("connection_success", {
        socketId: socket.id,
        existsProducer: producer ? true : false,
    });

    socket.on("disconnect", () => {
        console.log("user disconnected");
    });

    socket.on("createRoom", async (callback) => {
        if (router === undefined) {
            router = await worker.createRouter({ mediaCodecs });
            console.log("Route Id: ", router.id);
        }

        getRtpCapabilities(callback);
    });

    // router = await worker.createRouter({ mediaCodecs });

    const getRtpCapabilities = async (callback) => {
        const rtpCapabilities = router.rtpCapabilities;
        console.log("rtp capabilities", rtpCapabilities);
        callback({ rtpCapabilities });
    };

    // socket.on("getRtpCapabilities", (callback) => {
    //   const rtpCapabilities = router.rtpCapabilities;
    //   console.log("rtp capabilities", rtpCapabilities);
    //   callback({ rtpCapabilities });
    // });

    socket.on("createSendTransport", async ({ sender }, callback) => {
        console.log(`Is this a sender request? ${sender}`);
        if (sender) {
            producerTransport = await createWebRtcTransport(callback);
        } else {
            consumerTransport = await createWebRtcTransport(callback);
        }
    });

    socket.on("transport-connect", async ({ dtlsParameters }) => {
        console.log("DTLS parameters", { dtlsParameters });
        await producerTransport.connect({ dtlsParameters });
    });

    socket.on(
        "transport-produce",
        async ({ kind, rtpParameters, appData }, callback) => {
            producer = await producerTransport.produce({
                kind,
                rtpParameters,
            });

            console.log("Producer Id:", producer.id, producer.kind);

            producer.on("transportclose", () => {
                console.log("Transport for this producer closed");
                producer.close();
            });

            callback({
                id: producer.id,
            });
        }
    );

    socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
        console.log("DTLS parameters", { dtlsParameters });
        await consumerTransport.connect({ dtlsParameters });
    });

    socket.on("consume", async ({ rtpCapabilities }, callback) => {
        try {
            if (router.canConsume({ producerId: producer.id, rtpCapabilities })) {
                consumer = await consumerTransport.consume({
                    producerId: producer.id,
                    rtpCapabilities,
                    paused: true,
                });

                console.log("consumer", consumer);

                consumer.on("transportclosed", () => {
                    console.log("transport close from consumer");
                });

                consumer.on("producerclosed", () => {
                    console.log("producer of consumer closed");
                });

                const params = {
                    id: consumer.id,
                    producerId: producer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                };
                callback({ params });
            }
        } catch (error) {
            console.log(error.message);
            callback({
                params: {
                    error: error,
                },
            });
        }
    });

    socket.on("consumer-resume", async () => {
        console.log("consumer resume");
        await consumer.resume();
    });
});

const createWebRtcTransport = async (callback) => {
    try {
        const webRtcTransport_options = {
            listenIps: [{ ip: "127.0.0.1", announcedIp: "127.0.0.1" }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        };

        let transport = await router.createWebRtcTransport(webRtcTransport_options);
        console.log("transport", transport);

        console.log(`transport id: ${transport.id}`);
        transport.on("dtlsstatechange", (dtlsState) => {
            if (dtlsState === "closed") {
                transport.close();
            }
        });

        transport.on("close", () => {
            console.log("transport closed");
        });

        callback({
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            },
        });
        // console.log(transport);
        return transport;
    } catch (error) {
        console.log(error);
        callback({
            params: {
                error: error,
            },
        });
    }
};

app.get("/", (req, res) => {
    res.send("Hello from mediasoup server");
});

if (process.env.NODE_ENV === 'production') {
    app.use(express.static( 'client/build' ));

    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'client', 'build', 'index.html')); // relative path
    });
}

httpServer.listen(PORT, () => {
    console.log("Server is listening on port: " + PORT);
});