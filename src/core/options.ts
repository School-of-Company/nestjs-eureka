import { parseServiceUrl } from './service-url';

/** Public: the instance metadata registered with Eureka. */
export interface EurekaInstanceOptions {
  app: string;
  hostName: string;
  ipAddr: string;
  port: number;
  /** Default: `${hostName}:${app}:${port}`. Two replicas sharing hostName+app+port would
   *  register as the same Eureka instance — production/containerized deployments should
   *  pass an explicit, unique `instanceId`. */
  instanceId?: string;
  securePort?: number;
  vipAddress?: string;
  secureVipAddress?: string;
  metadata?: Record<string, string>;
  homePageUrl?: string;
  statusPageUrl?: string;
  healthCheckUrl?: string;
}

/**
 * The client's input options shape. Kept as an internal name here — the only
 * public name for this shape is `EurekaModuleOptions`, aliased in
 * `nest/eureka.interfaces.ts`. Don't re-export this type name from `index.ts`.
 */
export interface EurekaClientOptions {
  serviceUrl: string;
  instance: EurekaInstanceOptions;
  /** Default 30. Must be smaller than `leaseDurationSeconds`. */
  heartbeatIntervalSeconds?: number;
  /** Default 90. */
  leaseDurationSeconds?: number;
  /**
   * Default `'fail-fast'`: a failed initial registration rejects application
   * bootstrap. `'background'`: the failure is logged, bootstrap continues,
   * and registration is retried on the heartbeat schedule until it succeeds.
   */
  registrationMode?: 'fail-fast' | 'background';
}

/**
 * Normalized, validated configuration. Internal only — never exported from
 * `index.ts`, and `authorizationHeader` in particular must never be
 * reachable from a public type or getter.
 */
export interface ResolvedEurekaOptions {
  baseUrl: string;
  authorizationHeader?: string;
  heartbeatIntervalMs: number;
  leaseDurationSeconds: number;
  registrationMode: 'fail-fast' | 'background';
  instance: {
    /** The Eureka application name, uppercased — used for the path and the body's `app` field. */
    eurekaAppName: string;
    instanceId: string;
    hostName: string;
    ipAddr: string;
    port: number;
    securePort?: number;
    vipAddress: string;
    secureVipAddress: string;
    metadata: Record<string, string>;
    homePageUrl?: string;
    statusPageUrl?: string;
    healthCheckUrl?: string;
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Eureka configuration: "${field}" must be a non-empty string`,
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Eureka configuration: "${field}" must be a positive integer`,
    );
  }
  return value;
}

function requirePort(value: unknown, field: string): number {
  const port = requirePositiveInteger(value, field);
  if (port > 65535) {
    throw new Error(
      `Eureka configuration: "${field}" must be a valid port number (<= 65535)`,
    );
  }
  return port;
}

function copyMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  // A deliberate, filtered copy — never a blind `{...metadata}` spread of
  // externally-sourced data. `Object.create(null)` means an own property
  // literally named `__proto__`/`constructor` is just inert data, not a
  // prototype-chain hook.
  const result = Object.create(null) as Record<string, string>;
  if (metadata === undefined) return result;
  // `typeof null === 'object'` and `Object.entries('abc')` silently succeeds
  // (string keys become numeric-index entries) — both would otherwise be
  // accepted here and produce a nonsensical metadata object.
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      'Eureka configuration: "instance.metadata" must be a plain object',
    );
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new Error(
        `Eureka configuration: metadata value for "${key}" must be a string`,
      );
    }
    result[key] = value;
  }
  return result;
}

export function resolveOptions(
  options: EurekaClientOptions,
): ResolvedEurekaOptions {
  const { baseUrl, authorizationHeader } = parseServiceUrl(
    requireNonEmptyString(options.serviceUrl, 'serviceUrl'),
  );

  const instanceInput = options.instance;
  const app = requireNonEmptyString(instanceInput?.app, 'instance.app');
  const hostName = requireNonEmptyString(
    instanceInput?.hostName,
    'instance.hostName',
  );
  const ipAddr = requireNonEmptyString(
    instanceInput?.ipAddr,
    'instance.ipAddr',
  );
  const port = requirePort(instanceInput?.port, 'instance.port');
  const securePort =
    instanceInput?.securePort === undefined
      ? undefined
      : requirePort(instanceInput.securePort, 'instance.securePort');
  const instanceId =
    instanceInput.instanceId === undefined
      ? `${hostName}:${app}:${port}`
      : requireNonEmptyString(instanceInput.instanceId, 'instance.instanceId');

  const heartbeatIntervalSeconds = requirePositiveInteger(
    options.heartbeatIntervalSeconds ?? 30,
    'heartbeatIntervalSeconds',
  );
  const leaseDurationSeconds = requirePositiveInteger(
    options.leaseDurationSeconds ?? 90,
    'leaseDurationSeconds',
  );
  if (heartbeatIntervalSeconds >= leaseDurationSeconds) {
    throw new Error(
      'Eureka configuration: "heartbeatIntervalSeconds" must be smaller than "leaseDurationSeconds"',
    );
  }

  const registrationMode = options.registrationMode ?? 'fail-fast';
  if (registrationMode !== 'fail-fast' && registrationMode !== 'background') {
    throw new Error(
      'Eureka configuration: "registrationMode" must be "fail-fast" or "background"',
    );
  }

  return {
    baseUrl,
    authorizationHeader,
    heartbeatIntervalMs: heartbeatIntervalSeconds * 1000,
    leaseDurationSeconds,
    registrationMode,
    instance: {
      eurekaAppName: app.toUpperCase(),
      instanceId,
      hostName,
      ipAddr,
      port,
      securePort,
      vipAddress: instanceInput.vipAddress ?? app,
      secureVipAddress:
        instanceInput.secureVipAddress ?? instanceInput.vipAddress ?? app,
      metadata: copyMetadata(instanceInput.metadata),
      homePageUrl: instanceInput.homePageUrl,
      statusPageUrl: instanceInput.statusPageUrl,
      healthCheckUrl: instanceInput.healthCheckUrl,
    },
  };
}
