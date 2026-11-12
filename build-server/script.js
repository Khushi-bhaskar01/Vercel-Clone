const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const mime = require('mime-types');
const Redis = require('ioredis');

// In ECS these come from the task definition; locally they come from the root .env
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const publisher = new Redis(process.env.REDIS_URL);

// If no keys are set (e.g. on ECS with a task role), the SDK picks up the role automatically
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    ...(process.env.AWS_ACCESS_KEY_ID && {
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
    }),
});

const PROJECT_ID = process.env.PROJECT_ID;

function publishLog(log){
    publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }));
}


async function init() {
    console.log('Executing script.js');
    publishLog('Build Started...');
    const outDirPath = path.join(__dirname, 'output');

    const p = exec(`cd ${outDirPath} && npm install && npm run build`);

    p.stdout.on('data', function (data) {
        console.log(data.toString());
        publishLog(data.toString());
    });

    p.stderr?.on('data', function (data) {
        console.error('Error:', data.toString());
        publishLog(`error: ${data.toString()}`);
    });

    p.on('close', async function () {
        console.log('Build Complete');
        publishLog('Build Complete');
        const distFolderPath = path.join(__dirname, 'output', 'dist');
        const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true });

        publishLog('Starting to Upload');
        for (const filePath of distFolderContents) {
            const fullPath = path.join(distFolderPath, filePath);  
            if (fs.lstatSync(fullPath).isDirectory()) continue;   

            console.log('Uploading file:', filePath);
            publishLog(`Uploading ${filePath}`);
            const command = new PutObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: `__outputs/${PROJECT_ID}/${filePath}`,
                Body: fs.createReadStream(fullPath),   
                ContentType: mime.lookup(filePath) || 'application/octet-stream'
            });

            await s3Client.send(command);
            console.log('Uploaded:', filePath);
            publishLog(`Uploaded ${filePath}`);
        }
        publishLog('Done...');
        console.log('Done...');
    });
}

init();
