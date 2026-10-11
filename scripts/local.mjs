// Run the dashboard locally with no AWS at all:  node scripts/local.mjs   ->  http://localhost:8080
process.env.LOCAL = '1';
process.env.OFFICER_PIN ||= '1234';
process.env.WEBHOOK_SECRET ||= 'local';
import http from 'node:http';
const { handler } = await import('../src/app.js');

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://x');
  const out = await handler({
    rawPath: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString() || undefined,
    requestContext: { http: { method: req.method } },
  });
  res.writeHead(out.statusCode, out.headers);
  res.end(out.body);
}).listen(8080, () => console.log('BurnStop local: http://localhost:8080  (PIN 1234)'));
