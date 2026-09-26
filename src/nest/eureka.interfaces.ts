import type { FactoryProvider, ModuleMetadata, Type } from '@nestjs/common';
import type { EurekaClientOptions } from '../core/options';

/**
 * Public: the only configuration type this library exposes. It's an alias
 * for the core client's input shape — there is deliberately one public
 * configuration concept, not a separate "Nest module options" vs. "core
 * client options" pair.
 */
export type EurekaModuleOptions = EurekaClientOptions;

/** Public. */
export interface EurekaOptionsFactory {
  createEurekaOptions(): EurekaModuleOptions | Promise<EurekaModuleOptions>;
}

/** Public. */
export interface EurekaModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory?: FactoryProvider<EurekaModuleOptions>['useFactory'];
  useClass?: Type<EurekaOptionsFactory>;
  useExisting?: Type<EurekaOptionsFactory>;
}
