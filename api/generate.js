// api/generate.js — Serverless (Node) v1.4.1
// - Accepteert base64 'base' of multipart 'image'
// - size: 'auto' | '1024x1024' | '1024x1536' | '1536x1024' (512 is niet toegestaan door OpenAI)
// - Standaard gebruiken we 'auto' voor snelheid
import Busboy from 'busboy';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const OPENAI_API = 'https://api.openai.com/v1/images/edits';
const MODEL = 'gpt-image-1';

function sendJson(res, status, data) {
  res.status(status).setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    let fileImage = null;

    bb.on('file', (name, file, info) => {
      const chunks = [];
      const { filename, mimeType } = info || {};
      file.on('data', d => chunks.push(d));
      file.on('end', () => {
        fileImage = { buffer: Buffer.concat(chunks), filename: filename || 'input.jpg', mimeType: mimeType || 'image/jpeg' };
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('error', reject);
    bb.on('close', () => resolve({ fields, fileImage }));

    req.pipe(bb);
  });
}

function dataURLToBuffer(dataUrl) {
  const m = /^data:(.+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, 'base64');
  return { buffer: buf, mimeType: mime, filename: 'base.jpg' };
}

function normalizeSize(val){
  const v = String(val || '').trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === '1024x1024') return '1024x1024';
  if (v === '1024x1536') return '1024x1536';
  if (v === '1536x1024') return '1536x1024';
  return 'auto';
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const key = process.env.OPENAI_API_KEY;
    if (!key) return sendJson(res, 500, { error: 'Missing OPENAI_API_KEY env var' });

    const { fields, fileImage } = await parseMultipart(req);
    const prompt = String(fields.prompt || '').trim();
    if (!prompt) return sendJson(res, 400, { error: 'Missing prompt' });

    const size = normalizeSize(fields.size);

    let image = fileImage;
    if (!image && fields.base) {
      const parsed = dataURLToBuffer(String(fields.base));
      if (parsed) image = { buffer: parsed.buffer, filename: 'base.jpg', mimeType: parsed.mimeType || 'image/jpeg' };
    }
    if (!image) return sendJson(res, 400, { error: 'No image (file or base) provided' });

    const body = new FormData();
    body.append('model', MODEL);
    body.append('prompt', prompt);
    body.append('size', size);
    body.append('image', new Blob([image.buffer], { type: image.mimeType }), image.filename);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort('Client timeout'), 58_000);

    const upstream = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal: controller.signal
    }).catch(e => { throw new Error('Upstream fetch failed: ' + (e?.message || String(e))); });

    clearTimeout(t);

    if (!upstream.ok) {
      const text = await upstream.text();
      return sendJson(res, 500, { error: `OpenAI request failed: ${text}` });
    }

    const data = await upstream.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return sendJson(res, 500, { error: 'No image in response' });

    return sendJson(res, 200, { dataUrl: `data:image/png;base64,${b64}` });
  } catch (e) {
    return sendJson(res, 500, { error: e?.message || 'Unknown error' });
  }
}
