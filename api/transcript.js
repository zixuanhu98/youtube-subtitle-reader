/**
 * 字幕 JSON API
 * GET /api/transcript?v={videoId}
 */

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(data);
      });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  const videoId = req.query.v || req.query.videoId;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无效的视频 ID' }));
    return;
  }

  try {
    const [transcriptRaw, oembedRaw] = await Promise.allSettled([
      httpsGet(`https://youtubetranscript.com/?v=${videoId}&format=json`),
      httpsGet(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
    ]);

    if (transcriptRaw.status !== 'fulfilled') {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无法获取字幕' }));
      return;
    }

    const segments = JSON.parse(transcriptRaw.value);
    if (!Array.isArray(segments)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '没有可用字幕' }));
      return;
    }

    let title = 'YouTube Video', author = '';
    if (oembedRaw.status === 'fulfilled') {
      try {
        const meta = JSON.parse(oembedRaw.value);
        title = meta.title || title;
        author = meta.author_name || author;
      } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ videoId, title, author, segments }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
