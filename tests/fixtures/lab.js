const query = new URLSearchParams(location.search);
const mode = query.get("mode") || "stable";
const arena = document.getElementById("arena");
const eventList = document.getElementById("events");
const retainedArrays = [];
let requests = 0;
let running = true;
let audioContext;
let oscillator;
const startedAt = performance.now();

const definitions = {
  stable: ["Stable small DOM", "Keeps a small, unchanged document. The detector should settle on healthy."],
  "stable-large": ["Stable large DOM", "Creates a large document once, then remains stable. Size alone must not trigger a warning."],
  "pathological-dom": ["Pathological DOM", "Creates 120,000 retained elements once. Start monitoring only after creation settles; collector recounts must censor work rather than monopolize the page."],
  "dom-leak": ["Retained DOM growth", "Adds and retains 2,000 elements every second. This is the primary positive detector fixture."],
  "burst-release": ["Burst and release", "Creates a large burst, then removes it. A transient spike must not become confirmed."],
  churn: ["Mutation churn", "Adds and removes equal batches continuously. Gross work is high but net retention is bounded."],
  resources: ["Resource accumulation", "Issues unique fetches continuously to grow resource timing entries."],
  "js-only": ["Pure JavaScript allocation", "Retains ArrayBuffers without growing the DOM. This demonstrates a known Firefox API gap."],
  stalls: ["Visible responsiveness stalls", "Blocks the main thread periodically. Delay is supporting evidence, not proof of a leak."],
  dirty: ["Edited-input protection", "Type into the field. The extension records only that an edit occurred, never its value, and protects the tab."],
  beforeunload: ["beforeunload protection", "Editing the form registers a navigation prompt; Firefox should reject silent discard."],
  audio: ["Audible tab protection", "Start the oscillator. Audible tabs must not be automatically reset."]
};

const definition = definitions[mode] || definitions.stable;
document.title = `Fixture · ${definition[0]}`;
document.getElementById("title").textContent = definition[0];
document.getElementById("description").textContent = definition[1];
document.getElementById("mode").textContent = mode;

if (mode === "stable-large") addNodes(50_000);
if (mode === "pathological-dom") addNodes(120_000);
if (mode === "dirty" || mode === "beforeunload") document.getElementById("form-zone").hidden = false;
if (mode === "beforeunload") {
  document.querySelector("textarea").addEventListener("input", () => {
    window.addEventListener("beforeunload", beforeUnload);
    log("beforeunload guard enabled");
  }, { once: true });
}
if (mode === "audio") document.getElementById("audio").hidden = false;

document.getElementById("toggle").addEventListener("click", (event) => {
  running = !running;
  event.target.textContent = running ? "Pause fixture" : "Resume fixture";
  log(running ? "resumed" : "paused");
});
document.getElementById("burst").addEventListener("click", runBurst);
document.getElementById("release").addEventListener("click", releaseAll);
document.getElementById("audio").addEventListener("click", toggleAudio);

setInterval(tick, 1_000);
setInterval(updateDashboard, 500);
runBurst();

function tick() {
  if (!running) return;
  if (mode === "dom-leak") addNodes(250);
  if (mode === "churn") {
    addNodes(2_000);
    while (arena.childElementCount > 2_000) arena.firstElementChild.remove();
  }
  if (mode === "resources") {
    for (let index = 0; index < 25; index += 1) {
      requests += 1;
      fetch(`fixture-ping.json?request=${requests}`).catch(() => {});
    }
  }
  if (mode === "js-only") {
    for (let index = 0; index < 10; index += 1) retainedArrays.push(new Uint8Array(1_000_000));
  }
  if (mode === "stalls") {
    const until = performance.now() + 700;
    while (performance.now() < until) Math.sqrt(Math.random());
  }
}

function runBurst() {
  if (mode === "burst-release") {
    addNodes(30_000);
    log("added 30,000-node burst");
    setTimeout(() => {
      arena.replaceChildren();
      addNodes(200);
      log("released burst");
    }, 4_000);
    return;
  }
  if (mode === "stable-large") return;
  if (mode === "js-only") {
    for (let index = 0; index < 50; index += 1) retainedArrays.push(new Uint8Array(1_000_000));
    log("allocated 50 MB of JS-only fixture data");
    return;
  }
  addNodes(mode === "dom-leak" ? 2_000 : 200);
  log("ran one fixture burst");
}

function addNodes(count) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div");
    row.className = "fixture-row";
    row.textContent = `Retained fixture node ${arena.childElementCount + index + 1}`;
    fragment.append(row);
  }
  arena.append(fragment);
}

function releaseAll() {
  arena.replaceChildren();
  retainedArrays.length = 0;
  log("released DOM and JavaScript fixture data");
}

async function toggleAudio(event) {
  if (oscillator) {
    oscillator.stop();
    oscillator = undefined;
    await audioContext.close();
    audioContext = undefined;
    event.target.textContent = "Start audio";
    log("audio stopped");
    return;
  }
  audioContext = new AudioContext();
  oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  gain.gain.value = 0.035;
  oscillator.frequency.value = 220;
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  event.target.textContent = "Stop audio";
  log("audio started");
}

function beforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
}

function updateDashboard() {
  // Every generated fixture node is a direct arena child. Avoid a whole-DOM
  // traversal here so fixture instrumentation cannot be mistaken for
  // extension-attributable collector work.
  document.getElementById("dom-count").textContent = arena.childElementCount.toLocaleString();
  document.getElementById("array-count").textContent = retainedArrays.length.toLocaleString();
  document.getElementById("request-count").textContent = requests.toLocaleString();
  document.getElementById("elapsed").textContent = `${Math.round((performance.now() - startedAt) / 1_000)}s`;
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  eventList.prepend(item);
  while (eventList.children.length > 30) eventList.lastElementChild.remove();
}
