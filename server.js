const express = require("express");
const { PuppeteerBlocker } = require("@cliqz/adblocker-puppeteer");
const fetch = require("cross-fetch");
const puppeteer = require("puppeteer");
const LRU = require("lru-cache");
const app = express();

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;

// --- Simple in-memory cache for HTML/assets ---
const htmlCache = new LRU({ max: 200, ttl: 1000 * 60 * 5 });     // 5 min
const assetCache = new LRU({ max: 500, ttl: 1000 * 60 * 10 });   // 10 min

// --- Launch a single browser instance (reused) ---
let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

// --- Utility ---
function mustBeHttpUrl(u) {
  if (!/^https?:\/\//i.test(u)) throw new Error("Invalid URL");
}

function absURL(base, maybeRel) {
  try { return new URL(maybeRel, base).toString(); } catch { return null; }
}

function proxify(u) {
  return `${ORIGIN}/asset?url=${encodeURIComponent(u)}`;
}

function proxifyHtmlAttributes(html, base) {
  // Brutal but effective; for SPA it’s augmented by the fetch/XHR shim we inject below.
  // Rewrites src/href/poster/data-src to /asset?url=ABS
  const ATTRS = ["src", "href", "poster", "data-src", "data-href"];
  return html.replace(
    new RegExp(`\\s(?:${ATTRS.join("|")})=("(.*?)"|'(.*?)'|([^\\s>]+))`, "gi"),
    (match, g1) => {
      let raw = g1.replace(/^["']|["']$/g, "");
      const abs = absURL(base, raw);
      if (!abs) return match;
      return match.replace(raw, proxify(abs));
    }
  );
}

function injectClientShim(html, base) {
  // A tiny client shim that:
  // 1) Forces fetch/XHR to go through /asset.
  // 2) Normalizes <a> clicks + history navigations to stay proxied.
  // 3) Adds <base> for relative URL resolution (just in case).
  const shim = `
<script>
(function(){
  const ORIGIN='${ORIGIN}';
  const BASE='${base.replace(/'/g,"\\'")}';
  const toAbs=(u)=>{ try { return new URL(u, BASE).toString(); } catch(e){ return u; } };
  const toAsset=(u)=> ORIGIN + '/asset?url=' + encodeURIComponent(toAbs(u));

  // Patch fetch
  const _fetch = window.fetch;
  window.fetch = function(input, init){
    if (typeof input === 'string') input = toAsset(input);
    else if (input && input.url) input = new Request(toAsset(input.url), input);
    return _fetch(input, init);
  };

  // Patch XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    try { url = toAsset(url); } catch(e){}
    return _open.apply(this, [method, url, ...Array.prototype.slice.call(arguments,2)]);
  };

  // Intercept link clicks
  document.addEventListener('click', function(e){
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    e.preventDefault();
    const abs = toAbs(href);
    if (abs.endsWith('.pdf') || abs.endsWith('.png') || abs.endsWith('.jpg') || abs.endsWith('.jpeg') || abs.endsWith('.gif'))
      window.location.href = toAsset(abs);
    else
      window.location.href = ORIGIN + '/proxy?url=' + encodeURIComponent(abs);
  }, true);

  // Normalize window.open
  const _openWin = window.open;
  window.open = function(u, t, f){
    const abs = toAbs(u);
    return _openWin(ORIGIN + '/proxy?url=' + encodeURIComponent(abs), t, f);
  };

  // Make relative URLs resolve against the true upstream
  const baseEl = document.createElement('base');
  baseEl.href = BASE;
  document.head && document.head.prepend(baseEl);
})();
</script>`;
  // Insert before </head> or at top of <body>
  if (html.includes("</head>")) return html.replace("</head>", `${shim}\n</head>`);
  if (html.includes("<body")) return html.replace(/<body[^>]*>/i, m => `${m}\n${shim}`);
  return shim + html;
}

function securityHeaders(headers = {}) {
  return {
    "Content-Type": "text/html; charset=UTF-8",
    // Allow scripts/styles inlined from our own origin only; all network goes via /asset (which we control).
    "Content-Security-Policy": [
      "default-src 'self' data: blob:;",
      "img-src * data: blob:;",
      "media-src * data: blob:;",
      "font-src * data: blob:;",
      "style-src 'self' 'unsafe-inline' *;",
      "script-src 'self' 'unsafe-inline';",
      "connect-src 'self';",
      "frame-src *;",
      "object-src 'none';",
      "base-uri 'self';",
      "form-action 'self' *;"
    ].join(" "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    ...headers
  };
}

// --- /proxy: loads a page like Brave would, blocks ads/trackers, rewrites for deep filtering ---
app.get("/proxy", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    mustBeHttpUrl(targetUrl);

    const cacheKey = `html:${targetUrl}`;
    const cached = htmlCache.get(cacheKey);
    if (cached) {
      res.set(securityHeaders({ "X-Proxy-Cache": "HIT" }));
      return res.send(cached);
    }

    const browser = await getBrowser();
    const page = await browser.newPage();

    // Setup adblocker
    const blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
    await blocker.enableBlockingInPage(page);

    // Extra: block known heavy trackers at request level (even if not on list)
    await page.setRequestInterception(true);
    page.on("request", (reqInt) => {
      const url = reqInt.url();
      // Let adblocker decide; only cancel here if super obvious:
      const hardBlock = [
        "googlesyndication.com","doubleclick.net","google-analytics.com",
        "g.doubleclick.net","facebook.net","taboola.com","outbrain.com",
        "criteo.net","criteo.com","scorecardresearch.com","quantserve.com"
      ].some(h => url.includes(h));
      if (hardBlock) return reqInt.abort();
      return reqInt.continue();
    });

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Get HTML after network settles (already filtered)
    let html = await page.content();

    // Rewrite attributes so subresources go via /asset
    html = proxifyHtmlAttributes(html, targetUrl);

    // Inject client shim for SPA/XHR/navigation continuity
    html = injectClientShim(html, targetUrl);

    await page.close();

    htmlCache.set(cacheKey, html);
    res.set(securityHeaders({ "X-Proxy-Cache": "MISS" }));
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(400).send("Bad request or upstream failure.");
  }
});

// --- /asset: fetches any subresource through the same ad-blocking stack ---
app.get("/asset", async (req, res) => {
  try {
    const url = req.query.url;
    mustBeHttpUrl(url);

    // If it’s HTML, bounce to /proxy to ensure rewriting
    if (/\.(html?|php|asp[x]?|aspx|jsp|do)(\?|$)/i.test(url)) {
      return res.redirect(302, `/proxy?url=${encodeURIComponent(url)}`);
    }

    const cacheKey = `asset:${url}`;
    const cached = assetCache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Proxy-Cache", "HIT");
      res.setHeader("Content-Type", cached.type || "application/octet-stream");
      return res.end(cached.body);
    }

    // Use a lightweight page for request-level blocking (faster than full render)
    const browser = await getBrowser();
    const page = await browser.newPage();

    const blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
    await blocker.enableBlockingInPage(page);

    await page.setRequestInterception(true);

    // Intercept single request; fetch with Puppeteer so blocker can act
    const resp = await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
    if (!resp) {
      await page.close();
      return res.status(502).send("Upstream asset error");
    }

    const buf = await resp.buffer();
    const ct = resp.headers()["content-type"] || "application/octet-stream";

    await page.close();

    assetCache.set(cacheKey, { body: buf, type: ct });

    // Pass-through with tight CORS so the iframe can load it
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.status(400).send("Asset fetch failed.");
  }
});

app.get("/", (_, res) => res.type("text/plain").send("Shields-Up proxy is running. Use /proxy?url=https://..."));

app.listen(PORT, () => console.log(`Shields-Up proxy at ${ORIGIN}`));
