/**
 * 服务端渲染的字幕阅读页
 * 访问路径：/v/{videoId} → (通过 vercel.json rewrite) → /api/page?videoId={videoId}
 *
 * 字幕获取策略（多重备选）：
 * 1. youtubetranscript.com (最快，返回 JSON)
 * 2. youtube-transcript.ai (备选，返回 Markdown)
 */

// Node.js 18+ 原生 fetch 可用
const FETCH_TIMEOUT = 8000; // 8 秒超时

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {}),
      },
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 策略 1: youtubetranscript.com ───
async function fetchFromYoutubetranscript(videoId) {
  const resp = await fetchWithTimeout(
    `https://youtubetranscript.com/?v=${videoId}&format=json`
  );
  if (!resp.ok) throw new Error(`youtubetranscript.com 返回 HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('字幕数据为空');
  }
  // 统一字段格式
  return data.map(s => ({
    text: s.text || '',
    offset: typeof s.offset === 'number' ? s.offset : (s.start || 0) * 1000,
    start: typeof s.start === 'number' ? s.start : (s.offset || 0) / 1000,
  }));
}

// ─── 策略 2: youtube-transcript.ai (Markdown 格式) ───
async function fetchFromYoutubeTranscriptAI(videoId) {
  const resp = await fetchWithTimeout(
    `https://youtube-transcript.ai/transcript/${videoId}.txt`
  );
  if (!resp.ok) throw new Error(`youtube-transcript.ai 返回 HTTP ${resp.status}`);
  const text = await resp.text();

  // 解析 Markdown 格式: [0:00] We're no strangers to love...
  const segments = [];
  const lines = text.split('\n');
  let headerSkipped = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行、标题、元数据
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Source') ||
        trimmed.startsWith('Language') || trimmed.startsWith('Other') ||
        trimmed.startsWith('To request')) continue;

    // 匹配时间戳行: [0:00] 或 [0:00] text
    const match = trimmed.match(/^\[(\d+):(\d+(?::\d+)?)\]\s*(.*)$/);
    if (match) {
      const parts = match[2].split(':');
      let seconds = 0;
      if (parts.length === 2) {
        seconds = parseInt(match[1]) * 60 + parseInt(parts[0]);
      } else {
        seconds = parseInt(match[1]) * 3600 + parseInt(parts[0]) * 60 + parseInt(parts[1]);
      }
      segments.push({
        text: match[3].trim(),
        offset: seconds * 1000,
        start: seconds,
      });
    }
  }

  if (segments.length === 0) throw new Error('解析字幕失败');
  return segments;
}

// ─── 策略 3: YouTube Innertube API ───
async function fetchFromYouTubeInnertube(videoId) {
  // Step 1: 获取 caption track URL
  const playerResp = await fetchWithTimeout(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
          },
        },
        videoId: videoId,
      }),
    }
  );
  if (!playerResp.ok) throw new Error(`Innertube 返回 HTTP ${playerResp.status}`);

  const playerData = await playerResp.json();
  const captionTracks =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error('该视频没有字幕轨道');
  }

  // 优先选中文，其次英文，再第一个
  let track = captionTracks.find(t => t.languageCode?.startsWith('zh'));
  if (!track) track = captionTracks.find(t => t.languageCode === 'en');
  if (!track) track = captionTracks[0];

  // Step 2: 获取字幕内容
  const captionUrl = track.baseUrl + '&fmt=json3';
  const captionResp = await fetchWithTimeout(captionUrl);
  if (!captionResp.ok) throw new Error(`字幕轨道返回 HTTP ${captionResp.status}`);

  const captionData = await captionResp.json();
  const events = captionData.events || [];

  const segments = [];
  for (const event of events) {
    if (!event.segs || !event.segs.length) continue;
    const text = event.segs.map(s => s.utf8 || '').join('').trim();
    if (!text) continue;
    segments.push({
      text: text,
      offset: event.tStartMs || 0,
      start: (event.tStartMs || 0) / 1000,
    });
  }

  if (segments.length === 0) throw new Error('字幕内容为空');
  return segments;
}

// ─── 统一获取字幕（多重策略） ───
async function fetchTranscript(videoId) {
  const errors = [];

  // 策略 1
  try {
    return await fetchFromYoutubetranscript(videoId);
  } catch (e) {
    errors.push(`策略1(youtubetranscript): ${e.message}`);
  }

  // 策略 2
  try {
    return await fetchFromYoutubeTranscriptAI(videoId);
  } catch (e) {
    errors.push(`策略2(youtube-transcript.ai): ${e.message}`);
  }

  // 策略 3
  try {
    return await fetchFromYouTubeInnertube(videoId);
  } catch (e) {
    errors.push(`策略3(Innertube): ${e.message}`);
  }

  throw new Error('所有字幕获取策略均失败:\n' + errors.join('\n'));
}

// ─── 工具函数 ───
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

function randomColors() {
  const h1 = Math.floor(Math.random() * 360);
  const offset = 60 + Math.floor(Math.random() * 120);
  const s = 80 + Math.floor(Math.random() * 20);
  return {
    c1: hslToHex(h1, s, 45 + Math.floor(Math.random() * 15)),
    c2: hslToHex((h1 + offset) % 360, s - 5, 50 + Math.floor(Math.random() * 15)),
  };
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function renderHtml(videoId, title, author, segments, colors) {
  const segmentsHtml = segments.map((seg, i) => {
    const secs = seg.start || seg.offset / 1000 || 0;
    const text = escapeHtml(seg.text);
    const ts = fmtTime(secs);
    return `
    <div class="seg" style="animation-delay:${i * 30}ms">
      <p class="text">${text}</p>
      <a class="ts" href="https://youtu.be/${videoId}?t=${Math.floor(secs)}" target="_blank">${ts}</a>
    </div>`;
  }).join('\n');

  const fullText = segments.map(s => s.text).join(' ');
  const charCount = fullText.replace(/\s/g, '').length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - 字幕阅读</title>
<meta property="og:title" content="${escapeHtml(title)} - 字幕阅读">
<meta property="og:description" content="${escapeHtml(author)} · ${segments.length} 条字幕 · 约 ${charCount} 字">
<meta property="og:type" content="article">
<meta property="og:image" content="https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif;background:#faf8f5;color:#1a1a2e;min-height:100vh;line-height:1.7}
.banner{position:relative;overflow:hidden;padding:60px 24px 40px;background:linear-gradient(135deg,${colors.c1},${colors.c2});color:#fff;text-align:center}
.banner h1{font-size:24px;font-weight:700;max-width:680px;margin:0 auto;line-height:1.4;text-shadow:0 2px 12px rgba(0,0,0,.3)}
.banner .meta{margin-top:12px;font-size:14px;opacity:.85}
.banner .meta a{color:#fff;text-decoration:underline}
.banner .badge{display:inline-block;margin-top:16px;padding:4px 14px;background:rgba(255,255,255,.2);border-radius:20px;font-size:12px;backdrop-filter:blur(4px)}
main{max-width:720px;margin:0 auto;padding:32px 20px 60px}
.seg{margin-bottom:24px;animation:fadeUp .4s ease both}
.seg .text{font-size:17px;line-height:1.85;letter-spacing:.01em}
.seg .ts{display:inline-block;margin-top:4px;font-size:12px;color:#999;text-decoration:none;transition:color .2s}
.seg .ts:hover{color:#c0392b}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.footer{text-align:center;padding:32px 20px 48px;font-size:13px;color:#aaa}
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
  <div class="badge">${segments.length} 条 · 约 ${charCount} 字</div>
</div>
<main>${segmentsHtml}</main>
<div class="footer"><a href="/">YouTube 字幕阅读器</a></div>
</body>
</html>`;
}

// ─── 主处理函数 ───
module.exports = async (req, res) => {
  const videoId = req.query.videoId || req.query.v;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('无效的视频 ID');
    return;
  }

  let segments;
  try {
    segments = await fetchTranscript(videoId);
  } catch (err) {
    const msg = escapeHtml(err.message);
    res.writeHead(502, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>获取字幕失败</title>
<style>body{font-family:sans-serif;padding:40px 20px;max-width:600px;margin:auto;line-height:1.6}
h1{font-size:22px;color:#c0392b}pre{background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;white-space:pre-wrap;overflow-x:auto}
a{color:#c0392b}</style></head><body>
<h1>无法获取字幕</h1>
<p>尝试了 3 种方式均失败：</p>
<pre>${msg}</pre>
<p>可能原因：视频没有字幕 / YouTube 限制了云服务器访问 / 暂时性故障</p>
<p><a href="/">返回首页</a> · <a href="https://youtu.be/${videoId}" target="_blank">在 YouTube 直接观看</a></p>
</body></html>`);
    return;
  }

  // 获取视频信息
  let title = 'YouTube 视频', author = '';
  try {
    const oResp = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (oResp.ok) {
      const meta = await oResp.json();
      title = meta.title || title;
      author = meta.author_name || author;
    }
  } catch (e) { /* oembed 失败不影响主要功能 */ }

  const colors = randomColors();
  const html = renderHtml(videoId, title, author, segments, colors);

  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end(html);
};
