import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EurekaModule } from './eureka.module';
import type {
  EurekaModuleOptions,
  EurekaOptionsFactory,
} from './eureka.interfaces';
import { EurekaService } from './eureka.service';

function validOptions(): EurekaModuleOptions {
  return {
    serviceUrl: 'http://localhost:8761/eureka',
    instance: {
      app: 'my-app',
      hostName: 'host-1',
      ipAddr: '10.0.0.1',
      port: 3000,
    },
  };
}

describe('EurekaModule.forRoot', () => {
  it('provides and exports EurekaService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EurekaModule.forRoot(validOptions())],
    }).compile();
    expect(moduleRef.get(EurekaService)).toBeInstanceOf(EurekaService);
  });

  it('rejects during compile() when options are invalid, before any network call', async () => {
    const invalid = validOptions();
    invalid.instance.port = -1;
    await expect(
      Test.createTestingModule({
        imports: [EurekaModule.forRoot(invalid)],
      }).compile(),
    ).rejects.toThrow(/instance.port/);
  });
});

describe('EurekaModule.forRootAsync', () => {
  it('supports useFactory + inject + imports', async () => {
    const CONFIG = Symbol('CONFIG');
    @Module({
      providers: [{ provide: CONFIG, useValue: validOptions() }],
      exports: [CONFIG],
    })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        EurekaModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: (config: EurekaModuleOptions) => config,
        }),
      ],
    }).compile();

    expect(moduleRef.get(EurekaService)).toBeInstanceOf(EurekaService);
  });

  it('supports useClass', async () => {
    @Injectable()
    class OptionsFactory implements EurekaOptionsFactory {
      createEurekaOptions(): EurekaModuleOptions {
        return validOptions();
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [EurekaModule.forRootAsync({ useClass: OptionsFactory })],
    }).compile();

    expect(moduleRef.get(EurekaService)).toBeInstanceOf(EurekaService);
  });

  it('supports useExisting', async () => {
    @Injectable()
    class OptionsFactory implements EurekaOptionsFactory {
      createEurekaOptions(): EurekaModuleOptions {
        return validOptions();
      }
    }
    @Module({ providers: [OptionsFactory], exports: [OptionsFactory] })
    class SharedModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        EurekaModule.forRootAsync({
          imports: [SharedModule],
          useExisting: OptionsFactory,
        }),
      ],
    }).compile();

    expect(moduleRef.get(EurekaService)).toBeInstanceOf(EurekaService);
  });

  it('throws a clear error when no strategy is given', () => {
    expect(() => EurekaModule.forRootAsync({})).toThrow(/requires one of/);
  });
});
