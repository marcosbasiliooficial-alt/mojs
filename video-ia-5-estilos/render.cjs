// Renderiza index.html quadro a quadro e gera o MP4 com trilha + narração.
// Uso: node render.cjs            -> video.mp4
//      node render.cjs --stills   -> PNGs de conferência em ./stills
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const FPS = 30;
const HOOK = 5, SEG = 7.5, CLOSE = 7;
const DURATION = HOOK + 5 * SEG + CLOSE;
const dir = __dirname;
const stills = process.argv.includes('--stills');
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.otf': 'font/otf', '.ttf': 'font/ttf' };

// narração: cada fala entra logo após o corte da sua seção (acelerada 1.15x)
const VOICE_TEMPO = 1.15;
const VOICE = [0.1, ...[0, 1, 2, 3, 4].map(i => HOOK + i * SEG + 0.15), HOOK + 5 * SEG + 0.1];

(async () => {
  // quadros da cena filmada (estilo 5)
  const cineDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cine-'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(dir, 'assets', 'cine_retime.mp4'), '-q:v', '2', path.join(cineDir, 'f%04d.jpg')]);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('#')[0].split('?')[0]);
    const root = url.startsWith('/cine/') ? cineDir : dir;
    const f = path.join(root, url.replace(/^\/cine\//, '/'));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }).listen(0);
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  page.on('pageerror', e => console.error('PAGE ERROR', e));
  await page.goto(`http://127.0.0.1:${port}/index.html#render`);
  await page.evaluate(() => window.ready);
  const grab = t => page.evaluate(async t => { await window.renderFrame(t); return document.getElementById('c').toDataURL('image/jpeg', 0.95).split(',')[1]; }, t);

  if (stills) {
    fs.mkdirSync(path.join(dir, 'stills'), { recursive: true });
    const ts = (process.env.TS || "0.5,2,4,6.5,10,14,17.5,21,25,30,33,37,41.5,44,48").split(",").map(Number);
    for (const t of ts) fs.writeFileSync(path.join(dir, 'stills', `t${String(t.toFixed(1)).padStart(4, '0')}.jpg`), Buffer.from(await grab(t), 'base64'));
    await browser.close(); server.close(); fs.rmSync(cineDir, { recursive: true, force: true }); return;
  }

  const silent = path.join(dir, 'video_sem_audio.mp4');
  const frames = fs.mkdtempSync(path.join(require('os').tmpdir(), 'frames-'));
  const total = Math.round(FPS * DURATION);
  for (let f = 0; f < total; f++) {
    fs.writeFileSync(path.join(frames, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(await grab(f / FPS), 'base64'));
    if (f % 150 === 0) console.log(`frame ${f}/${total}`);
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', silent]);
  fs.rmSync(frames, { recursive: true, force: true });
  await browser.close(); server.close(); fs.rmSync(cineDir, { recursive: true, force: true });

  // trilha: kick 120 BPM + hi-hat no contratempo + baixo + impacto em cada troca de estilo
  const music = path.join(dir, 'trilha.wav');
  const kick = 'sin(2*PI*(48*mod(t,0.5)+3.3*(1-exp(-30*mod(t,0.5)))))*exp(-7*mod(t,0.5))';
  const hat = '(random(0)*2-1)*exp(-45*mod(t+0.25,0.5))*0.22';
  const end = DURATION - 0.5;
  const bass = `0.22*sin(2*PI*55*t)*exp(-4*mod(t,0.25))*between(t,${HOOK},${end})`;
  const cuts = [0, ...[0, 1, 2, 3, 4, 5].map(i => HOOK + i * SEG)];
  const hits = cuts.map(s => `(random(1)*2-1)*exp(-9*(t-${s}))*between(t,${s},${s + 0.8})*0.55`).join('+');
  const riser = `(random(2)*2-1)*0.10*pow(t/${HOOK},3)*between(t,0,${HOOK})`;
  const env = `if(gt(t,${DURATION - 1}),max(0,${DURATION}-t),1)`;
  const expr = `(0.85*(${kick})+${hat}+${bass}+${hits}+${riser})*${env}*0.8`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${DURATION}`,
    '-af', 'lowpass=f=9000,alimiter=limit=0.9', music]);

  // mix: voz por cima, trilha abaixa sozinha (sidechain) quando a voz entra
  const inputs = ['-i', music];
  const parts = [];
  VOICE.forEach((at, i) => {
    inputs.push('-i', path.join(dir, 'assets', 'voz', `narr_${i}.mp3`));
    parts.push(`[${i + 1}:a]aresample=44100,atempo=${VOICE_TEMPO},adelay=${Math.round(at * 1000)}:all=1[v${i}]`);
  });
  const ci = VOICE.length + 1, cineAt = Math.round((HOOK + 4 * SEG) * 1000);
  inputs.push('-i', path.join(dir, 'assets', 'cine_ia.mp4'));
  parts.push(`[${ci}:a]aresample=44100,asplit=2[ca][cb];[ca]atrim=0:2.2,asetrate=44100/2.045,aresample=44100[c1];` +
    `[cb]atrim=2.2:6,asetpts=PTS-STARTPTS,atempo=1.2667[c2];[c1][c2]concat=n=2:v=0:a=1,atrim=0:7.5,afade=t=out:st=7.1:d=0.4,volume=0.9,adelay=${cineAt}:all=1[cine]`);
  const filter = parts.join(';') + ';' +
    VOICE.map((_, i) => `[v${i}]`).join('') + `amix=inputs=${VOICE.length}:normalize=0,highpass=f=80,acompressor=threshold=-18dB:ratio=3,volume=1.6,apad=whole_dur=${DURATION},asplit=2[voz][sc];` +
    `[0:a][cine]amix=inputs=2:normalize=0,volume=0.55[mus];[mus][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duck];` +
    `[duck][voz]amix=inputs=2:normalize=0,alimiter=limit=0.95[out]`;
  const mixed = path.join(dir, 'audio_final.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-t', String(DURATION), mixed]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-i', mixed, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
    '-movflags', '+faststart', path.join(dir, 'video.mp4')]);
  [silent, music, mixed].forEach(f => fs.unlinkSync(f));
  console.log('ok -> video.mp4');
})();
