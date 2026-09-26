export { EurekaModule } from './nest/eureka.module';
export { EurekaService } from './nest/eureka.service';
export type {
  EurekaModuleAsyncOptions,
  EurekaModuleOptions,
  EurekaOptionsFactory,
} from './nest/eureka.interfaces';
export type { EurekaInstanceOptions } from './core/options';
export type { EurekaInstance, EurekaInstanceStatus } from './core/instance';
export { EurekaRequestError } from './core/errors';
