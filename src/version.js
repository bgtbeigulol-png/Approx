import { createRequire } from 'node:module';

const packageMetadata = createRequire(import.meta.url)('../package.json');

/** Version of the Approx package hosting this source tree, never the Pi runtime. */
export const APPROX_VERSION = String(packageMetadata?.version || '0.0.0');
