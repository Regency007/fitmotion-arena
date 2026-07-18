// FitMotion Arena — ระบบตรวจจับท่าสควอตด้วย MediaPipe Pose Landmarker
// ทุกเฟรมถูกประมวลผลบนเบราว์เซอร์ วิดีโอไม่ได้ถูกส่งไปเก็บบนเซิร์ฟเวอร์

const MEDIAPIPE_VERSION = "0.10.35";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODULE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const $ = (selector) => document.querySelector(selector);

const elements = {
  video: $("#webcam"),
  canvas: $("#poseCanvas"),
  cameraButton: $("#cameraButton"),
  matchButton: $("#matchButton"),
  demoButton: $("#demoButton"),
  resetButton: $("#resetButton"),
  placeholder: $("#cameraPlaceholder"),
  cameraStatus: $("#cameraStatus"),
  statusDot: $("#statusDot"),
  formBadge: $("#formBadge"),
  formFeedback: $("#formFeedback"),
  countdown: $("#countdown"),
  timer: $("#timer"),
  timerProgress: $("#timerProgress"),
  repCount: $("#repCount"),
  score: $("#score"),
  youScore: $("#youScore"),
  rivalScore: $("#rivalScore"),
  formScore: $("#formScore"),
  kneeAngle: $("#kneeAngle"),
  roundState: $("#roundState"),
  heroBest: $("#heroBest"),
  toast: $("#toast"),
};

const state = {
  poseLandmarker: null,
  drawingUtils: null,
  poseConnections: null,
  stream: null,
  cameraRunning: false,
  detecting: false,
  lastVideoTime: -1,
  squatPhase: "standing",
  lowestKneeAngle: 180,
  reps: 0,
  score: 0,
  formTotal: 0,
  rivalScore: 0,
  matchRunning: false,
  matchStartedAt: 0,
  matchDuration: 60,
  timerId: null,
  rivalId: null,
};

const canvasContext = elements.canvas.getContext("2d");

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function setCameraStatus(message, type = "idle") {
  elements.cameraStatus.textContent = message;
  elements.statusDot.classList.toggle("active", type === "active");
  elements.statusDot.classList.toggle("error", type === "error");
}

function setFeedback(message, type = "good") {
  elements.formFeedback.textContent = message;
  elements.formBadge.className = `form-badge ${type}`;
}

function updateScoreboard() {
  elements.repCount.textContent = state.reps;
  elements.score.textContent = state.score.toLocaleString("th-TH");
  elements.youScore.textContent = state.score.toLocaleString("th-TH");
  elements.rivalScore.textContent = state.rivalScore.toLocaleString("th-TH");
  elements.formScore.textContent = state.reps
    ? Math.round(state.formTotal / state.reps)
    : "--";
}

function updateBestScore() {
  const currentBest = Number(localStorage.getItem("fitmotion-best") || 0);
  if (state.score > currentBest) {
    localStorage.setItem("fitmotion-best", String(state.score));
    elements.heroBest.textContent = state.score.toLocaleString("th-TH");
    return;
  }
  elements.heroBest.textContent = currentBest.toLocaleString("th-TH");
}

function calculateAngle(pointA, pointB, pointC) {
  const radians =
    Math.atan2(pointC.y - pointB.y, pointC.x - pointB.x) -
    Math.atan2(pointA.y - pointB.y, pointA.x - pointB.x);
  let angle = Math.abs((radians * 180) / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

function landmarkVisibility(point) {
  return point?.visibility ?? 1;
}

function selectVisibleLeg(landmarks) {
  const left = [landmarks[23], landmarks[25], landmarks[27]];
  const right = [landmarks[24], landmarks[26], landmarks[28]];
  const leftVisibility = left.reduce((sum, point) => sum + landmarkVisibility(point), 0);
  const rightVisibility = right.reduce((sum, point) => sum + landmarkVisibility(point), 0);
  return leftVisibility >= rightVisibility ? left : right;
}

function calculateRepQuality(minimumAngle) {
  // ช่วง 75–100° ให้คะแนนสูงสุด ต่ำ/สูงกว่านี้จะถูกหักเล็กน้อย
  if (minimumAngle >= 75 && minimumAngle <= 100) return 100;
  if (minimumAngle < 75) return Math.max(72, Math.round(100 - (75 - minimumAngle) * 1.2));
  return Math.max(65, Math.round(100 - (minimumAngle - 100) * 1.8));
}

function recordRep(quality) {
  state.reps += 1;
  state.formTotal += quality;
  state.score += 70 + quality;
  updateScoreboard();
  updateBestScore();
  setFeedback(`ยอดเยี่ยม! +${70 + quality} คะแนน`, "good");
}

function analyzeSquat(landmarks) {
  const leg = selectVisibleLeg(landmarks);
  if (leg.some((point) => landmarkVisibility(point) < 0.55)) {
    elements.kneeAngle.textContent = "--";
    setFeedback("ถอยให้เห็นขาครบ", "warning");
    return;
  }

  const angle = calculateAngle(leg[0], leg[1], leg[2]);
  elements.kneeAngle.textContent = Math.round(angle);
  state.lowestKneeAngle = Math.min(state.lowestKneeAngle, angle);

  // ต้องย่อต่ำกว่า 105° ก่อน แล้วกลับมายืนเกิน 158° จึงนับ 1 ครั้ง
  if (angle < 105 && state.squatPhase === "standing") {
    state.squatPhase = "down";
    setFeedback(angle < 95 ? "ความลึกกำลังดี" : "ลงอีกนิด", angle < 95 ? "good" : "warning");
  } else if (angle > 158 && state.squatPhase === "down") {
    const quality = calculateRepQuality(state.lowestKneeAngle);
    recordRep(quality);
    state.squatPhase = "standing";
    state.lowestKneeAngle = 180;
  } else if (state.squatPhase === "standing" && angle < 155) {
    setFeedback("ค่อย ๆ ย่อตัว", "warning");
  } else if (state.squatPhase === "standing") {
    setFeedback("พร้อม — เริ่มสควอต", "good");
  } else if (angle < 95) {
    setFeedback("ความลึกกำลังดี", "good");
  }
}

function resizeCanvasToVideo() {
  const width = elements.video.videoWidth || 1280;
  const height = elements.video.videoHeight || 720;
  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
  }
}

function drawPose(landmarks) {
  canvasContext.save();
  canvasContext.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  state.drawingUtils.drawConnectors(landmarks, state.poseConnections, {
    color: "#c7ff31",
    lineWidth: 4,
  });
  state.drawingUtils.drawLandmarks(landmarks, {
    color: "#070b18",
    fillColor: "#c7ff31",
    lineWidth: 2,
    radius: 4,
  });
  canvasContext.restore();
}

async function predictWebcam() {
  if (!state.cameraRunning || !state.poseLandmarker) return;

  if (elements.video.readyState >= 2 && elements.video.currentTime !== state.lastVideoTime) {
    resizeCanvasToVideo();
    state.lastVideoTime = elements.video.currentTime;
    const result = state.poseLandmarker.detectForVideo(elements.video, performance.now());

    if (result.landmarks?.length) {
      drawPose(result.landmarks[0]);
      analyzeSquat(result.landmarks[0]);
    } else {
      canvasContext.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
      elements.kneeAngle.textContent = "--";
      setFeedback("ยืนให้เห็นทั้งตัว", "warning");
    }
  }

  requestAnimationFrame(predictWebcam);
}

async function loadPoseModel() {
  if (state.poseLandmarker) return;
  setCameraStatus("กำลังโหลดระบบจับท่าทาง…", "active");

  const { FilesetResolver, PoseLandmarker, DrawingUtils } = await import(
    /* @vite-ignore */ MODULE_URL
  );
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const sharedOptions = {
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minPosePresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  };

  try {
    state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      ...sharedOptions,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    });
  } catch (gpuError) {
    // บางเครื่องปิด WebGL/GPU ไว้ จึงถอยมาใช้ CPU เพื่อให้เว็บยังเปิดกล้องได้
    console.warn("GPU delegate unavailable, falling back to CPU", gpuError);
    state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      ...sharedOptions,
      baseOptions: { modelAssetPath: MODEL_URL },
    });
  }
  state.drawingUtils = new DrawingUtils(canvasContext);
  state.poseConnections = PoseLandmarker.POSE_CONNECTIONS;
}

async function startCamera() {
  if (state.cameraRunning) {
    stopCamera();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("เบราว์เซอร์นี้ไม่รองรับกล้อง", "error");
    showToast("กรุณาเปิดผ่าน Chrome, Edge หรือ Safari รุ่นใหม่");
    return;
  }

  try {
    elements.cameraButton.disabled = true;
    await loadPoseModel();
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    elements.video.srcObject = state.stream;
    await elements.video.play();
    state.cameraRunning = true;
    elements.placeholder.classList.add("hidden");
    elements.cameraButton.innerHTML = '<span class="button-icon">■</span> ปิดกล้อง';
    elements.matchButton.disabled = false;
    setCameraStatus("กำลังตรวจจับท่าทาง", "active");
    setFeedback("ยืนให้เห็นทั้งตัว", "warning");
    predictWebcam();
  } catch (error) {
    console.error(error);
    const denied = error?.name === "NotAllowedError";
    setCameraStatus(denied ? "ไม่ได้รับอนุญาตใช้กล้อง" : "เปิดกล้องไม่สำเร็จ", "error");
    setFeedback("ตรวจสอบสิทธิ์กล้อง", "error");
    showToast(
      denied
        ? "กดอนุญาตใช้กล้องที่แถบที่อยู่ แล้วลองอีกครั้ง"
        : "โหลดระบบไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่",
    );
  } finally {
    elements.cameraButton.disabled = false;
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.cameraRunning = false;
  elements.video.srcObject = null;
  elements.placeholder.classList.remove("hidden");
  elements.cameraButton.innerHTML = '<span class="button-icon">●</span> เปิดกล้อง';
  elements.matchButton.disabled = true;
  canvasContext.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  setCameraStatus("ปิดกล้องแล้ว");
  setFeedback("รอเริ่ม");
}

function resetScores(showMessage = true) {
  state.reps = 0;
  state.score = 0;
  state.formTotal = 0;
  state.rivalScore = 0;
  state.squatPhase = "standing";
  state.lowestKneeAngle = 180;
  elements.kneeAngle.textContent = "--";
  updateScoreboard();
  if (showMessage) showToast("รีเซ็ตคะแนนแล้ว");
}

function finishMatch() {
  state.matchRunning = false;
  window.clearInterval(state.timerId);
  window.clearInterval(state.rivalId);
  elements.matchButton.disabled = !state.cameraRunning;
  elements.matchButton.textContent = "เริ่มแมตช์ใหม่";
  elements.roundState.textContent = state.score >= state.rivalScore ? "คุณชนะ!" : "ลองอีกครั้ง";
  elements.timer.textContent = "0s";
  elements.timerProgress.style.width = "0%";
  updateBestScore();
  showToast(state.score >= state.rivalScore ? "จบแมตช์ — คุณชนะ MoveBot!" : "จบแมตช์ — อีกนิดเดียว ลองใหม่ได้เลย");
}

function startMatchClock() {
  state.matchRunning = true;
  state.matchStartedAt = Date.now();
  elements.roundState.textContent = "กำลังแข่งขัน";
  elements.matchButton.textContent = "กำลังแข่งขัน…";
  elements.matchButton.disabled = true;

  state.timerId = window.setInterval(() => {
    const elapsed = (Date.now() - state.matchStartedAt) / 1000;
    const left = Math.max(0, Math.ceil(state.matchDuration - elapsed));
    elements.timer.innerHTML = `${left}<span>s</span>`;
    elements.timerProgress.style.width = `${(left / state.matchDuration) * 100}%`;
    if (left <= 0) finishMatch();
  }, 250);

  // คู่แข่งจำลองจะเพิ่มคะแนนในจังหวะสุ่ม เพื่อให้หน้าจอแข่งขันมีแรงกดดัน
  state.rivalId = window.setInterval(() => {
    if (!state.matchRunning) return;
    state.rivalScore += 105 + Math.floor(Math.random() * 45);
    updateScoreboard();
  }, 3700 + Math.random() * 1400);
}

async function startMatch() {
  if (state.matchRunning) return;
  resetScores(false);
  elements.timer.innerHTML = '60<span>s</span>';
  elements.timerProgress.style.width = "100%";
  elements.countdown.hidden = false;

  for (const value of [3, 2, 1]) {
    elements.countdown.textContent = value;
    await new Promise((resolve) => window.setTimeout(resolve, 700));
  }
  elements.countdown.textContent = "GO!";
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  elements.countdown.hidden = true;
  startMatchClock();
}

function addDemoRep() {
  const quality = 82 + Math.floor(Math.random() * 19);
  recordRep(quality);
  elements.kneeAngle.textContent = 82 + Math.floor(Math.random() * 15);
  showToast("เพิ่มสควอตทดลอง 1 ครั้ง");
}

elements.cameraButton.addEventListener("click", startCamera);
elements.matchButton.addEventListener("click", startMatch);
elements.demoButton.addEventListener("click", addDemoRep);
elements.resetButton.addEventListener("click", () => resetScores(true));

window.addEventListener("pagehide", () => {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.poseLandmarker?.close?.();
});

updateBestScore();
updateScoreboard();
