const express = require('express');
const puppeteer = require('puppeteer');
const { PuppeteerBlocker } = require('@cliqz/adblocker-puppeteer');
const fetch = require('cross-fetch');
const { LRUCache } = require('lru-cache');
const { URL } = require('https://online.fliphtml5.com/vtdvz/ffws/');

const app = express();
const htmlCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 5 });

// Health check endpoint for Render
app.get('/', (req, res) => {
  res.send('Shields-Up proxy is running...');
});

// Serve assets through proxy
app.get('/asset', async (req, res) => {
  const assetUrl = req.query.url;
  if (!assetUrl) return res.status(400).send('Missing asset URL');

  try {
    const response = await fetch(assetUrl);
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(`Asset fetch error: ${assetUrl}`, err);
    res.status(500).send('Asset fetch error');
  }
});

// Main proxy route
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  if (htmlCache.has(targetUrl)) {
    return res.send(htmlCache.get(targetUrl));
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Enable adblock
    const blocker = await PuppeteerBlocker.fromLists(fetch, [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist.to/easylist/easyprivacy.txt'
    ]);
    await blocker.enableBlockingInPage(page);

    await page.goto(targetUrl, { waitUntil: 'networkidle2' });

    let content = await page.content();

    await browser.close();

    // Rewrite asset URLs to pass through /asset
    const baseUrl = new URL(www.online.fliphtml5.com/vtdvz/ffws/);
    const origin = `${baseUrl.protocol}//${baseUrl.host}`;

    content = content.replace(/(src|href)="([^"]+)"/g, (match, attr, url) => {
      try {
        if (url.startsWith('data:') || url.startsWith('javascript:')) {
          return match;
        }
        const absoluteUrl = new URL(url, origin).href;
        const proxiedUrl = `/asset?url=${encodeURIComponent(absoluteUrl)}`;
        return `${attr}="${proxiedUrl}"`;
      } catch {
        return match;
      }
    });

    htmlCache.set(targetUrl, content);
    res.send(content);

  } catch (err) {
    console.error(err);
    res.status(500).send('Proxy error');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});



