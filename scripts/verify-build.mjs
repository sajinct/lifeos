import { readFileSync } from 'node:fs';
const root = 'dist/lifeos/browser';
const index = readFileSync(`${root}/index.html`, 'utf8');
const config = JSON.parse(readFileSync(`${root}/ngsw.json`, 'utf8'));
if (!index.includes('<base href=')) throw new Error('Missing Angular base href');
if (process.env.CUSTOM_DOMAIN) {
  if (!index.includes('<base href="/">'))
    throw new Error('Custom domains must serve the application from /');
  if (readFileSync(`${root}/CNAME`, 'utf8').trim() !== process.env.CUSTOM_DOMAIN)
    throw new Error('CNAME must match the configured custom domain');
}
if (config.dataGroups?.length)
  throw new Error('Private API data must never be service-worker cached');
if (config.assetGroups.some((g) => g.urls.some((url) => /supabase|receipts|documents/.test(url))))
  throw new Error('Private objects in cache manifest');
const manifest = JSON.parse(readFileSync(`${root}/manifest.webmanifest`, 'utf8'));
if (manifest.start_url !== './' || manifest.scope !== './')
  throw new Error('PWA paths must work under a project base path');
console.log('Static build and PWA cache boundaries verified.');
