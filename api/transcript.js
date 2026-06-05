/**
 * 字幕 JSON API
 * GET /api/transcript?v={videoId}
 * 返回 { videoId, title, author, segments }
 */

const FETCH_TIMEOUT = 8000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── 策略 1: youtubetranscript.com ───
async function fetchFromYoutubetranscript(videoId) {
  const resp = await fetchWithTimeout(`https://youtubetranscript.com/?v=${videoId}&format=json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('空数据');
  return data.map(s => ({ text: s.text || '', offset: typeof s.offset === 'number' ? s.offset : (s.start||0)*1000 }));
}

// ─── 策略 2: youtube-transcript.ai ───
async function fetchFromYoutubeTranscriptAI(videoId) {
  const resp = await fetchWithTimeout(`https://youtube-transcript.ai/transcript/${videoId}.txt`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const segments = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('Source') || t.startsWith('Language') || t.startsWith('Other')) continue;
    const m = t.match(/^\[(\d+):(\d+(?::\d+)?)\]\s*(.*)$/);
    if (m) {
      const parts = m[2].split(':');
      const secs = parts.length === 2 ? parseInt(m[1])*60 + parseInt(parts[0]) : parseInt(m[1])*3600 + parseInt(parts[0])*60 + parseInt(parts[1]);
      segments.push({ text: m[3].trim(), offset: secs * 1000 });
    }
  }
  if (!segments.length) throw new Error('解析失败');
  return segments;
}

// ─── 策略 3: YouTube Innertube ───
async function fetchFromYouTubeInnertube(videoId) {
  const pr = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } }, videoId }),
  });
  if (!pr.ok) throw new Error(`HTTP ${pr.status}`);
  const pd = await pr.json();
  const tracks = pd?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) throw new Error('无字幕轨道');
  let track = tracks.find(t => t.languageCode?.startsWith('zh')) || tracks.find(t => t.languageCode === 'en') || tracks[0];
  const cr = await fetchWithTimeout(track.baseUrl + '&fmt=json3');
  if (!cr.ok) throw new Error(`字幕 HTTP ${cr.status}`);
  const cd = await cr.json();
  const segs = [];
  for (const e of (cd.events || [])) {
    if (!e.segs) continue;
    const t = e.segs.map(s => s.utf8 || '').join('').trim();
    if (t) segs.push({ text: t, offset: e.tStartMs || 0 });
  }
  if (!segs.length) throw new Error('字幕内容为空');
  return segs;
}

async function fetchTranscript(videoId) {
  const errors = [];
  for (const fn of [fetchFromYoutubetranscript, fetchFromYoutubeTranscriptAI, fetchFromYouTubeInnertube]) {
    try { return await fn(videoId); } catch (e) { errors.push(e.message); }
  }
  throw new Error('所有方式均失败: ' + errors.join(' | '));
}

module.exports = async (req, res) => {
  const videoId = req.query.v || req.query.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: '无效的视频 ID' }));
    return;
  }

  try {
    const [segments, oembedResp] = await Promise.allSettled([
      fetchTranscript(videoId),
      fetchWithTimeout(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`),
    ]);

    if (segments.status !== 'fulfilled') {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: segments.reason.message }));
      return;
    }

    let title = 'YouTube Video', author = '';
    if (oembedResp.status === 'fulfilled') {
      try { const m = await oembedResp.value.json(); title = m.title || title; author = m.author_name || author; } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ videoId, title, author, segments: segments.value }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
