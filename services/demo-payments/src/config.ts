export type FaultMode = 'enabled' | 'disabled';

export interface PaymentsConfig {
  faultMode: FaultMode;
  serviceVersion: string;
  environment: string;
  deploymentId: string;
}

const DEFAULT_SERVICE_VERSION = '0.1.0';
const DEFAULT_ENVIRONMENT = 'local';

export function loadConfig(env: Record<string, string | undefined>): PaymentsConfig {
  const rawFaultMode = env.PAYMENTS_FAULT_MODE;
  let faultMode: FaultMode;
  if (rawFaultMode === undefined) {
    faultMode = 'disabled';
  } else if (rawFaultMode === 'enabled' || rawFaultMode === 'disabled') {
    faultMode = rawFaultMode;
  } else {
    throw new Error('PAYMENTS_FAULT_MODE must be enabled or disabled');
  }

  return {
    faultMode,
    serviceVersion: env.PAYMENTS_VERSION || DEFAULT_SERVICE_VERSION,
    environment: env.DEPLOYMENT_ENVIRONMENT || DEFAULT_ENVIRONMENT,
    deploymentId: env.DEPLOYMENT_ID ?? '',
  };
}

export function resourceAttributes(config: PaymentsConfig): Record<string, string> {
  const attributes: Record<string, string> = {
    'service.version': config.serviceVersion,
    'deployment.environment.name': config.environment,
  };
  if (config.deploymentId !== '') {
    attributes['deployment.id'] = config.deploymentId;
  }
  return attributes;
}
