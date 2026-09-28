import { parseServiceUrl, type ParsedServiceUrl } from './service-url';

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
  /**
   * One Eureka server URL, or several for failover. On a network
   * error/timeout or a 5xx response, the next URL is tried; a 4xx (a real
   * answer from a reachable node, not a broken one) is not retried. The
   * server that last completed a call successfully (not merely "answered")
   * is preferred on the next call — a terminal 4xx doesn't change this.
   */
  serviceUrl: string | string[];
  instance: EurekaInstanceOptions;
  /** Default 30. Must be smaller than `leaseDurationSeconds`, and at most
   *  2_147_483 (any larger would overflow Node's 32-bit timer delay once
   *  converted to milliseconds). */
  heartbeatIntervalSeconds?: number;
  /** Default 90. At most 2_147_483_647 (the 32-bit signed integer max). */
  leaseDurationSeconds?: number;
  /**
   * Default `'fail-fast'`: a failed initial registration rejects application
   * bootstrap. `'background'`: the failure is logged, bootstrap continues,
   * and registration is retried on the heartbeat schedule until it succeeds.
   */
  registrationMode?: 'fail-fast' | 'background';
  /** Default 5000. Timeout for each individual Eureka HTTP request, in
   *  milliseconds. At most 2_147_483_647 (Node's 32-bit timer delay limit;
   *  `AbortSignal.timeout` throws above this). */
  requestTimeoutMs?: number;
}

/**
 * Normalized, validated configuration. Internal only — never exported from
 * `index.ts`, and `authorizationHeader` in particular must never be
 * reachable from a public type or getter.
 */
export interface ResolvedEurekaOptions {
  /** Always at least one entry. */
  serviceUrls: ParsedServiceUrl[];
  heartbeatIntervalMs: number;
  leaseDurationSeconds: number;
  registrationMode: 'fail-fast' | 'background';
  requestTimeoutMs: number;
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

/**
 * For the instance identity fields (`app`, `hostName`, `ipAddr`, an explicit
 * `instanceId`): a whitespace-only value would otherwise pass as "non-empty"
 * and end up in the registration body and the Eureka URL path. Rejected, not
 * trimmed — a value that passes is returned exactly as given. `serviceUrl`
 * deliberately doesn't go through this; `parseServiceUrl()` owns URL
 * validation. (#13)
 */
function requireNonBlankString(value: unknown, field: string): string {
  const str = requireNonEmptyString(value, field);
  if (str.trim().length === 0) {
    throw new Error(
      `Eureka configuration: "${field}" must not be whitespace-only`,
    );
  }
  return str;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Eureka configuration: "${field}" must be a positive integer`,
    );
  }
  return value;
}

/**
 * Node's `setTimeout`/`setInterval`/`AbortSignal.timeout` delay is a 32-bit
 * signed integer of milliseconds. Above this, `setTimeout` silently clamps
 * the delay to ~1ms (a `heartbeatIntervalSeconds` this large would turn the
 * heartbeat loop into a hot loop, not throw), and `AbortSignal.timeout`
 * throws a `RangeError` from inside `rawFetch()` — a confusing, generic
 * transport failure that gives no hint the configured value itself is the
 * problem. Reject at configuration time instead. (#19)
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647; // 2^31 - 1

function requireAtMost(value: number, field: string, max: number): number {
  if (value > max) {
    throw new Error(
      `Eureka configuration: "${field}" must not exceed ${max} (Node's 32-bit timer-delay limit)`,
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

function resolveServiceUrls(
  serviceUrl: EurekaClientOptions['serviceUrl'],
): ParsedServiceUrl[] {
  const inputs = Array.isArray(serviceUrl) ? serviceUrl : [serviceUrl];
  if (inputs.length === 0) {
    throw new Error(
      'Eureka configuration: "serviceUrl" must be a non-empty string or a non-empty array of strings',
    );
  }
  return inputs.map((input, i) =>
    parseServiceUrl(
      requireNonEmptyString(
        input,
        Array.isArray(serviceUrl) ? `serviceUrl[${i}]` : 'serviceUrl',
      ),
    ),
  );
}

export function resolveOptions(
  options: EurekaClientOptions,
): ResolvedEurekaOptions {
  const serviceUrls = resolveServiceUrls(options.serviceUrl);

  const instanceInput = options.instance;
  const app = requireNonBlankString(instanceInput?.app, 'instance.app');
  const hostName = requireNonBlankString(
    instanceInput?.hostName,
    'instance.hostName',
  );
  const ipAddr = requireNonBlankString(
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
      : requireNonBlankString(instanceInput.instanceId, 'instance.instanceId');

  const heartbeatIntervalSeconds = requireAtMost(
    requirePositiveInteger(
      options.heartbeatIntervalSeconds ?? 30,
      'heartbeatIntervalSeconds',
    ),
    'heartbeatIntervalSeconds',
    // Converted to ms before use as a timer delay — bound the seconds value
    // so that conversion can't overflow.
    Math.floor(MAX_TIMER_DELAY_MS / 1000),
  );
  const leaseDurationSeconds = requireAtMost(
    requirePositiveInteger(
      options.leaseDurationSeconds ?? 90,
      'leaseDurationSeconds',
    ),
    'leaseDurationSeconds',
    MAX_TIMER_DELAY_MS,
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
    serviceUrls,
    heartbeatIntervalMs: heartbeatIntervalSeconds * 1000,
    leaseDurationSeconds,
    registrationMode,
    requestTimeoutMs: requireAtMost(
      requirePositiveInteger(
        options.requestTimeoutMs ?? 5_000,
        'requestTimeoutMs',
      ),
      'requestTimeoutMs',
      MAX_TIMER_DELAY_MS,
    ),
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
