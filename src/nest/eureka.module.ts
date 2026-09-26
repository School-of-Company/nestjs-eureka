import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  EUREKA_MODULE_OPTIONS,
  EUREKA_OPTIONS_FACTORY,
} from './eureka.constants';
import type {
  EurekaModuleAsyncOptions,
  EurekaModuleOptions,
  EurekaOptionsFactory,
} from './eureka.interfaces';
import { EurekaService } from './eureka.service';

/**
 * A normal (non-global) DynamicModule — `global: true` is intentionally not
 * used. That's about provider visibility, not singleton/duplicate-
 * registration enforcement, and Nest doesn't reliably prevent a second
 * `forRoot()` call just because a module is global.
 *
 * Call `EurekaModule.forRoot()`/`forRootAsync()` once, in your root/
 * application module, and import that module (or re-export `EurekaService`)
 * wherever else you need it.
 */
@Module({})
export class EurekaModule {
  static forRoot(options: EurekaModuleOptions): DynamicModule {
    return {
      module: EurekaModule,
      providers: [
        { provide: EUREKA_MODULE_OPTIONS, useValue: options },
        EurekaService,
      ],
      exports: [EurekaService],
    };
  }

  static forRootAsync(options: EurekaModuleAsyncOptions): DynamicModule {
    return {
      module: EurekaModule,
      imports: options.imports ?? [],
      providers: [...EurekaModule.createAsyncProviders(options), EurekaService],
      exports: [EurekaService],
    };
  }

  private static createAsyncProviders(
    options: EurekaModuleAsyncOptions,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: EUREKA_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    if (options.useClass) {
      return [
        { provide: EUREKA_OPTIONS_FACTORY, useClass: options.useClass },
        {
          provide: EUREKA_MODULE_OPTIONS,
          useFactory: (factory: EurekaOptionsFactory) =>
            factory.createEurekaOptions(),
          inject: [EUREKA_OPTIONS_FACTORY],
        },
      ];
    }
    if (options.useExisting) {
      return [
        {
          provide: EUREKA_MODULE_OPTIONS,
          useFactory: (factory: EurekaOptionsFactory) =>
            factory.createEurekaOptions(),
          inject: [options.useExisting],
        },
      ];
    }
    throw new Error(
      'EurekaModule.forRootAsync() requires one of useFactory, useClass, or useExisting.',
    );
  }
}
