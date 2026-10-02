// Review the actual preview component; do not create posts or touch its DB.
// node scripts/review-brand-motion.mjs [origin] [--render]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const origin =
  process.argv.find((arg) => /^https?:/.test(arg)) ?? "http://127.0.0.1:3000";
const render = process.argv.includes("--render");
const out = resolve("data/brand-motion");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const evidence = { origin, widths: [], playback: [], errors };

async function open(mode) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 800 },
    reducedMotion: mode,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(origin);
  await page.waitForFunction(
    () => document.querySelector(".brand-letter")?.getAnimations().length > 0,
  );
  return { context, page };
}

async function seek(page, time) {
  await page.evaluate((time) => {
    document.getAnimations().forEach((track) => {
      track.pause();
      track.currentTime = time;
    });
  }, time);
}

try {
  for (const mode of ["no-preference", "reduce"]) {
    const { context, page } = await open(mode);
    const timing = await page.evaluate(() =>
      document.getAnimations().map((track) => ({
        start: track.startTime,
        duration: track.effect.getTiming().duration,
        keyframes: track.effect.getKeyframes().map((frame) => frame.easing),
      })),
    );
    assert(timing.every((track) => track.duration === 8400));
    assert.equal(new Set(timing.map((track) => track.start)).size, 1);
    assert(
      timing.every(
        (track) => !track.keyframes.some((easing) => easing.includes("steps")),
      ),
    );

    // Measure natural playback before scrubbing. A smooth animation has many
    // distinct intermediate transforms/opacities, not just two changed states.
    const playback = await page.evaluate(async () => {
      const word = document.querySelector(".brand-text");
      const glyph = document.querySelector(".brand-letter");
      const samples = [];
      const begin = performance.now();
      while (performance.now() - begin < 9000) {
        samples.push({
          time: performance.now() - begin,
          word: getComputedStyle(word).transform,
          glyph: getComputedStyle(glyph).transform,
          opacity: getComputedStyle(glyph).opacity,
        });
        await new Promise(requestAnimationFrame);
      }
      return {
        samples: samples.length,
        states: new Set(samples.map((s) => `${s.word}/${s.glyph}/${s.opacity}`))
          .size,
      };
    });
    assert(playback.states > 50);
    evidence.playback.push({ mode, ...playback });

    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      const phases = [];
      for (let time = 0; time <= 8400; time += 100) {
        await seek(page, time);
        const bounds = await page.evaluate(() => {
          const header = document
            .querySelector(".site-header")
            .getBoundingClientRect();
          const account = document
            .querySelector(".header-actions")
            .getBoundingClientRect();
          const elements = [
            ...document.querySelectorAll(".brand-letter, .brand-mark"),
          ];
          const boxes = elements.map((node) => node.getBoundingClientRect());
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            left: Math.min(...boxes.map((box) => box.left)),
            right: Math.max(...boxes.map((box) => box.right)),
            top: Math.min(...boxes.map((box) => box.top)),
            bottom: Math.max(...boxes.map((box) => box.bottom)),
            accountLeft: account.left,
            headerTop: header.top,
            headerBottom: header.bottom,
          };
        });
        assert(!bounds.overflow);
        assert(bounds.left >= 0 && bounds.right < bounds.accountLeft);
        assert(
          bounds.top >= bounds.headerTop &&
            bounds.bottom <= bounds.headerBottom,
        );
        phases.push(bounds);
      }
      evidence.widths.push({ width, mode, phases: phases.length });
      await seek(page, 0);
      await page.screenshot({ path: `${out}/header-${width}-${mode}.png` });
      if (mode === "no-preference") {
        await seek(page, 3100);
        await page.screenshot({ path: `${out}/header-${width}-turn.png` });
      }
    }

    await page.setViewportSize({ width: 1440, height: 800 });
    // The owner requests the same per-letter motion in both OS settings.
    assert.equal(
      await page
        .locator(".brand-text")
        .evaluate((node) => node.getAnimations().length),
      0,
    );
    assert.equal(await page.locator(".brand-letter").count(), 13);
    assert.equal(await page.locator(".brand-back").count(), 13);
    await seek(page, 3100);
    await page.getByRole("button", { name: "로고 움직임 정지" }).click();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    assert.equal(
      await page
        .locator(".brand-text")
        .evaluate((node) => getComputedStyle(node).transform),
      "none",
    );
    await page.reload();
    await page.getByRole("button", { name: "로고 전체 연출 재생" }).waitFor();
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await context.close();
  }

  // Render with the same DOM, styles, and seekable timeline as the live header.
  const { context, page } = await open("no-preference");
  await page.setViewportSize({ width: 960, height: 288 });
  await seek(page, 0);
  await page.evaluate(() => {
    const root = document.querySelector(".brand-lockup");
    const color = getComputedStyle(root).color;
    const background = getComputedStyle(
      document.querySelector(".site-header"),
    ).backgroundColor;
    document.body.replaceChildren(root);
    document.body.style.cssText = `margin:0;background:${background};display:grid;place-items:center;width:960px;height:288px`;
    root.style.cssText = `font-size:18px;color:${color};transform:scale(4);transform-origin:center`;
    document.querySelector(".brand-motion-control").style.display = "none";
  });
  const samples = [
    0, 800, 1700, 2250, 2700, 3050, 3400, 3700, 4100, 4500, 5000, 5500, 5900,
    6400, 7400, 8399,
  ];
  for (const [index, time] of samples.entries()) {
    await seek(page, time);
    await page.screenshot({
      path: `${out}/phase-${String(index).padStart(2, "0")}.png`,
    });
  }
  if (render) {
    const frames = `${out}/frames`;
    await mkdir(frames, { recursive: true });
    for (let index = 0; index < 504; index++) {
      await seek(page, (index * 1000) / 60);
      await page.screenshot({
        path: `${frames}/${String(index).padStart(4, "0")}.png`,
      });
      if (index % 120 === 0) console.log(`Rendered ${index}/504 frames`);
    }
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        "60",
        "-i",
        `${frames}/%04d.png`,
        "-c:v",
        "libx264",
        "-crf",
        "17",
        "-preset",
        "fast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        `${out}/reversing-all-loop.mp4`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    evidence.render = {
      frames: 504,
      fps: 60,
      seconds: 8.4,
      width: 960,
      height: 288,
    };
  }
  await context.close();
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/verification.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
