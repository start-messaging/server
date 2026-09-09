/**
 * The in-process suite: boots the real AppModule with Nest's testing harness and
 * drives it through supertest, rather than over a socket.
 *
 * This is deliberately a `.js` config and not the `.json` Nest scaffolds,
 * because `forceExit` below needs the explanation that JSON cannot carry.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.e2e-spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // Source imports carry a `.js` extension because the runtime build is
  // NodeNext; ts-jest resolves the `.ts` behind it.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFiles: ['<rootDir>/setup-env.ts'],

  // Booting AppModule starts things that outlive the assertions: BullMQ workers
  // hold Redis sockets, the OpenTelemetry SDK holds an exporter timer, and the
  // throttler holds its own Redis connection. `app.close()` does not reap all of
  // them, so without this the run passes in about four seconds and then hangs
  // forever on an idle event loop — which in CI reads as a stuck job, not as a
  // pass. Do not remove this without first fixing the shutdown hooks.
  forceExit: true,
};
