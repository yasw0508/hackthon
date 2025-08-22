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
    const verdict = await scanForPapers({ seconds: 2.0, fps: 4 });
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
  tfModel = await cocoSsd.load();
  log("Model loaded. Ready to scan.");
})();

// ====== SCAN LOOP ======
async function scanForPapers({ seconds = 2, fps = 4 } = {}) {
  const frames = Math.max(1, Math.floor(seconds * fps));
  let detected = false;
  let lastDet = null;

  for (let i = 0; i < frames; i++) {
    const preds = await tfModel.detect(video);
    clearOverlay();
    drawPredictions(preds);

    const classFlag = preds.some(p =>
      UNAUTHORIZED_CLASSES.includes(p.class) && p.score >= 0.55
    );

    const paperFlag = await paperHeuristic();

    if (classFlag || paperFlag) {
      detected = true;
      lastDet = { classFlag, paperFlag, preds };
    }
    await sleep(1000 / fps);
  }

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
const UNAUTHORIZED_CLASSES = ["book", "cell phone", "laptop", "remote", "tv"];

// ====== PAPER HEURISTIC ======
async function paperHeuristic() {
  const w = 224, h = 224;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(video, 0, 0, w, h);

  const y0 = Math.floor(h * 0.45), hh = h - y0;
  const img = tctx.getImageData(0, y0, w, hh);
  const data = img.data;

  let bright = 0;
  const rowSpans = new Array(hh).fill(0);
  for (let y = 0; y < hh; y++) {
    let rowBright = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const br = (r + g + b) / 3;
      if (br > 225) {
        rowBright++;
        bright++;
      }
    }
    rowSpans[y] = rowBright;
  }

  const brightRatio = bright / (w * hh);
  const midStart = Math.floor(hh * 0.20);
  const midEnd   = Math.floor(hh * 0.75);
  let consistentRows = 0;
  for (let y = midStart; y < midEnd; y++) {
    if (rowSpans[y] > w * 0.20) consistentRows++;
  }
  const consistRatio = consistentRows / (midEnd - midStart);
  return (brightRatio > 0.05 && consistRatio > 0.35);
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
    const label = `${p.class} ${(p.score*100).toFixed(0)}%`;
    octx.fillStyle = "rgba(0,0,0,0.5)";
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

// ====== EMAIL ======
async function sendEmailWithEvidence({ evidence, student, timestamp }) {
  if (!window.emailjs || !evidence) return;
  return emailjs.send("YOUR_SERVICE_ID", "YOUR_TEMPLATE_ID", {
    to_email: "swethaarja2005@gmail.com",   // ✅ Principal email
    student_name: student.name,
    roll_no: student.roll,
    timestamp,
    alert_message: "Unauthorized slips/papers detected at entry.",
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
