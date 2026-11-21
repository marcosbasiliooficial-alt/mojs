// Renderiza index.html quadro a quadro e gera o MP4 com trilha.
// Uso: node render.cjs            -> video.mp4
//      node render.cjs --stills   -> PNGs de conferência em ./stills
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FPS = 30, DURATION = 33;
const dir = __dirname;
const stills = process.argv.includes('--stills');

(async () => {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  page.on('pageerror', e => console.error('PAGE ERROR', e));
  await page.goto('file://' + path.join(dir, 'index.html') + '#render');
  await page.evaluate(() => window.ready);

  const grab = t => page.evaluate(t => { window.renderFrame(t); return document.getElementById('c').toDataURL('image/jpeg', 0.95).split(',')[1]; }, t);

  if (stills) {
    fs.mkdirSync(path.join(dir, 'stills'), { recursive: true });
    for (const t of [0.3, 1.2, 2.4, 4.5, 7.0, 10.5, 12.6, 16.0, 19.5, 22.5, 25.5, 27.5, 29.0, 31.5]) {
      fs.writeFileSync(path.join(dir, 'stills', `t${t.toFixed(1)}.jpg`), Buffer.from(await grab(t), 'base64'));
    }
    await browser.close(); return;
  }

  const silent = path.join(dir, 'video_sem_audio.mp4');
  const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = FPS * DURATION;
  for (let f = 0; f < total; f++) {
    const buf = Buffer.from(await grab(f / FPS), 'base64');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 90 === 0) console.log(`frame ${f}/${total}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await browser.close();

  // trilha: kick 120 BPM + hi-hat no contratempo + baixo + impacto em cada troca de estilo
  const audio = path.join(dir, 'trilha.wav');
  const kick = 'sin(2*PI*(48*mod(t,0.5)+3.3*(1-exp(-30*mod(t,0.5)))))*exp(-7*mod(t,0.5))';
  const hat = '(random(0)*2-1)*exp(-45*mod(t+0.25,0.5))*0.22';
  const bass = '0.22*sin(2*PI*55*t)*exp(-4*mod(t,0.25))*between(t,3,32.5)';
  const hits = [0, 3, 8, 13, 18, 23, 28].map(s => `(random(1)*2-1)*exp(-9*(t-${s}))*between(t,${s},${s + 0.8})*0.55`).join('+');
  const riser = '(random(2)*2-1)*0.12*pow(t/3,3)*between(t,0,3)';
  const env = 'if(gt(t,32),max(0,1-(t-32)),1)';
  const expr = `(0.85*(${kick})+${hat}+${bass}+${hits}+${riser})*${env}*0.8`;
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${DURATION}`,
    '-af', 'lowpass=f=9000,alimiter=limit=0.9', audio], { stdio: 'inherit' });
  execFileSync('ffmpeg', ['-y', '-i', silent, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
    '-movflags', '+faststart', path.join(dir, 'video.mp4')], { stdio: 'inherit' });
  fs.unlinkSync(silent); fs.unlinkSync(audio);
  console.log('ok -> video.mp4');
})();
