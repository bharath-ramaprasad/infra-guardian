#!/usr/bin/env node
// Records the narrated demo of the live site with Playwright, one clip per scene, each step's narration padded to
// the exact time its actions took, then muxes and concatenates into public/demo/infra-guardian-demo.mp4.
// Usage: EDGE_TTS_BIN=/path/to/edge-tts node scripts/demo/record.mjs [https://infra-guardian.netlify.app] [--only=03,06]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const BASE = (process.argv[2] ?? "https://infra-guardian.netlify.app").replace(/\/$/, "");
const WORK = resolve(process.env.DEMO_WORK ?? ".demo-work");
const OUT_DIR = resolve("public/demo");
const TTS = process.env.EDGE_TTS_BIN ?? "edge-tts";
const VOICE = process.env.DEMO_VOICE ?? "en-US-AndrewMultilingualNeural";
const SIZE = { width: 1440, height: 900 };
const tag = Math.random().toString(36).slice(2, 6);
const sessions = {
  intro: `demo-a-${tag}`,
  card1off: `demo-b-${tag}`,
  load: `demo-c-${tag}`,
  loadoff: `demo-d-${tag}`,
  batch: `demo-e-${tag}`,
  batchoff: `demo-f-${tag}`,
};
for (const d of ["audio", "video", "clips"]) mkdirSync(join(WORK, d), { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const duration = (file) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));

function tts(text) {
  const h = createHash("sha1")
    .update(VOICE + text)
    .digest("hex")
    .slice(0, 12);
  const mp3 = join(WORK, "audio", `${h}.mp3`);
  const wav = join(WORK, "audio", `${h}.wav`);
  if (!existsSync(wav)) {
    sh(TTS, ["--voice", VOICE, "--rate=+4%", "--text", text, "--write-media", mp3]);
    sh("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-ar", "48000", "-ac", "2", wav]);
  }
  return { wav, seconds: duration(wav) };
}

const CURSOR = `
(() => {
  const c = document.createElement("div");
  c.id = "pw-cursor";
  c.style.cssText = "position:fixed;left:-50px;top:-50px;width:18px;height:18px;border-radius:50%;background:rgba(81,69,184,.35);border:2px solid #5145b8;z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:transform .12s";
  const attach = () => document.body && document.body.appendChild(c);
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", attach) : attach();
  window.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
  window.addEventListener("mousedown", () => { c.style.transform = "translate(-50%,-50%) scale(.6)"; }, true);
  window.addEventListener("mouseup", () => { c.style.transform = "translate(-50%,-50%) scale(1)"; }, true);
})();`;

function helpers(page) {
  const box = async (sel) => {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: "visible", timeout: 15000 });
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no box for ${sel}`);
    return b;
  };
  const moveTo = async (sel, fx = 0.5, fy = 0.5) => {
    const b = await box(sel);
    await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 22 });
  };
  return {
    page,
    sleep,
    async scrollTo(sel, block = "start") {
      await page
        .locator(sel)
        .first()
        .evaluate((el, blk) => el.scrollIntoView({ behavior: "smooth", block: blk }), block);
      await sleep(900);
    },
    async hover(sel) {
      await moveTo(sel);
      await sleep(250);
    },
    async click(sel) {
      await moveTo(sel);
      await sleep(120);
      // Playwright re-resolves the locator and waits for it to be stable, so a re-rendering list cannot swallow the click.
      await page.locator(sel).first().click({ timeout: 15000 });
      await sleep(150);
    },
    async type(sel, text) {
      await moveTo(sel);
      await page.mouse.click((await box(sel)).x + 30, (await box(sel)).y + 20);
      await page.locator(sel).first().fill("");
      await page.keyboard.type(text, { delay: 22 });
    },
    async setRange(sel, value) {
      const el = page.locator(sel).first();
      const [min, max] = await el.evaluate((e) => [Number(e.min), Number(e.max)]);
      const fx = Math.min(0.995, Math.max(0.005, (value - min) / (max - min)));
      await moveTo(sel, fx, 0.5);
      await sleep(100);
      await page.mouse.down();
      await sleep(60);
      await page.mouse.up();
      await el.evaluate((e, v) => {
        e.value = String(v);
        e.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await sleep(200);
    },
    async waitText(sel, re, timeout = 40000) {
      await page.locator(sel).first().filter({ hasText: re }).waitFor({ timeout });
    },
  };
}

const INVOICE = "customer is on the phone waiting for their invoice PDF, read-only fetch";
const CHARGE = "charge the customer's card for order 4711";
const EXPORT = "nightly analytics export for the data warehouse";

const scenes = [
  {
    name: "01-intro-card1-jev-on",
    session: sessions.intro,
    steps: [
      {
        say: "This is infra-guardian: a circuit breaker, rate limiter, and batch preemptor for a service under stress. Its policy is advised by Jev, TypeSafe's decision model, and bounded by code.",
        do: async (h) => {
          await h.hover("#tier");
          await h.sleep(1200);
          await h.hover("#decider");
        },
      },
      {
        say: "Why Jev? A conventional limiter cannot tell a checkout from a nightly export, or a read-only fetch from a card charge. Jev returns typed decisions with calibrated probabilities, which code can gate, clamp, and budget. The guarantees hold whether Jev is on or off: the tier moves one step per window, Jev can raise caution but never lower it, and every response explains itself.",
        do: async (h) => {
          await h.hover("#jevBudget");
          await h.sleep(2500);
          await h.hover("#poolCriticalN");
        },
      },
      {
        say: "Card one asks Jev how a request should be treated. A customer on the phone waiting for their invoice: Jev classifies it critical with high confidence, and judges it safe to run twice, so a hedged second copy is allowed.",
        do: async (h) => {
          await h.scrollTo("#chips");
          await h.type("#desc", INVOICE);
          await h.click("#sendOnce");
          await h.waitText("#onceResult", /HTTP/);
          await h.hover("#onceResult");
        },
      },
      {
        say: "Now charge the customer's card. Still critical, but Jev vetoes the hedge: this must not run twice.",
        do: async (h) => {
          await h.type("#desc", CHARGE);
          await h.click("#sendOnce");
          await h.waitText("#onceResult", /gated/);
          await h.hover("#onceResult");
        },
      },
      {
        say: "And a nightly analytics export is bulk: first to wait, first to be shed.",
        do: async (h) => {
          await h.type("#desc", EXPORT);
          await h.click("#sendOnce");
          await h.waitText("#onceResult", /bulk/);
          await h.hover("#onceResult");
        },
      },
    ],
  },
  {
    name: "02-card1-jev-off",
    session: sessions.card1off,
    jevOff: true,
    steps: [
      {
        say: "The same request with Jev switched off for this session. The decider is deterministic: every request is standard class, hedging is off, and the header says so. Nothing breaks; the system is simply less discriminating.",
        do: async (h) => {
          await h.hover("#jevOn");
          await h.sleep(600);
          await h.scrollTo("#chips");
          await h.type("#desc", INVOICE);
          await h.click("#sendOnce");
          await h.waitText("#onceResult", /deterministic/);
          await h.hover("#onceResult");
        },
      },
    ],
  },
  {
    name: "03-card2-jev-on-details",
    session: sessions.load,
    steps: [
      {
        say: "Card two puts the guarded endpoint under real load from the browser: a checkout stream and an export stream, with the simulated upstream failing sixty percent of calls.",
        do: async (h) => {
          await h.scrollTo("#rpsCrit");
          await h.setRange("#rpsCrit", 6);
          await h.setRange("#rpsBulk", 6);
          await h.setRange("#fail", 60);
          await h.click("#startLoad");
        },
      },
      {
        say: "Watch the tier. It climbs one step per five-second window, never two, and the strip shows who decided: Jev's stress score with its confidence, or the deterministic rule. Each step is written to the tier history with the window's numbers: calls, error rate, p95.",
        do: async (h) => {
          await h.scrollTo("body", "start");
          await h.hover("#tier");
          await h.waitText("#tier", /2 HARD/, 45000);
          await h.hover("#decider");
        },
      },
      {
        say: "Class pools shrink with each tier: bulk loses its share first, then standard. At tier four the breaker opens and every call fails fast without touching upstream: five-oh-three, circuit open, with a retry-after.",
        do: async (h) => {
          await h.hover("#poolBulkN");
          await h.waitText("#tier", /4 OPEN/, 45000);
          await h.hover("#breaker");
        },
      },
      {
        say: "Card four is the decision log: every response carries headers that explain it. Click a row and card five shows why: the classification, the admission, the hedge, the upstream outcome, and where the system was. The tier history is a timeline with the numbers behind every step.",
        do: async (h) => {
          await h.click("#stopLoad");
          await h.sleep(2500);
          await h.scrollTo("#log");
          await h.click("#log .row-log");
          await h.page.locator("#details").waitFor({ state: "visible", timeout: 10000 });
          await h.scrollTo("#detailsCard");
          await h.hover("#dWhy");
          await h.sleep(2500);
          await h.scrollTo("#tierHistory", "center");
          await h.hover("#tierHistory");
        },
      },
      {
        say: "Recovery is just as disciplined. Drop the failures: after the cooldown a single half-open probe goes through, the ladder reopens at SHED, and then walks down one tier per two clean windows.",
        do: async (h) => {
          await h.scrollTo("#rpsCrit");
          await h.setRange("#fail", 0);
          await h.click("#startLoad");
          await h.scrollTo("body", "start");
          await h.hover("#breaker");
          await h.waitText("#tier", /3 SHED/, 40000);
          await h.hover("#tier");
          await h.sleep(1500);
          await h.click("#stopLoad");
        },
      },
    ],
  },
  {
    name: "04-card2-jev-off",
    session: sessions.loadoff,
    jevOff: true,
    steps: [
      {
        say: "Same load with Jev off. The ladder still climbs, driven purely by the error-rate and latency thresholds, and the tile reads deterministic. Every request is standard class now, so the pools are shared evenly and nobody gets a hedge. Jev adds judgment on top of the rules; it is never the only thing holding the line.",
        do: async (h) => {
          await h.scrollTo("#rpsCrit");
          await h.setRange("#rpsCrit", 6);
          await h.setRange("#rpsBulk", 6);
          await h.setRange("#fail", 60);
          await h.click("#startLoad");
          await h.scrollTo("body", "start");
          await h.hover("#decider");
          await h.waitText("#tier", /2 HARD/, 45000);
          await h.hover("#tier");
          await h.sleep(800);
          await h.click("#stopLoad");
        },
      },
    ],
  },
  {
    name: "05-card3-jev-on",
    session: sessions.batch,
    steps: [
      {
        say: "Card three: batch work that yields to critical traffic. Submit a nightly export. Jev scores how deferrable it is, four of four, unattended, and the job starts because the guard sees no pressure.",
        do: async (h) => {
          await h.scrollTo("#jobDesc");
          await h.click("#jobItems");
          await h.page.keyboard.press("Meta+a");
          await h.page.keyboard.type("300", { delay: 60 });
          await h.click("#submitJob");
          await h.waitText("#jobs", /started/, 20000);
          await h.hover("#jobs table");
        },
      },
      {
        say: "Now a burst of checkout traffic. A critical request that cannot be admitted promptly raises the yield flag, and the job is preempted at the next chunk boundary, with its cursor saved and the reason written down.",
        do: async (h) => {
          await h.scrollTo("#rpsCrit");
          await h.setRange("#rpsCrit", 18);
          await h.setRange("#rpsBulk", 0);
          await h.click("#startLoad");
          await h.scrollTo("#jobs");
          await h.waitText("#jobs", /PREEMPTED/, 30000);
          await h.hover("#jobs .wait");
        },
      },
      {
        say: "While the pressure lasts the job waits, but it cannot starve: after ten seconds without progress the aging guard grants exactly one chunk, and the table shows it.",
        do: async (h) => {
          await h.waitText("#jobs", /aging chunk/, 40000);
          await h.hover("#jobs table");
        },
      },
      {
        say: "Stop the burst and the job resumes from its saved cursor. No work is lost, and the full history is one click away.",
        do: async (h) => {
          await h.click("#stopLoad");
          await h.scrollTo("#jobs");
          await h.waitText("#jobs", /RUNNING|DONE/, 30000);
          await h.click("#jobs [data-history]");
          await h.sleep(2500);
          await h.hover("#jdTable");
          await h.sleep(1000);
          await h.click("#jdClose");
        },
      },
    ],
  },
  {
    name: "06-card3-jev-off",
    session: sessions.batchoff,
    jevOff: true,
    steps: [
      {
        say: "With Jev off, deferability defaults to level two, and there is no critical class, so a checkout burst cannot raise the yield flag. Preemption still holds through the ladder: push the upstream into failure, and when the tier reaches HARD_THROTTLE the job yields at a chunk boundary all the same.",
        do: async (h) => {
          await h.scrollTo("#jobDesc");
          await h.click("#submitJob");
          await h.waitText("#jobs", /started/, 20000);
          await h.scrollTo("#rpsCrit");
          await h.setRange("#rpsCrit", 6);
          await h.setRange("#rpsBulk", 6);
          await h.setRange("#fail", 60);
          await h.click("#startLoad");
          await h.scrollTo("#jobs");
          await h.waitText("#jobs", /PREEMPTED/, 50000);
          await h.hover("#jobs .wait");
        },
      },
      {
        say: "The reason is written down: tier two, batch gets zero chunks per second. Jev decides who resumes first; the yield itself is a code guarantee.",
        do: async (h) => {
          await h.hover("#jobs table");
          await h.sleep(1500);
          await h.click("#stopLoad");
        },
      },
    ],
  },
  {
    name: "07-outro",
    session: sessions.intro,
    steps: [
      {
        say: "Everything you saw is available from curl through the same headers, with the code, the plan, and the rationale on GitHub. Take it for a spin: your session is your own sandbox.",
        do: async (h) => {
          await h.hover("#statusLink");
          await h.sleep(1500);
          await h.hover("h1");
        },
      },
    ],
  },
];

async function prepareSessions() {
  for (const [key, sid] of Object.entries(sessions)) {
    const off = ["card1off", "loadoff", "batchoff"].includes(key);
    const r = await fetch(`${BASE}/api/reset?s=${sid}${off ? "&jev=off" : ""}`, { method: "POST" });
    if (!r.ok) throw new Error(`reset ${sid} failed: ${r.status}`);
  }
}

async function recordScene(browser, scene) {
  const audio = scene.steps.map((s) => tts(s.say));
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: join(WORK, "video"), size: SIZE } });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  const created = Date.now();
  await page.goto(`${BASE}/?s=${scene.session}`, { waitUntil: "networkidle" });
  await page.mouse.move(640, 300, { steps: 5 });
  await sleep(500);
  const t0 = Date.now();
  const lead = (t0 - created) / 1000;
  const h = helpers(page);
  const timeline = [];
  for (let i = 0; i < scene.steps.length; i++) {
    const step = scene.steps[i];
    const start = Date.now();
    await Promise.all([step.do ? step.do(h) : Promise.resolve(), sleep(audio[i].seconds * 1000 + 350)]);
    const took = (Date.now() - start) / 1000;
    timeline.push({ say: step.say.slice(0, 60), audio: audio[i].seconds, took });
  }
  await sleep(500);
  const video = page.video();
  await context.close();
  const webm = await video.path();

  const parts = [];
  const silence = join(WORK, "clips", `${scene.name}-lead.wav`);
  sh("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", lead.toFixed(3), silence]);
  parts.push(silence);
  timeline.forEach((t, i) => {
    const padded = join(WORK, "clips", `${scene.name}-${i}.wav`);
    sh("ffmpeg", ["-y", "-v", "error", "-i", audio[i].wav, "-af", "apad", "-t", t.took.toFixed(3), padded]);
    parts.push(padded);
  });
  const list = join(WORK, "clips", `${scene.name}.txt`);
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  const sceneWav = join(WORK, "clips", `${scene.name}.wav`);
  sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", sceneWav]);
  const mp4 = join(WORK, "clips", `${scene.name}.mp4`);
  sh("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    webm,
    "-i",
    sceneWav,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-vf",
    "scale=1440:900",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  return { mp4, lead, timeline, video: duration(webm), audio: duration(sceneWav) };
}

const only = (process.argv[3] ?? "")
  .replace(/^--only=/, "")
  .split(",")
  .filter(Boolean);
const wanted = (scene) => only.length === 0 || only.some((o) => scene.name.includes(o));
const browser = await chromium.launch();
await prepareSessions();
const report = [];
for (const scene of scenes) {
  const existing = join(WORK, "clips", `${scene.name}.mp4`);
  if (!wanted(scene) && existsSync(existing)) {
    console.log(`reusing   ${scene.name} (${duration(existing).toFixed(1)}s)`);
    report.push({ scene: scene.name, mp4: existing, lead: 0, timeline: [], video: duration(existing), audio: duration(existing) });
    continue;
  }
  process.stdout.write(`recording ${scene.name} ... `);
  const r = await recordScene(browser, scene);
  console.log(`video ${r.video.toFixed(1)}s audio ${r.audio.toFixed(1)}s lead ${r.lead.toFixed(2)}s`);
  for (const t of r.timeline) console.log(`   ${t.audio.toFixed(1)}s narration / ${t.took.toFixed(1)}s on screen  ${t.say}`);
  report.push({ scene: scene.name, ...r });
}
await browser.close();
const list = join(WORK, "clips", "all.txt");
writeFileSync(list, report.map((r) => `file '${r.mp4}'`).join("\n"));
const finalMp4 = join(OUT_DIR, "infra-guardian-demo.mp4");
sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", finalMp4]);
sh("ffmpeg", ["-y", "-v", "error", "-ss", "2", "-i", finalMp4, "-frames:v", "1", "-q:v", "3", join(OUT_DIR, "poster.jpg")]);
const total = duration(finalMp4);
writeFileSync(join(WORK, "report.json"), JSON.stringify({ base: BASE, sessions, total, report }, null, 2));
console.log(`\nfinal: ${finalMp4} ${(total / 60).toFixed(1)} min`);
