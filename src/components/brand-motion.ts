// One shared clock: the live logo and frame-by-frame exports use these tracks.
export const BRAND_DURATION = 8_400;
const lastLetter = "Reversing All".length - 1;
const settle = "cubic-bezier(0.22, 1, 0.36, 1)";
const travel = "cubic-bezier(0.65, 0, 0.35, 1)";

function frame(time: number, values: Omit<Keyframe, "offset">): Keyframe {
  return { offset: time / BRAND_DURATION, ...values };
}

function letterFrames(index: number): Keyframe[] {
  const depart = 1_950 + index * 45;
  const returnAt = 3_820 + (lastLetter - index) * 45;
  const pose = (x = 0, y = 0, turn = 0, tilt = 0) =>
    `translate(${x}ch, ${y}em) rotateY(${turn}deg) rotateZ(${tilt}deg)`;

  return [
    frame(0, { transform: pose() }),
    frame(350 + index * 55, { transform: pose(), easing: settle }),
    // Readable word, a gentle wave ahead of the main reversal.
    frame(700 + index * 55, { transform: pose(0, -0.035), easing: settle }),
    frame(1_250 + index * 55, { transform: pose(), easing: settle }),
    frame(depart, { transform: pose(), easing: settle }),
    frame(depart + 140, {
      transform: pose(-0.1, 0.06, -12, -2),
      easing: travel,
    }),
    frame(depart + 620, {
      transform: pose(0.14, -0.24, 190, 2),
      easing: settle,
    }),
    frame(depart + 950, { transform: pose(0, 0, 180), easing: settle }),
    frame(returnAt, { transform: pose(0, 0, 180), easing: settle }),
    frame(returnAt + 140, {
      transform: pose(0.1, -0.06, 192, 2),
      easing: travel,
    }),
    frame(returnAt + 620, {
      transform: pose(-0.14, 0.24, -10, -2),
      easing: settle,
    }),
    frame(returnAt + 950, { transform: pose(), easing: settle }),
    frame(7_150 + index * 45, { transform: pose(0, -0.025), easing: settle }),
    frame(7_900 + index * 40, { transform: pose() }),
    frame(BRAND_DURATION, { transform: pose() }),
  ];
}

export function animateBrand(root: HTMLElement): Animation[] {
  const tracks: Animation[] = [];
  const add = (selector: string, keyframes: Keyframe[]) => {
    root
      .querySelectorAll<HTMLElement | SVGElement>(selector)
      .forEach((node) => {
        tracks.push(
          node.animate(keyframes, {
            duration: BRAND_DURATION,
            iterations: Infinity,
            easing: "linear",
            fill: "both",
          }),
        );
      });
  };

  root.querySelectorAll<HTMLElement>(".brand-letter").forEach((node, index) => {
    tracks.push(
      node.animate(letterFrames(index), {
        duration: BRAND_DURATION,
        iterations: Infinity,
        fill: "both",
      }),
    );
  });

  add(".brand-trace", [
    frame(0, { opacity: 0 }),
    frame(450, { opacity: 0, strokeDashoffset: "32", easing: "ease-in-out" }),
    frame(1_200, { opacity: 0.9, strokeDashoffset: "18" }),
    frame(2_200, { opacity: 0, strokeDashoffset: "-18" }),
    frame(4_900, {
      opacity: 0,
      strokeDashoffset: "-18",
      easing: "ease-in-out",
    }),
    frame(5_600, { opacity: 0.9, strokeDashoffset: "4" }),
    frame(7_600, { opacity: 0, strokeDashoffset: "32" }),
    frame(BRAND_DURATION, { opacity: 0 }),
  ]);
  add(".brand-scan", [
    frame(0, { opacity: 0, transform: "translateX(0ch) scaleX(0.3)" }),
    frame(700, { opacity: 0, transform: "translateX(0ch) scaleX(0.3)" }),
    frame(1_300, { opacity: 0.7 }),
    frame(2_700, {
      opacity: 0,
      transform: `translateX(${lastLetter}ch) scaleX(1)`,
    }),
    frame(5_800, {
      opacity: 0,
      transform: `translateX(${lastLetter}ch) scaleX(1)`,
    }),
    frame(6_300, { opacity: 0.7 }),
    frame(8_000, { opacity: 0, transform: "translateX(0ch) scaleX(0.3)" }),
    frame(BRAND_DURATION, {
      opacity: 0,
      transform: "translateX(0ch) scaleX(0.3)",
    }),
  ]);

  // Individual animate() calls share a startTime, even under slower rendering.
  const start = document.timeline.currentTime;
  tracks.forEach((track) => (track.startTime = start));
  return tracks;
}
