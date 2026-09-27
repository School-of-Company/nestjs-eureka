import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EurekaClient } from '../core/eureka-client';
import { EurekaRegistration } from '../core/eureka-registration';
import type { EurekaInstance } from '../core/instance';
import { resolveOptions } from '../core/options';
import { EUREKA_MODULE_OPTIONS } from './eureka.constants';
import type { EurekaModuleOptions } from './eureka.interfaces';

/**
 * Thin bridge between NestJS lifecycle hooks and the framework-agnostic
 * `EurekaRegistration`/`EurekaClient` — it holds no lifecycle logic of its
 * own; see `core/eureka-registration.ts` for the actual state machine.
 */
@Injectable()
export class EurekaService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly client: EurekaClient;
  private readonly registration: EurekaRegistration;

  constructor(@Inject(EUREKA_MODULE_OPTIONS) options: EurekaModuleOptions) {
    const resolved = resolveOptions(options);
    this.client = new EurekaClient(resolved);
    this.registration = new EurekaRegistration(
      this.client,
      resolved.heartbeatIntervalMs,
      new Logger(EurekaService.name),
      resolved.registrationMode,
    );
  }

  /** Registers with Eureka. In fail-fast mode (the default), rejects (failing app boot) if the initial registration fails — see the README. */
  async onApplicationBootstrap(): Promise<void> {
    await this.registration.start();
  }

  /** Deregisters from Eureka. Never rejects; safe to run more than once. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.registration.stop();
  }

  /** Every instance Eureka currently reports for `appName`, unfiltered by status. */
  getInstances(appName: string): Promise<EurekaInstance[]> {
    return this.client.getInstances(appName);
  }
}
