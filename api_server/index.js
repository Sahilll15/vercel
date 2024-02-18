const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
require('dotenv').config()

const Redis = require("ioredis");
const redisUri = process.env.REDIS_URI
const subscriber = new Redis(redisUri);

const app = express()

const PORT = 9000


app.use(express.urlencoded({ extended: true }))


app.use(express.json())

const io = new Server(9001, {
    cors: "*"
})



io.on('connection', (socket) => {
    console.log('Socket Connected')
    socket.on('subscribe', (channel) => {
        socket.join(channel)
        socket.emit('message', 'Subscribed to ' + channel)
    })
}
)


const ecsClient = new ECSClient({
    region: 'eu-north-1',
    credentials: {
        accessKeyId: 'AKIAU6GDV5VZP6P3CBDY',
        secretAccessKey: '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'
    }

})

const config = {
    CLUSTER: 'arn:aws:ecs:eu-north-1:339712798066:cluster/builder-vercel-cluster',
    TASK: "arn:aws:ecs:eu-north-1:339712798066:task-definition/builder-vercel-task"
}


app.get('/', (req, res) => {
    res.send('Hello World')
}
)


app.post('/project', async (req, res) => {
    const { gitUrl, oldSlug } = req.body
    const slug = oldSlug ? oldSlug : generateSlug()

    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets: ['subnet-0effb881c49342f04', 'subnet-067e435e21db3c667', 'subnet-0b99efd6cfb3ef4fb'],
                securityGroups: ['sg-087caffc208190749'],
                assignPublicIp: 'ENABLED'

            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'builder-image',
                    environment: [
                        {
                            name: 'GIT_REPOSITORY__URL',
                            value: gitUrl
                        },
                        {
                            name: 'PROJECT_ID',
                            value: slug
                        }
                    ]
                }
            ]
        }
    })



    await ecsClient.send(command)

    res.json({ status: 'queued', data: { slug, url: `http://${slug}.localhost:8000` } })
})

const initRedis = async () => {
    console.log('suibecribing to redis')
    subscriber.psubscribe('logs:*')
    subscriber.on('pmessage', (pattern, channel, message) => {
        const slug = channel
        io.to(slug).emit('message', message)
    })

}


initRedis();

app.listen(PORT, () => console.log(`Server Running on ${PORT}`))
