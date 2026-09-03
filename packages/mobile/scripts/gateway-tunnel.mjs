// Exposes the local gateway through ngrok for dev.sh tunnel mode. Uses the @ngrok/ngrok SDK
// (the agent bundled with @expo/ngrok is v2, which free accounts can no longer use) and the
// authtoken from the developer's ngrok config. Writes the public URL to the file given as the
// first argument, then stays alive until killed.
import ngrok from '@ngrok/ngrok';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [urlFile, port = '8080'] = process.argv.slice(2);
if (!urlFile) {
  console.error('usage: gateway-tunnel.mjs <url-file> [port]');
  process.exit(2);
}

const configPath = `${homedir()}/Library/Application Support/ngrok/ngrok.yml`;
function authtoken() {
  if (process.env.NGROK_AUTHTOKEN) return process.env.NGROK_AUTHTOKEN;
  try {
    return readFileSync(configPath, 'utf8').match(/^authtoken:\s*"?([^"\s]+)/m)?.[1];
  } catch {
    return undefined;
  }
}

const token = authtoken();
if (!token) {
  console.error(`no ngrok authtoken: set NGROK_AUTHTOKEN or add authtoken: to ${configPath}`);
  process.exit(1);
}

let listener;
try {
  listener = await ngrok.forward({ addr: Number(port), authtoken: token });
} catch (e) {
  console.error(`ngrok failed to start: ${e.message ?? e}`);
  process.exit(1);
}
writeFileSync(urlFile, listener.url());
console.log(`gateway: ${listener.url()} -> http://localhost:${port}`);

const stop = async () => { await listener.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
