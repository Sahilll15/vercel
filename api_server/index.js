const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
require('dotenv').config()
const { z } = require('zod')
const { PrismaClient } = require('@prisma/client')
const { createClient } = require('@clickhouse/client')
const { Kafka } = require('kafkajs')
const { v4: uuidv4 } = require('uuid')
const fs = require('fs')
const path = require('path')

// const Redis = require("ioredis");
// const redisUri = process.env.REDIS_URI
// const subscriber = new Redis(redisUri);

const kafka = new Kafka({
    clientId: `api-server`,
    brokers: ['kafka-738badd-sahilchalke1011-0d2f.a.aivencloud.com:16001'],
    ssl: {
        ca: [fs.readFileSync(path.join(__dirname, 'kafka.pem'), 'utf-8')],
    },

    sasl: {
        username: 'avnadmin',
        password: "AVNS_D6IsGrAD84Cj5T5j-_E",
        mechanism: 'plain'
    },
})

const consumer = kafka.consumer({ groupId: 'api-server-logs-consumer' })

const client = createClient({
    url: 'https://clickhouse-9d2afce-sahilchalke1011-0d2f.a.aivencloud.com',
    username: 'avnadmin',
    database: 'default',
    password: "AVNS_M4bzVac06_olQviKhFF"

})

const app = express()

const PORT = 9000


app.use(express.urlencoded({ extended: true }))


app.use(express.json())

const io = new Server(9001, {
    cors: "*"
})


const prisma = new PrismaClient();


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
    const schema = z.object({
        name: z.string(),
        gitUrl: z.string()
    })

    const safeParseResult = schema.safeParse(req.body)

    if (!safeParseResult.success) {
        return res.status(400).json({ error: safeParseResult.error })
    }


    const { name, gitUrl } = req.body


    const project = await prisma.project.create({
        data: {
            name,
            gitUrl,
            subDomain: generateSlug()
        }
    })

    return res.json({
        status: 'success',
        data: project
    })


})


app.post('/deploy', async (req, res) => {
    const { projectId } = req.body

    const schema = z.object({
        projectId: z.string()
    })

    const safeParseResult = schema.safeParse(req.body)

    if (!safeParseResult.success) {
        return res.status(400).json({ error: safeParseResult.error })
    }

    const project = await prisma.project.findUnique({
        where: {
            id: projectId
        }
    })

    if (!project) {
        return res.status(404).json({ error: 'Project Not Found' })
    }




    const slug = project.subDomain
    const gitUrl = project.gitUrl


    const deployment = await prisma.deployment.create({
        data: {
            project: { connect: { id: projectId } },
            status: 'QUEUED'
        }
    })




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
                            value: projectId
                        }, {
                            name: 'DEPLOYMENT_ID',
                            value: deployment.id
                        }
                    ]
                }
            ]
        }
    })



    await ecsClient.send(command)

    res.json({ status: 'queued', data: { deploymentId: deployment.id } })
})
async function initkafkaConsumer() {
    await consumer.connect();
    await consumer.subscribe({ topics: ['container-logs'], fromBeginning: true })

    await consumer.run({

        eachBatch: async function ({ batch, heartbeat, commitOffsetsIfNecessary, resolveOffset }) {

            const messages = batch.messages;
            console.log(`Recv. ${messages.length} messages..`)
            for (const message of messages) {
                if (!message.value) continue;
                const stringMessage = message.value.toString()
                const { PROJECT_ID, DEPLOYEMENT_ID, log } = JSON.parse(stringMessage)
                console.log({ log, DEPLOYEMENT_ID })
                try {
                    const { query_id } = await client.insert({
                        table: 'log_events',
                        values: [{ event_id: uuidv4(), deployment_id: DEPLOYEMENT_ID, log }],
                        format: 'JSONEachRow'
                    })
                    console.log(query_id)
                    resolveOffset(message.offset)
                    await commitOffsetsIfNecessary(message.offset)
                    await heartbeat()
                } catch (err) {
                    console.log(err)
                }

            }
        }
    })
}

initkafkaConsumer()

app.listen(PORT, () => console.log(`Server Running on ${PORT}`))
