const path = require('path');
const core = require('@actions/core');
const aws = require('aws-sdk');
const fs = require('fs');
const util = require('util');

async function readJsonFile(envFile) {
    try {
        const data = await fs.promises.readFile(envFile, 'utf8')
        return JSON.parse(data)
    } catch (e) {
        throw e
    }
}


async function renderEnvironment(envFile) {
    if (!envFile) {
        return []
    }
    const ext = path.extname(envFile)
    if (!['.json'].includes(ext)) {
        core.setFailed("Env file is supported type only json file.");
    }

    let data = await readJsonFile(envFile)

    let envs = [];

    for (const key in data) {
        envs.push({
            'name': key,
            'value': data[key],
        })
    }

    return envs
}

async function renderTaskDefinition(taskDefinitionArn, envFile) {

    const ecs = new aws.ECS()
    const params = {
        taskDefinition: taskDefinitionArn
    };

    const envs = await renderEnvironment(envFile)

    try {
        const taskDefinitionObject = await ecs.describeTaskDefinition(params).promise();
        let containerDefinitions = taskDefinitionObject.taskDefinition.containerDefinitions
        containerDefinitions = containerDefinitions.map(item => {
            return {
                name: item.name,
                image: item.image,
                cpu: item.cpu,
                memory: item.memory,
                portMappings: item.portMappings,
                environment: envs.length > 0 ? envs : item.environment,
                mountPoints: item.mountPoints,
                volumesFrom: item.volumesFrom,
                logConfiguration: item.logConfiguration,
            }
        })

        return {
            memory: taskDefinitionObject.taskDefinition.memory,
            cpu: taskDefinitionObject.taskDefinition.cpu,
            containerDefinitions: containerDefinitions,
            family: taskDefinitionObject.taskDefinition.family,
            executionRoleArn: taskDefinitionObject.taskDefinition.executionRoleArn,
            networkMode: taskDefinitionObject.taskDefinition.networkMode,
            requiresCompatibilities: taskDefinitionObject.taskDefinition.requiresCompatibilities,

        }
    } catch (e) {
        core.setFailed(e.stack);
    }
}

async function updateEcsService(ecs, clusterName, service, taskDefArn, forceNewDeployment, desiredCount) {
    core.debug('Updating the service');
    await ecs.updateService({
        cluster: clusterName,
        service: service,
        desiredCount: desiredCount,
        taskDefinition: taskDefArn,
        forceNewDeployment: forceNewDeployment
    }).promise();

    core.info(`Deployment started. Watch this deployment's progress in the Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/services/${service}/events`);
}

async function run() {
    try {

        // let awsRegion = core.getInput('AWS_REGION', {required: true});

        const awsRegion = 'ap-southeast-1';
        const awsAccountId = '872692067237';
        let clusterName = 'tracking-development';
        let serviceName = 'tracking-development-api-service';
        let envFile = './envs/dev.json';

        aws.config.update({region: awsRegion});

        const ecs = new aws.ECS({
            customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
        });

        // let awsAccountId = core.getInput('AWS_ACCOUNT_ID', {required: true});

        // let clusterName = core.getInput('CLUSTER_NAME', {required: true});
        //
        // let serviceName = core.getInput('SERVICE_NAME', {required: true});

        const desiredCount = core.getInput('DESIRED_COUNT', {required: false}) || 1;

        // const envFile = core.getInput('ENV_FILE', {required: false}) || null;

        // serviceName = `${clusterName}-${serviceName}-service`

        let ecsTaskName = `${serviceName}-task`

        let taskDefinitionArn = `arn:aws:ecs:${awsRegion}:${awsAccountId}:task-definition/${ecsTaskName}`

        const forceNewDeployInput = core.getInput('force-new-deployment', {required: false}) || 'false';
        const forceNewDeployment = forceNewDeployInput.toLowerCase() === 'false';

        core.debug('Registering the task definition');
        let registerResponse;
        let taskDefContents = await renderTaskDefinition(taskDefinitionArn, envFile);
        try {
            registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
        } catch (error) {
            core.setFailed("Failed to register task definition in ECS: " + error.message);
            core.debug("Task definition contents:");
            core.debug(JSON.stringify(taskDefContents, undefined, 4));
            throw(error);
        }

        const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
        core.setOutput('task-definition-arn', taskDefArn);

        if (serviceName) {
            clusterName = clusterName ? clusterName : 'default';

            const describeResponse = await ecs.describeServices({
                services: [serviceName], cluster: clusterName
            }).promise();

            if (describeResponse.failures && describeResponse.failures.length > 0) {
                const failure = describeResponse.failures[0];
                throw new Error(`${failure.arn} is ${failure.reason}`);
            }

            const serviceResponse = describeResponse.services[0];
            if (serviceResponse.status != 'ACTIVE') {
                throw new Error(`Service is ${serviceResponse.status}`);
            }

            if (!serviceResponse.deploymentController) {
                await updateEcsService(ecs, clusterName, serviceName, taskDefArn, forceNewDeployment, desiredCount);
            } else {
                throw new Error(`Unsupported deployment controller: ${serviceResponse.deploymentController.type}`);
            }
        } else {
            core.debug('Service was not specified, no service updated');
        }
    } catch (error) {
        core.setFailed(error.message);
        core.debug(error.stack);
    }
}

module.exports = run;


run()