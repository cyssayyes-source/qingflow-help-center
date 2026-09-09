import {existsSync} from 'node:fs';
import path from 'node:path';
import {loadEnvFile} from 'node:process';

/**
 * Load optional local environment files without overriding variables supplied
 * by the shell, CI, or the hosting platform.
 */
export function loadLocalEnvironment(cwd = process.cwd()) {
  // Load the more specific file first because Node never overwrites an
  // already-defined variable when loading an env file.
  for (const fileName of ['.env.local', '.env']) {
    const filePath = path.join(cwd, fileName);
    if (existsSync(filePath)) loadEnvFile(filePath);
  }
}
