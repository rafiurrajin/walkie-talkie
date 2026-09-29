# TODO

## Requirements

* Node.js + npm must be installed.

## First-time setup

Run:

```bash
npm ci
```

Generate the HTTPS certificate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=192.168.0.50" -addext "subjectAltName=IP:192.168.0.50"
```

Replace `192.168.0.50` with the server's LAN IP.

## Every start

```bash
npm start
```
