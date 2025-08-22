// ====== BASIC STATE ======
let tfModel = null;
let student = { name: "Unknown", roll: "Unknown" };

const el = (id) => document.getElementById(id);
const video = el("video");
const overlay = el("overlay");
const octx = overlay.getContext("2d");
const snapshot = el("snapshot");
const sctx = snapshot.getContext("2d");
const resultEl = el("result");
const logEl = el("log");

// ====== UI HOOKS ======
el("saveBtn").addEventListener("click", () => {
  student.roll = (el("rollNo").value || "Unknown").trim();
  student.name = (el("name").value || "Unknown").trim();
  el("studentStatus").textContent =
    `Saved: ${student.name} (Roll: ${student.roll})`;
});

el("scanBtn").addEventListener("click", async () => {
  if (!tfModel) { log("Model not ready yet…"); return; }
  if (!video.srcObject) { log("Camera not ready yet…"); return; }

  lockUI(true);
  clearOverlay();
  resultEl.classList.remove("yes","no");
  resultEl.textContent = "Result: Scanning…";

  try {
    const verdict = await scanForPapers({ seconds: 2.0, fps: 4 }); // ~8 frames
    showVerdict(verdict);
    if (verdict.hasPapers && el("sendEmail").checked) {
      await sendEmailWithEvidence(verdict);
      log("Email sent to Principal.");
    }
  } catch (e) {
    console.error(e);
    log("Scan error. See console.");
  } finally {
    lockUI(false);
  }
});

// ====== CAMERA ======
(async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      // match overlay to video size
      overlay.width  = video.videoWidth  || 640;
      overlay.height = video.videoHeight || 480;
      snapshot.width = overlay.width;
      snapshot.height = overlay.height;
    };
  } catch (e) {
    console.error("Camera error:", e);
    log("Allow camera permission to scan.");
  }
})();

// ====== MODEL ======
(async function loadModel() {
  log("Loading AI model…");
  tfModel = await cocoSsd.load(); // COCO-SSD (browser)
  log("Model loaded. Ready to scan.");
})();

// ====== SCAN LOOP ======
async function scanForPapers({ seconds = 2, fps = 4 } = {}) {
  const frames = Math.max(1, Math.floor(seconds * fps));
  let detected = false;
  let lastDet = null;

  for (let i = 0; i < frames; i++) {
    // 1) Run object detection
    const preds = await tfModel.detect(video);

    // Draw boxes (for operator awareness, not used in the “single answer”)
    clearOverlay();
    drawPredictions(preds);

    // 2) Decide based on classes OR paper heuristic
    const classFlag = preds.some(p =>
      UNAUTHORIZED_CLASSES.includes(p.class) && p.score >= 0.55
    );

    const paperFlag = await paperHeuristic(); // cheap white-rect finder

    if (classFlag || paperFlag) {
      detected = true;
      lastDet = { classFlag, paperFlag, preds };
      // We can break early if you want instant result:
      // break;
    }

    // short pause to hit target fps
    await sleep(1000 / fps);
  }

  // If detected: capture snapshot for evidence
  let evidence = null;
  if (detected) {
    sctx.drawImage(video, 0, 0, snapshot.width, snapshot.height);
    sctx.drawImage(overlay, 0, 0);
    evidence = snapshot.toDataURL("image/png");
  }

  return {
    hasPapers: detected,
    evidence,
    student: { ...student },
    timestamp: new Date().toISOString()
  };
}

// ====== UNAUTHORIZED CLASSES ======
const UNAUTHORIZED_CLASSES = [
  // COCO-SSD classes we treat as unauthorized exam items
  "book",        // any extra book/notes
  "cell phone",  // phones not allowed
  "laptop", "remote", "tv", // extend as needed
];

// ====== PAPER HEURISTIC ======
// Very lightweight: looks for a large bright rectangular-ish blob
// in the lower half (hands area). Not perfect, but useful as a hint
// because COCO-SSD doesn’t have a “paper” class.
async function paperHeuristic() {
  // downscale to speed up
  const w = 224, h = 224;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(video, 0, 0, w, h);

  // focus lower half
  const y0 = Math.floor(h * 0.45), hh = h - y0;
  const img = tctx.getImageData(0, y0, w, hh);
  const data = img.data;

  // count bright pixels & estimate simple rectangular-ness by row spans
  let bright = 0;
  const rowSpans = new Array(hh).fill(0);
  for (let y = 0; y < hh; y++) {
    let rowBright = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      // brightness (simple)
      const br = (r + g + b) / 3;
      if (br > 225) { // very bright (white-ish)
        rowBright++;
        bright++;
      }
    }
    rowSpans[y] = rowBright;
  }

  const brightRatio = bright / (w * hh);

  // rectangular-ness: look for consistent bright rows near the center
  const midStart = Math.floor(hh * 0.20);
  const midEnd   = Math.floor(hh * 0.75);
  let consistentRows = 0;
  for (let y = midStart; y < midEnd; y++) {
    if (rowSpans[y] > w * 0.20) consistentRows++; // 20% of row is very bright
  }
  const consistRatio = consistentRows / (midEnd - midStart);

  // thresholds tuned for typical lighting; adjust if needed
  const likelyPaper = (brightRatio > 0.05 && consistRatio > 0.35);
  return likelyPaper;
}

// ====== DRAW HELPERS ======
function clearOverlay() { octx.clearRect(0, 0, overlay.width, overlay.height); }

function drawPredictions(preds) {
  octx.lineWidth = 3;
  octx.font = "16px system-ui";
  preds.forEach(p => {
    const [x, y, w, h] = p.bbox;
    octx.strokeStyle = "rgba(255,255,255,0.9)";
    octx.strokeRect(x, y, w, h);
    octx.fillStyle = "rgba(0,0,0,0.5)";
    const label = `${p.class} ${(p.score*100).toFixed(0)}%`;
    octx.fillRect(x, y-22, octx.measureText(label).width + 10, 20);
    octx.fillStyle = "#fff";
    octx.fillText(label, x + 5, y - 7);
  });
}

// ====== VERDICT DISPLAY ======
function showVerdict(verdict) {
  if (verdict.hasPapers) {
    resultEl.textContent = "Result: PAPERS/SLIPS — YES";
    resultEl.classList.add("yes");
    resultEl.classList.remove("no");
  } else {
    resultEl.textContent = "Result: PAPERS/SLIPS — NO";
    resultEl.classList.add("no");
    resultEl.classList.remove("yes");
  }
}

// ====== EMAIL (OPTIONAL) ======
async function sendEmailWithEvidence({ evidence, student, timestamp }) {
  if (!window.emailjs) return;
  if (!evidence) return;

  // Replace with your EmailJS service/template IDs
  // and make sure your template has these variables:
  // {{student_name}} {{roll_no}} {{timestamp}} {{alert_message}} {{evidence_image}}
  return emailjs.send("service_gc6in1q", "template_1gx4dn2", {
    to_email: "swethaarja2005@gmail.com",
    student_name: student.name,
    roll_no: student.roll,
    timestamp,
    alert_message: "Test: Unauthorized slips/papers detected at entry.",
    evidence_image: evidence
  });
}
// ====== UTIL ======
function log(msg) { logEl.textContent = msg; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function lockUI(disabled) {
  el("scanBtn").disabled = disabled;
  el("saveBtn").disabled = disabled;
}