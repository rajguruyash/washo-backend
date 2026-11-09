/**
 * The file Render starts: `npx ts-node backend/src/server.ts`. ts-node compiles the WHOLE backend before it listens, which takes 80 seconds or more on the free plan, and the free plan puts an
 * idle instance to sleep, so every first visit after a quiet spell waited that long (Cloudflare gave up first: error 522, "the site is not loading"). So in production this file hands over to
 * the compiled copy that `npm run build` makes (backend/dist), and ts-node only has to compile these few lines. Development and tests run the TypeScript (main.ts) exactly as before, and a
 * production start without a build falls back to it too. The real start-up code is in main.ts.
 */
import fs from 'fs';
import path from 'path';

const compiled = path.join(__dirname, '..', 'dist', 'main.js');
const alreadyCompiled = path.basename(__dirname) === 'dist'; // `node backend/dist/server.js` is this same file, already compiled

if (process.env.NODE_ENV === 'production' && !alreadyCompiled && fs.existsSync(compiled)) require(compiled);
else require('./main');
