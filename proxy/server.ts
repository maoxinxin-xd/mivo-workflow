import { pathToFileURL } from 'node:url';
import { startLocalServer } from '../server/index';

export { startLocalServer } from '../server/index';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalServer();
}
