const express = require('express');
const cors = require('cors');
const { generateSlug } = require('random-word-slugs');
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Server } = require('socket.io')
const Redis = require('ioredis');


const app = express();
const PORT = process.env.API_PORT || 9000;
const SOCKET_PORT = process.env.SOCKET_PORT || 9002;
const PROXY_DOMAIN = process.env.PROXY_DOMAIN || 'localhost:8000';

const subscriber = new Redis(process.env.REDIS_URL);

const io = new Server({ cors:'*' })

io.listen(SOCKET_PORT)
console.log(`Socket Server running on ${SOCKET_PORT}`)

io.on('connection', (socket)=>{
    socket.on('subscribe', channel =>{
        socket.join(channel)
        socket.emit('message', `Joined ${channel}`)
    })
})
// AWS ECS client
const ecsClient = new ECSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// ECS Config
const config = {
    CLUSTER: process.env.ECS_CLUSTER_ARN,
    TASK: process.env.ECS_TASK_ARN,
    SUBNETS: process.env.ECS_SUBNETS.split(","), // comma separated
    SECURITY_GROUPS: process.env.ECS_SECURITY_GROUPS.split(","),
};

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

// API Route
app.post('/project', async (req, res) => {
    try {
        const { gitURL , slug} = req.body;
        const projectSlug = slug ? slug : generateSlug();

        // Run ECS Task
        const command = new RunTaskCommand({
            cluster: config.CLUSTER,
            taskDefinition: config.TASK,
            launchType: 'FARGATE',
            count: 1,
            networkConfiguration: {
                awsvpcConfiguration: {
                    assignPublicIp: 'ENABLED',
                    subnets: config.SUBNETS,
                    securityGroups: config.SECURITY_GROUPS,
                },
            },
            overrides: {
                containerOverrides: [
                    {
                        name: process.env.ECS_CONTAINER_NAME || 'image-builder',
                        environment: [
                            { name: 'GIT_REPOSITORY__URL', value: gitURL },
                            { name: 'PROJECT_ID', value: projectSlug },
                        ],
                    },
                ],
            },
        });

        await ecsClient.send(command);

        return res.json({
            status: 'queued',
            data: {
                projectSlug,
                url: `http://${projectSlug}.${PROXY_DOMAIN}`,
            },
        });
    } catch (err) {
        console.error("ECS RunTask Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

async function initRedisSubscribe() {
    console.log('Subscribed to logs...')
    subscriber.psubscribe('logs:*')
    subscriber.on('pmessage', (pattern, channel, message) => {
        io.to(channel).emit('message', message)
    })
  
}

initRedisSubscribe()

app.listen(PORT, () => console.log(`API Server running on port ${PORT}`));
