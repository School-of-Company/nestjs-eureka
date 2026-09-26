import type { ResolvedEurekaOptions } from './options';

/** Public. */
export type EurekaInstanceStatus =
  'UP' | 'DOWN' | 'STARTING' | 'OUT_OF_SERVICE' | 'UNKNOWN';

/** Public: an instance as reported by Eureka's discovery response. */
export interface EurekaInstance {
  instanceId: string;
  /** Eureka's own (normalized, typically uppercased) app name — not necessarily the caller's original casing. */
  app: string;
  hostName: string;
  ipAddr: string;
  status: EurekaInstanceStatus;
  port?: number;
  securePort?: number;
  vipAddress?: string;
  secureVipAddress?: string;
  metadata: Record<string, string>;
  homePageUrl?: string;
  statusPageUrl?: string;
  healthCheckUrl?: string;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set<EurekaInstanceStatus>([
  'UP',
  'DOWN',
  'STARTING',
  'OUT_OF_SERVICE',
  'UNKNOWN',
]);

// --- Internal wire (on-the-wire JSON) shapes ---------------------------------

interface WirePortField {
  $: number;
  '@enabled': boolean | 'true' | 'false';
}

interface WireInstance {
  instanceId: string;
  hostName: string;
  app: string;
  ipAddr: string;
  status: EurekaInstanceStatus;
  port: WirePortField;
  securePort: WirePortField;
  vipAddress: string;
  secureVipAddress: string;
  dataCenterInfo: { '@class': string; name: string };
  leaseInfo: { renewalIntervalInSecs: number; durationInSecs: number };
  metadata: Record<string, string>;
  lastDirtyTimestamp: number;
  homePageUrl?: string;
  statusPageUrl?: string;
  healthCheckUrl?: string;
}

export function buildRegistrationBody(resolved: ResolvedEurekaOptions): {
  instance: WireInstance;
} {
  const { instance } = resolved;
  const portField = (port: number | undefined): WirePortField => ({
    $: port ?? 0,
    '@enabled': port !== undefined,
  });

  return {
    instance: {
      instanceId: instance.instanceId,
      hostName: instance.hostName,
      app: instance.eurekaAppName,
      ipAddr: instance.ipAddr,
      status: 'UP',
      port: portField(instance.port),
      securePort: portField(instance.securePort),
      vipAddress: instance.vipAddress,
      secureVipAddress: instance.secureVipAddress,
      dataCenterInfo: {
        '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
        name: 'MyOwn',
      },
      leaseInfo: {
        renewalIntervalInSecs: resolved.heartbeatIntervalMs / 1000,
        durationInSecs: resolved.leaseDurationSeconds,
      },
      metadata: instance.metadata,
      lastDirtyTimestamp: Date.now(),
      homePageUrl: instance.homePageUrl,
      statusPageUrl: instance.statusPageUrl,
      healthCheckUrl: instance.healthCheckUrl,
    },
  };
}

// --- Discovery response parsing (strict) -------------------------------------

class EurekaParseError extends Error {
  constructor(reason: string) {
    super(`Malformed Eureka discovery response: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseEnabled(value: unknown): boolean {
  return value === true || value === 'true';
}

function parsePort(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new EurekaParseError(`"${field}" is not an object`);
  if (!parseEnabled(value['@enabled'])) return undefined;
  const raw = value.$;
  if (typeof raw !== 'number')
    throw new EurekaParseError(`"${field}.$" is not a number`);
  return raw;
}

function parseMetadata(value: unknown): Record<string, string> {
  // Always a null-prototype object, whether or not metadata was present —
  // returning a plain `{}` in the absent case would make `EurekaInstance.metadata`
  // inconsistently sometimes have Object.prototype and sometimes not.
  if (value === undefined) return Object.create(null) as Record<string, string>;
  if (!isRecord(value))
    throw new EurekaParseError('"metadata" is not an object');
  const result = Object.create(null) as Record<string, string>;
  for (const [key, val] of Object.entries(value)) {
    if (key === '@class') continue; // legacy servers emit this for an empty map
    if (typeof val !== 'string')
      throw new EurekaParseError(`metadata value for "${key}" is not a string`);
    result[key] = val;
  }
  return result;
}

function parseStatus(value: unknown): EurekaInstanceStatus {
  if (typeof value !== 'string' || !KNOWN_STATUSES.has(value)) {
    throw new EurekaParseError(`"status" is not a recognized value`);
  }
  return value as EurekaInstanceStatus;
}

function parseOneInstance(raw: unknown): EurekaInstance {
  if (!isRecord(raw))
    throw new EurekaParseError('an "instance" entry is not an object');
  const instanceId = raw.instanceId;
  const app = raw.app;
  const hostName = raw.hostName;
  const ipAddr = raw.ipAddr;
  if (typeof instanceId !== 'string' || instanceId.length === 0)
    throw new EurekaParseError('"instanceId" is missing');
  if (typeof app !== 'string' || app.length === 0)
    throw new EurekaParseError('"app" is missing');
  if (typeof hostName !== 'string')
    throw new EurekaParseError('"hostName" is missing');
  if (typeof ipAddr !== 'string')
    throw new EurekaParseError('"ipAddr" is missing');

  return {
    instanceId,
    app,
    hostName,
    ipAddr,
    status: parseStatus(raw.status),
    port: parsePort(raw.port, 'port'),
    securePort: parsePort(raw.securePort, 'securePort'),
    vipAddress: typeof raw.vipAddress === 'string' ? raw.vipAddress : undefined,
    secureVipAddress:
      typeof raw.secureVipAddress === 'string'
        ? raw.secureVipAddress
        : undefined,
    metadata: parseMetadata(raw.metadata),
    homePageUrl:
      typeof raw.homePageUrl === 'string' ? raw.homePageUrl : undefined,
    statusPageUrl:
      typeof raw.statusPageUrl === 'string' ? raw.statusPageUrl : undefined,
    healthCheckUrl:
      typeof raw.healthCheckUrl === 'string' ? raw.healthCheckUrl : undefined,
  };
}

/** Parses a `GET /apps/{APP}` 2xx response body. Strict: throws on any structural mismatch. */
export function parseApplicationResponse(body: unknown): EurekaInstance[] {
  if (!isRecord(body))
    throw new EurekaParseError('response body is not an object');
  const application = body.application;
  if (!isRecord(application))
    throw new EurekaParseError('"application" is missing');
  const rawInstances = application.instance;
  if (rawInstances === undefined) return [];
  const list = Array.isArray(rawInstances) ? rawInstances : [rawInstances];
  return list.map(parseOneInstance);
}

export { EurekaParseError };
