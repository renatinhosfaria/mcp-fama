export const SERVICE_VERSION = '1.0.1';
export function resolveDeploymentMetadata(env = process.env) {
    return {
        version: SERVICE_VERSION,
        gitSha: env.GIT_SHA || 'unknown',
        buildTime: env.BUILD_TIME || 'unknown',
        deploymentId: env.DEPLOYMENT_ID || 'unknown',
    };
}
