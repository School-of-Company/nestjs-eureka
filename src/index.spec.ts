import * as api from './index';

describe('public API surface', () => {
  // Locks the *runtime* export list only — type-only exports (EurekaModuleOptions,
  // EurekaModuleAsyncOptions, EurekaOptionsFactory, EurekaInstanceOptions,
  // EurekaInstance, EurekaInstanceStatus) are erased by TypeScript compilation
  // and simply aren't present on the compiled module object, so they can't be
  // asserted on here. They're validated instead by the packed-package consumer
  // smoke test (see the plan's Verification section).
  it('exports exactly the intended runtime values', () => {
    expect(Object.keys(api).sort()).toEqual([
      'EurekaModule',
      'EurekaRequestError',
      'EurekaService',
    ]);
  });
});
