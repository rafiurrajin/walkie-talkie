// LAN Walkie-Talkie server.
// Setup:  npm install
//         openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=walkie"
//         npm start   ->  open https://<server-lan-ip>:3000 on each device (accept the cert warning once)
// Without key.pem/cert.pem it falls back to plain HTTP (mic only works on localhost then).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const MAX_CLIENTS = 30;
const dir = path.dirname(fileURLToPath(import.meta.url));

const FILES = {
  '/': ['index.html', 'text/html'],
  '/client.js': ['client.js', 'text/javascript'],
  '/worklet.js': ['worklet.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};

function handler(req, res) {
  const f = FILES[req.url.split('?')[0]];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': f[1] + '; charset=utf-8' });
  fs.createReadStream(path.join(dir, 'public', f[0])).pipe(res);
}

const hasCert = fs.existsSync(path.join(dir, 'key.pem')) && fs.existsSync(path.join(dir, 'cert.pem'));
const server = hasCert
  ? https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, handler)
  : http.createServer(handler);
if (!hasCert) console.warn('WARNING: no key.pem/cert.pem, using plain HTTP (mic works only on localhost).');

const wss = new WebSocketServer({ server });

// State: the only truth.
const clients = new Set(); // joined sockets; each has ws.name
let owner = null;          // socket or null

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastState() {
  for (const c of clients) {
    send(c, { type: 'LINE_STATE', state: owner ? 'BUSY' : 'IDLE', ownerName: owner ? owner.name : null, isYou: c === owner });
  }
}

function release(ws) {
  if (owner === ws) { owner = null; broadcastState(); }
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data, isBinary) => {
    // Audio: relay only if sender owns the line.
    if (isBinary) {
      if (ws !== owner) return;
      for (const c of clients) if (c !== ws && c.readyState === c.OPEN) c.send(data, { binary: true });
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'JOIN') {
      if (clients.has(ws)) return;
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 32) : '';
      if (!name) return send(ws, { type: 'ERROR', message: 'Invalid name' });
      if (clients.size >= MAX_CLIENTS) { send(ws, { type: 'ERROR', message: 'Server full' }); return ws.close(); }
      ws.name = name;
      clients.add(ws);
      send(ws, { type: 'LINE_STATE', state: owner ? 'BUSY' : 'IDLE', ownerName: owner ? owner.name : null, isYou: false });
      return;
    }

    if (!clients.has(ws)) return; // must JOIN first

    if (msg.type === 'REQUEST_LINE') {
      if (owner === ws) return; // ignore repeats
      if (owner) return send(ws, { type: 'REJECTED', reason: 'Line busy' });
      owner = ws;
      broadcastState(); // state first, then GRANTED
      send(ws, { type: 'GRANTED' });
    } else if (msg.type === 'STOP') {
      release(ws);
    }
  });

  ws.on('close', () => { clients.delete(ws); release(ws); });
  ws.on('error', () => {});
});

// Detect dead connections (e.g. phone dropped off Wi-Fi) so they can't hold the line.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 10000);

server.listen(PORT, () => console.log(`Listening on ${hasCert ? 'https' : 'http'}://0.0.0.0:${PORT}`));
