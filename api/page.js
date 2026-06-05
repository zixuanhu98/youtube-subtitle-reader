/**
 * 服务端渲染的字幕阅读页
 * 访问: /v/{videoId}  → (通过 vercel.json rewrite) → /api/page?videoId={videoId}
 */

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function generateColors() {
  const h1 = Math.floor(Math.random() * 360);
  const offset = 60 + Math.floor(Math.random() * 120);
  const h2 = (h1 + offset) % 360;
  const s = 80 + Math.floor(Math.random() * 20);
  const l1 = 45 + Math.floor(Math.random() * 15);
  const l2 = 45 + Math.floor(Math.random() * 15);
  return { c1: hslToHex(h1, s, l1), c2: hslToHex(h2, s - 5, l2 + 5) };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function renderHtml(videoId, title, author, segments, colors) {
  const segmentsHtml = segments.map((seg, i) => {
    const secs = seg.offset ? seg.offset / 1000 : (seg.start || 0);
    const ts = formatTime(secs);
    const text = escapeHtml(seg.text);
    return `
    <div class="seg" style="animation-delay:${i * 30}ms">
      <p class="text">${text}</p>
      <a class="ts" href="https://youtu.be/${videoId}?t=${Math.floor(secs)}" target="_blank">${ts}</a>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - 字幕阅读</title>
<meta property="og:title" content="${escapeHtml(title)} - 字幕阅读">
<meta property="og:description" content="由 ${escapeHtml(author)} 发布的视频字幕全文，${segments.length} 条字幕，约 ${segments.join(' ').length} 字">
<meta property="og:type" content="article">
<meta property="og:url" content="https://ytsubtitle.vercel.app/v/${videoId}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif;
  background:#faf8f5;color:#1a1a2e;min-height:100vh;line-height:1.7
}
.banner{
  position:relative;overflow:hidden;padding:60px 24px 40px;
  background:linear-gradient(135deg,${colors.c1},${colors.c2});
  color:#fff;text-align:center
}
.banner h1{font-size:24px;font-weight:700;max-width:680px;margin:0 auto;line-height:1.4;text-shadow:0 2px 12px rgba(0,0,0,.3)}
.banner .meta{margin-top:12px;font-size:14px;opacity:.85}
.banner .meta a{color:#fff;text-decoration:underline}
.banner .char-count{display:inline-block;margin-top:16px;padding:4px 14px;background:rgba(255,255,255,.2);border-radius:20px;font-size:12px;backdrop-filter:blur(4px)}
main{max-width:720px;margin:0 auto;padding:32px 20px 60px}
.seg{margin-bottom:24px;animation:fadeUp .4s ease both}
.seg .text{font-size:17px;line-height:1.85;letter-spacing:.01em;color:#1a1a2e}
.seg .ts{display:inline-block;margin-top:4px;font-size:12px;color:#999;text-decoration:none;transition:color .2s}
.seg .ts:hover{color:#c0392b}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.footer{text-align:center;padding:32px 20px 48px;font-size:13px;color:#aaa}
.footer a{color:#c0392b;text-decoration:none}
@media(max-width:640px){
  .banner{padding:40px 16px 28px}
  .banner h1{font-size:20px}
  .seg .text{font-size:15px}
  main{padding:24px 16px 40px}
}
</style>
</head>
<body>
<div class="banner">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <span>${escapeHtml(author)}</span>
    <span> · </span>
    <a href="https://youtu.be/${videoId}" target="_blank">在 YouTube 观看</a>
  </div>
  <div class="char-count">${segments.length} 条 · 约 ${segments.join(' ').replace(/\\s/g,'').length} 字</div>
</div>
<main>
  ${segmentsHtml}
</main>
<div class="footer">
  <a href="https://ytsubtitle.vercel.app">YouTube 字幕阅读器</a>
</div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  const videoId = req.query.videoId || req.query.v;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('无效的视频 ID');
    return;
  }

  try {
    const [transcriptRaw, oembedRaw] = await Promise.allSettled([
      httpsGet(`https://youtubetranscript.com/?v=${videoId}&format=json`),
      httpsGet(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
    ]);

    if (transcriptRaw.status !== 'fulfilled') {
      res.writeHead(502, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end('无法获取字幕，该视频可能没有可用字幕。');
      return;
    }

    const segments = JSON.parse(transcriptRaw.value);
    if (!Array.isArray(segments) || segments.length === 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end('该视频没有可用字幕。');
      return;
    }

    let title = 'YouTube 视频';
    let author = '';
    if (oembedRaw.status === 'fulfilled') {
      try {
        const meta = JSON.parse(oembedRaw.value);
        title = meta.title || title;
        author = meta.author_name || author;
      } catch (e) {}
    }

    const colors = generateColors();
    const html = renderHtml(videoId, title, author, segments, colors);

    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(html);

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('服务器错误: ' + err.message);
  }
};
