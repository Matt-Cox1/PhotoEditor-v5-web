const PRESERVATION =
  "Edit this exact photograph as a photographic color-and-light reference. Preserve the camera viewpoint, aspect ratio, framing, geometry, every real subject, object, facial identity, texture and detail. Do not add, remove, move or invent anything. Keep every subject silhouette, limb, facial feature and background landmark at exactly its input position; do not reconstruct anatomy or change poses. Do not add text, borders, new light sources or artificial sky detail. Use only changes achievable with white balance, exposure, curves, color grading and soft local tonal adjustments. Keep believable highlights, shadow depth and natural color; avoid halos, oversaturation and HDR effects.";

const PROMPT_MODEL = "gpt-5.6-luna";
const IMAGE_MODEL = "gpt-image-2.5-flare";
const IMAGE_QUALITY = "medium";
const GENERATE_MAX = 1536;
const DENOISE_MAX = 1536;
const FIT_MAX = 720;
const DISPLAY_MAX = 1600;
const OPENAI = "https://api.openai.com/v1";
const API_KEY_STORAGE = "photoeditor.openai.apiKey.v1";

const photoInput = document.getElementById("photo");
const autoEditButton = document.getElementById("autoEdit");
const advancedControls = document.getElementById("advancedControls");
const menuOpen = document.getElementById("menuOpen");
const menuSave = document.getElementById("menuSave");
const menuAutoEdit = document.getElementById("menuAutoEdit");
const menuAdvanced = document.getElementById("menuAdvanced");
const menuZoomIn = document.getElementById("menuZoomIn");
const menuZoomOut = document.getElementById("menuZoomOut");
const menuZoomReset = document.getElementById("menuZoomReset");
const referenceInput = document.getElementById("reference");
const apiKeyInput = document.getElementById("apiKey");
const rememberKey = document.getElementById("rememberKey");
const clearKey = document.getElementById("clearKey");
const checkConnection = document.getElementById("checkConnection");
const intentInput = document.getElementById("intent");
const photoMeta = document.getElementById("photoMeta");
const referenceMeta = document.getElementById("referenceMeta");
const referenceDrop = document.getElementById("referenceDrop");
const denoiseMode = document.getElementById("denoiseMode");
const generateButton = document.getElementById("generate");
const matchButton = document.getElementById("match");
const denoiseButton = document.getElementById("denoise");
const saveButton = document.getElementById("save");
const strengthInput = document.getElementById("strength");
const strengthValue = document.getElementById("strengthValue");
const wipeInput = document.getElementById("wipe");
const statusEl = document.getElementById("status");
const photoCanvas = document.getElementById("photoCanvas");
const referenceCanvas = document.getElementById("referenceCanvas");
const beforeCanvas = document.getElementById("beforeCanvas");
const afterCanvas = document.getElementById("afterCanvas");
const wipeDivider = document.getElementById("wipeDivider");
const compare = document.getElementById("compare");
const compareStage = document.getElementById("compareStage");
const zoomOut = document.getElementById("zoomOut");
const zoomIn = document.getElementById("zoomIn");
const zoomReset = document.getElementById("zoomReset");
const zoomValue = document.getElementById("zoomValue");
const workEl = document.getElementById("work");
const workLabel = document.getElementById("workLabel");
const workBar = document.getElementById("workBar");
const cancelWork = document.getElementById("cancelWork");

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const denoiseWorker = new Worker(
  new URL("./denoise_worker.js?v=denoise-16", import.meta.url),
  { type: "module" },
);

const state = {
  photo: null,
  reference: null,
  recipe: null,
  result: null,
  beforePreview: null,
  denoised: false,
  workerReady: false,
  busy: false,
};

let pending = null;
let denoisePending = null;
let strengthTimer = 0;
let activeRequestController = null;
let cancelRequested = false;
let viewerZoom = 1;
let viewerPanX = 0;
let viewerPanY = 0;
let panPointer = null;
const viewerPointers = new Map();
let pinchState = null;

worker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "ready") {
    state.workerReady = true;
    updateButtons();
    return;
  }
  if (message.type === "progress") {
    const step = Number(message.step) || 0;
    setWork(`Fitting V5… step ${step} of 5`, 20 + step * 12);
    return;
  }
  if (pending) {
    if (message.type === "error") {
      pending.reject(new Error(message.message));
    } else {
      pending.resolve(message);
    }
    pending = null;
  }
};

worker.onerror = (event) => {
  const message = event.message || "The fit worker failed. Run scripts/build_web.sh and serve this folder over HTTP.";
  if (pending) {
    pending.reject(new Error(message));
    pending = null;
  } else {
    setStatus(message);
  }
};

denoiseWorker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "status") {
    setWork(message.message);
    return;
  }
  if (message.type === "progress") {
    setWork(
      `Denoising locally… tile ${message.completed} of ${message.total} · ${message.alignment}px windows`,
      message.percent,
    );
    return;
  }
  if (!denoisePending) {
    return;
  }
  if (message.type === "error") {
    denoisePending.reject(new Error(message.message));
  } else {
    denoisePending.resolve(message);
  }
  denoisePending = null;
};

denoiseWorker.onerror = (event) => {
  const message =
    event.message ||
    "The denoise worker failed. Reload the page and try again.";
  if (denoisePending) {
    denoisePending.reject(new Error(message));
    denoisePending = null;
  } else {
    setStatus(message);
  }
};

worker.postMessage({ type: "init" });

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) {
    return;
  }
  await run(async () => {
    setWork("Loading photo…", 20);
    state.photo = await loadRaster(file);
    state.beforePreview = resizeRaster(state.photo, DISPLAY_MAX);
    state.recipe = null;
    state.result = null;
    state.denoised = false;
    photoMeta.textContent = `${formatDimensions(state.photo)} · ready`;
    setCompareAspect(state.beforePreview);
    drawRaster(photoCanvas, state.photo);
    drawRaster(beforeCanvas, state.beforePreview);
    clearCanvas(afterCanvas);
    resetViewer();
    setWork("Photo loaded", 100);
    setStatus("Photo loaded. Generate a reference or drop one, then match.");
  });
});

referenceInput.addEventListener("change", async () => {
  const file = referenceInput.files[0];
  if (!file) {
    return;
  }
  await run(async () => {
    setWork("Loading reference…", 40);
    await setReference(await loadRaster(file), "Loaded reference from disk.");
  });
});

for (const eventName of ["dragenter", "dragover"]) {
  referenceDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    referenceDrop.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  referenceDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    referenceDrop.classList.remove("is-dragging");
  });
}

compare.addEventListener("dragover", (event) => event.preventDefault());
document.body.addEventListener("dragover", (event) => event.preventDefault());
document.body.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith("image/")) {
    return;
  }
  if (!state.photo) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    photoInput.files = transfer.files;
    photoInput.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  await run(async () => {
    setWork("Loading dropped reference…", 40);
    await setReference(await loadRaster(file), "Loaded dropped reference.");
  });
});

generateButton.addEventListener("click", () => run(generateReference));
autoEditButton.addEventListener("click", () => run(autoEdit));
matchButton.addEventListener("click", () => run(matchPhoto));
denoiseButton.addEventListener("click", () => run(denoisePhoto));
saveButton.addEventListener("click", () => run(savePng));
strengthInput.addEventListener("input", () => {
  strengthValue.textContent = `${Math.round(Number(strengthInput.value) * 100)}%`;
  if (!state.recipe || !state.photo) {
    return;
  }
  window.clearTimeout(strengthTimer);
  strengthTimer = window.setTimeout(() => {
    run(applyStrength);
  }, 150);
});
wipeInput.addEventListener("input", () => {
  updateWipe();
});
zoomOut.addEventListener("click", () => setViewerZoom(viewerZoom - 0.25));
zoomIn.addEventListener("click", () => setViewerZoom(viewerZoom + 0.25));
zoomReset.addEventListener("click", () => setViewerZoom(1));
menuOpen.addEventListener("click", () => photoInput.click());
menuSave.addEventListener("click", () => run(savePng));
menuAutoEdit.addEventListener("click", () => run(autoEdit));
menuAdvanced.addEventListener("click", () => {
  advancedControls.open = true;
  advancedControls.scrollIntoView({ behavior: "smooth", block: "start" });
});
menuZoomIn.addEventListener("click", () => setViewerZoom(viewerZoom + 0.25));
menuZoomOut.addEventListener("click", () => setViewerZoom(viewerZoom - 0.25));
menuZoomReset.addEventListener("click", () => setViewerZoom(1));
cancelWork.addEventListener("click", () => {
  if (activeRequestController) {
    cancelRequested = true;
    activeRequestController.abort();
    setStatus("Cancelling the OpenAI request…");
  }
});
compare.addEventListener("wheel", (event) => {
  if (!state.result) {
    return;
  }
  event.preventDefault();
  const rect = compare.getBoundingClientRect();
  const direction = event.deltaY < 0 ? 0.25 : -0.25;
  setViewerZoom(viewerZoom + direction, event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });
compare.addEventListener("pointerdown", (event) => {
  if (event.target.closest("input, button")) {
    return;
  }
  viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  compare.setPointerCapture(event.pointerId);
  if (viewerPointers.size === 2) {
    const [first, second] = viewerPointers.values();
    pinchState = {
      distance: pointerDistance(first, second),
      zoom: viewerZoom,
    };
    panPointer = null;
    compare.classList.add("is-panning");
    return;
  }
  if (viewerZoom <= 1) {
    return;
  }
  panPointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX: viewerPanX,
    panY: viewerPanY,
  };
  compare.classList.add("is-panning");
});
compare.addEventListener("pointermove", (event) => {
  if (viewerPointers.has(event.pointerId)) {
    viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  if (pinchState && viewerPointers.size >= 2) {
    const [first, second] = viewerPointers.values();
    setViewerZoom(
      pinchState.zoom * pointerDistance(first, second) / pinchState.distance,
    );
    return;
  }
  if (!panPointer || event.pointerId !== panPointer.id) {
    return;
  }
  viewerPanX = panPointer.panX + event.clientX - panPointer.x;
  viewerPanY = panPointer.panY + event.clientY - panPointer.y;
  applyViewerTransform();
});
compare.addEventListener("pointerup", endViewerPan);
compare.addEventListener("pointercancel", endViewerPan);

function updateButtons() {
  const hasPhoto = Boolean(state.photo);
  autoEditButton.disabled = state.busy || !hasPhoto;
  menuAutoEdit.disabled = state.busy || !hasPhoto;
  menuSave.disabled = state.busy || !state.result;
  const hasResult = Boolean(state.result);
  generateButton.disabled = state.busy || !hasPhoto || !apiKeyInput.value.trim();
  matchButton.disabled = state.busy || !hasPhoto || !state.reference || !state.workerReady;
  denoiseButton.disabled = state.busy || !hasPhoto || state.denoised;
  strengthInput.disabled = state.busy || !state.recipe;
  saveButton.disabled = state.busy || !hasResult;
  compare.dataset.hasResult = hasResult ? "true" : "false";
  wipeInput.disabled = !hasResult;
  clearKey.disabled = !rememberKey.checked || !apiKeyInput.value.trim();
  checkConnection.disabled = state.busy || !apiKeyInput.value.trim();
  zoomOut.disabled = !hasResult || viewerZoom <= 1;
  zoomIn.disabled = !hasResult || viewerZoom >= 3;
  zoomReset.disabled = !hasResult || viewerZoom === 1;
  updateWipe();
}

apiKeyInput.addEventListener("input", () => {
  if (rememberKey.checked) {
    persistApiKey();
  }
  updateButtons();
});
rememberKey.addEventListener("change", () => {
  if (rememberKey.checked) {
    persistApiKey();
  } else {
    removePersistedApiKey();
  }
  updateButtons();
});
clearKey.addEventListener("click", () => {
  removePersistedApiKey();
  apiKeyInput.value = "";
  rememberKey.checked = false;
  updateButtons();
  setStatus("Saved API key cleared from this browser.");
});
checkConnection.addEventListener("click", () => run(checkOpenAiConnection));
restoreApiKey();
updateButtons();

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.dataset.state = "info";
}

function restoreApiKey() {
  try {
    const saved = localStorage.getItem(API_KEY_STORAGE);
    if (saved) {
      apiKeyInput.value = saved;
      rememberKey.checked = true;
    }
  } catch {
    setStatus("This browser does not allow remembered keys. You can still enter one for this session.");
  }
}

function persistApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) {
    removePersistedApiKey();
    return;
  }
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    rememberKey.checked = false;
    setStatus("This browser could not store the API key. It remains available for this session only.");
  }
}

function removePersistedApiKey() {
  try {
    localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Storage can be unavailable in private or restricted browser modes.
  }
}

function setWork(label, percent) {
  workEl.hidden = false;
  workLabel.textContent = label;
  cancelWork.disabled = !activeRequestController;
  setStatus(label);
  if (percent == null || Number.isNaN(percent)) {
    workBar.removeAttribute("value");
  } else {
    workBar.max = 100;
    workBar.value = Math.max(0, Math.min(100, percent));
  }
}

function setViewerZoom(value, anchorX = null, anchorY = null) {
  const previousZoom = viewerZoom;
  const nextZoom = Math.max(1, Math.min(3, Math.round(value * 4) / 4));
  if (anchorX != null && anchorY != null && nextZoom !== previousZoom) {
    const rect = compare.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const worldX = (anchorX - centerX - viewerPanX) / previousZoom;
    const worldY = (anchorY - centerY - viewerPanY) / previousZoom;
    viewerPanX = anchorX - centerX - worldX * nextZoom;
    viewerPanY = anchorY - centerY - worldY * nextZoom;
  }
  viewerZoom = nextZoom;
  clampViewerPan();
  applyViewerTransform();
  updateButtons();
}

function applyViewerTransform() {
  compareStage.style.transform =
    `translate3d(${viewerPanX}px, ${viewerPanY}px, 0) scale(${viewerZoom})`;
  zoomValue.textContent = `${Math.round(viewerZoom * 100)}%`;
}

function updateWipe() {
  const percent = state.result ? Number(wipeInput.value) : 100;
  beforeCanvas.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
  wipeDivider.style.left = `${percent}%`;
}

function clampViewerPan() {
  const viewportWidth = compare.clientWidth;
  const viewportHeight = compare.clientHeight;
  const stageWidth = compareStage.offsetWidth;
  const stageHeight = compareStage.offsetHeight;
  const maxX = Math.max(0, (stageWidth * viewerZoom - viewportWidth) / 2);
  const maxY = Math.max(0, (stageHeight * viewerZoom - viewportHeight) / 2);
  viewerPanX = Math.max(-maxX, Math.min(maxX, viewerPanX));
  viewerPanY = Math.max(-maxY, Math.min(maxY, viewerPanY));
}

function resetViewer() {
  viewerZoom = 1;
  viewerPanX = 0;
  viewerPanY = 0;
  applyViewerTransform();
  updateButtons();
}

function endViewerPan(event) {
  viewerPointers.delete(event.pointerId);
  if (viewerPointers.size < 2) {
    pinchState = null;
  }
  if (!panPointer || event.pointerId !== panPointer.id) {
    if (viewerPointers.size === 0) {
      compare.classList.remove("is-panning");
    }
    return;
  }
  panPointer = null;
  compare.classList.remove("is-panning");
  if (compare.hasPointerCapture(event.pointerId)) {
    compare.releasePointerCapture(event.pointerId);
  }
}

function pointerDistance(first, second) {
  return Math.max(
    1,
    Math.hypot(second.x - first.x, second.y - first.y),
  );
}

function hideWork() {
  workEl.hidden = true;
  workBar.removeAttribute("value");
  cancelWork.disabled = true;
}

async function run(task) {
  if (state.busy) {
    return;
  }
  state.busy = true;
  updateButtons();
  setWork("Working…");
  try {
    await task();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    statusEl.dataset.state = "error";
  } finally {
    hideWork();
    state.busy = false;
    updateButtons();
  }
}

async function setReference(raster, message) {
  if (state.photo) {
    assertAspect(state.photo, raster);
  }
  state.reference = raster;
  state.recipe = null;
  state.result = state.denoised ? state.photo : null;
  drawRaster(referenceCanvas, raster);
  referenceMeta.textContent = `${formatDimensions(raster)} · ready`;
  clearCanvas(afterCanvas);
  if (state.result) {
    drawRaster(afterCanvas, state.result);
  }
  updateButtons();
  setStatus(message);
}

function setCompareAspect(raster) {
  if (!raster) {
    compare.style.removeProperty("aspect-ratio");
    return;
  }
  compare.style.aspectRatio = `${raster.width} / ${raster.height}`;
}

async function generateReference() {
  if (!state.photo) {
    throw new Error("Load a photo first.");
  }
  const key = apiKeyInput.value.trim();
  if (!key) {
    throw new Error("Enter your OpenAI API key. It stays in this tab.");
  }
  setWork("Preparing a preview for OpenAI…", 10);
  const preview = resizeRaster(state.photo, GENERATE_MAX);
  const png = await rasterToPng(preview);
  setWork("Writing the reference prompt… (up to 90 seconds)");
  const prompt = await writePrompt(png, intentInput.value, key);
  setWork("Generating the AI target reference…");
  const imagePng = await editImage(png, prompt, key);
  setWork("Loading the generated reference…", 90);
  const raster = await pngToRaster(imagePng);
  await setReference(raster, "Generated reference is ready. Match color and light next.");
}

async function checkOpenAiConnection() {
  const key = apiKeyInput.value.trim();
  if (!key) {
    throw new Error("Enter an OpenAI API key first.");
  }
  setWork("Checking the OpenAI connection…", 25);
  const response = await openaiFetch(
    `${OPENAI}/models`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    },
    20_000,
  );
  if (!response.ok) {
    throw new Error(openaiMessage(response.status));
  }
  setWork("OpenAI connection is working.", 100);
  setStatus("OpenAI connection is working. No photo was sent.");
}

async function autoEdit() {
  if (!state.photo) {
    throw new Error("Load a photo first.");
  }
  const hasKey = Boolean(apiKeyInput.value.trim());
  if (hasKey && !state.reference) {
    const approved = window.confirm(
      "Auto Edit will send a resized photo preview to OpenAI. Your API account may be charged. Continue?",
    );
    if (!approved) {
      setStatus("Auto Edit cancelled before the OpenAI request.");
      return;
    }
  }
  if (!state.reference && hasKey) {
    await generateReference();
  }
  if (state.reference) {
    await matchPhoto();
  } else {
    throw new Error("Auto Edit needs an API key or a reference image. Denoise is available separately in Advanced controls.");
  }
}

async function matchPhoto() {
  if (!state.photo || !state.reference) {
    throw new Error("Need a photo and a reference.");
  }
  assertAspect(state.photo, state.reference);
  setWork("Preparing images for V5…", 12);
  const fitted = pairForFit(state.photo, state.reference);
  setWork("Fitting V5 on this device…", 20);
  const recipeMessage = await callWorker({
    type: "fit",
    width: fitted.width,
    height: fitted.height,
    source: fitted.source,
    target: fitted.target,
  });
  state.recipe = recipeMessage.recipe;
  await applyStrength();
}

async function denoisePhoto() {
  if (!state.photo) {
    throw new Error("Load a photo first.");
  }
  const fullResolution = denoiseMode.value === "full";
  const working = fullResolution ? state.photo : resizeRaster(state.photo, DENOISE_MAX);
  setWork(
    fullResolution
      ? "Running full-resolution SCUNet tiles…"
      : `Preparing a ${DENOISE_MAX}px denoise copy…`,
    5,
  );
  const message = await callDenoise({
    type: "denoise",
    width: working.width,
    height: working.height,
    values: fullResolution ? working.values.slice() : working.values,
    strength: 1,
  }, fullResolution);
  if (fullResolution) {
    state.photo = {
      width: message.width,
      height: message.height,
      values: message.values,
    };
  } else {
    setWork("Upsampling the denoise correction to the original size…", 92);
    state.photo = applyDenoiseResidual(state.photo, working, {
      width: message.width,
      height: message.height,
      values: message.values,
    });
  }
  state.denoised = true;
  state.result = state.photo;
  photoMeta.textContent = `${formatDimensions(state.photo)} · denoised locally`;
  state.recipe = null;
  drawRaster(photoCanvas, state.photo);
  drawRaster(beforeCanvas, state.beforePreview);
  drawRaster(afterCanvas, state.result);
  resetViewer();
  setWork(
    `Denoise finished using ${message.backend} · ${fullResolution ? "full resolution" : "fast preview"}.`,
    100,
  );
  setStatus(
    `Denoise finished using ${message.backend}. The cleaned photo stays on this device.`,
  );
}

async function applyStrength() {
  if (!state.photo || !state.recipe) {
    throw new Error("Match a reference before adjusting strength.");
  }
  const strength = Number(strengthInput.value);
  setWork("Applying the V5 recipe…", 88);
  const imageMessage = await callWorker({
    type: "apply",
    width: state.photo.width,
    height: state.photo.height,
    source: state.photo.values,
    recipe: state.recipe,
    strength,
  });
  state.result = {
    width: imageMessage.width,
    height: imageMessage.height,
    values: imageMessage.values,
  };
  drawRaster(afterCanvas, state.result);
  drawRaster(beforeCanvas, state.beforePreview);
  resetViewer();
  updateWipe();
  setWork("Match finished", 100);
  setStatus("Match finished. Save PNG exports the auto-edited photo.");
}

async function savePng() {
  if (!state.result) {
    throw new Error("Match a photo first.");
  }
  setWork("Encoding PNG…", 60);
  const blob = await rasterToPng(state.result);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "photoeditor-v5.png";
  link.click();
  URL.revokeObjectURL(url);
  setWork("Saved", 100);
  setStatus("Saved photoeditor-v5.png.");
}

function callWorker(message) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage(message);
  });
}

function callDenoise(message, transferSource = false) {
  return new Promise((resolve, reject) => {
    denoisePending = { resolve, reject };
    if (transferSource) {
      denoiseWorker.postMessage(message, [message.values.buffer]);
    } else {
      denoiseWorker.postMessage(message);
    }
  });
}

function applyDenoiseResidual(full, lowSource, lowDenoised) {
  const residual = new Float32Array(lowDenoised.values.length);
  const lowLuma = new Float32Array(lowSource.width * lowSource.height);
  for (let pixel = 0; pixel < lowSource.width * lowSource.height; pixel += 1) {
    const offset = pixel * 3;
    residual[offset] =
      srgbDecode(lowDenoised.values[offset]) - srgbDecode(lowSource.values[offset]);
    residual[offset + 1] =
      srgbDecode(lowDenoised.values[offset + 1]) -
      srgbDecode(lowSource.values[offset + 1]);
    residual[offset + 2] =
      srgbDecode(lowDenoised.values[offset + 2]) -
      srgbDecode(lowSource.values[offset + 2]);
    lowLuma[pixel] = luminance(lowSource.values, offset);
  }

  const values = new Float32Array(full.values.length);
  for (let y = 0; y < full.height; y += 1) {
    const lowY = (y / Math.max(1, full.height - 1)) * (lowSource.height - 1);
    const y0 = Math.floor(lowY);
    const y1 = Math.min(lowSource.height - 1, y0 + 1);
    for (let x = 0; x < full.width; x += 1) {
      const lowX = (x / Math.max(1, full.width - 1)) * (lowSource.width - 1);
      const x0 = Math.floor(lowX);
      const x1 = Math.min(lowSource.width - 1, x0 + 1);
      const fullOffset = (y * full.width + x) * 3;
      const fullLuma = luminance(full.values, fullOffset);
      const samples = [
        [x0, y0, (1 - (lowX - x0)) * (1 - (lowY - y0))],
        [x1, y0, (lowX - x0) * (1 - (lowY - y0))],
        [x0, y1, (1 - (lowX - x0)) * (lowY - y0)],
        [x1, y1, (lowX - x0) * (lowY - y0)],
      ];
      const correction = [0, 0, 0];
      let totalWeight = 0;
      for (const [sampleX, sampleY, spatialWeight] of samples) {
        const samplePixel = sampleY * lowSource.width + sampleX;
        const edgeWeight =
          spatialWeight *
          Math.exp(-4 * Math.abs(fullLuma - lowLuma[samplePixel]));
        const residualOffset = samplePixel * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          correction[channel] += edgeWeight * residual[residualOffset + channel];
        }
        totalWeight += edgeWeight;
      }
      const originalLinear = [
        srgbDecode(full.values[fullOffset]),
        srgbDecode(full.values[fullOffset + 1]),
        srgbDecode(full.values[fullOffset + 2]),
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        values[fullOffset + channel] = srgbEncode(
          originalLinear[channel] + correction[channel] / Math.max(totalWeight, 1e-8),
        );
      }
    }
  }
  return { width: full.width, height: full.height, values };
}

function srgbDecode(value) {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function srgbEncode(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function luminance(values, offset) {
  return (
    0.2126 * srgbDecode(values[offset]) +
    0.7152 * srgbDecode(values[offset + 1]) +
    0.0722 * srgbDecode(values[offset + 2])
  );
}

function assertAspect(photo, reference) {
  const photoAspect = photo.width / photo.height;
  const referenceAspect = reference.width / reference.height;
  if (Math.abs(Math.log(photoAspect / referenceAspect)) >= 0.05) {
    throw new Error("Choose a reference with the same composition and aspect ratio.");
  }
}

function pairForFit(photo, reference) {
  const size = fitSize(photo.width, photo.height, FIT_MAX);
  const source = resizeRaster(photo, FIT_MAX);
  const target = resizeTo(reference, size.width, size.height);
  return { width: size.width, height: size.height, source: source.values, target: target.values };
}

async function loadRaster(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!context) {
    throw new Error("This browser cannot read the image into a canvas.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return imageDataToRaster(context.getImageData(0, 0, canvas.width, canvas.height));
}

function imageDataToRaster(imageData) {
  const values = new Float32Array(imageData.width * imageData.height * 3);
  const pixels = imageData.data;
  for (let i = 0, o = 0; i < pixels.length; i += 4, o += 3) {
    values[o] = pixels[i] / 255;
    values[o + 1] = pixels[i + 1] / 255;
    values[o + 2] = pixels[i + 2] / 255;
  }
  return { width: imageData.width, height: imageData.height, values };
}

function rasterToImageData(raster) {
  const imageData = new ImageData(raster.width, raster.height);
  const pixels = imageData.data;
  for (let i = 0, o = 0; o < pixels.length; i += 3, o += 4) {
    pixels[o] = Math.round(clamp01(raster.values[i]) * 255);
    pixels[o + 1] = Math.round(clamp01(raster.values[i + 1]) * 255);
    pixels[o + 2] = Math.round(clamp01(raster.values[i + 2]) * 255);
    pixels[o + 3] = 255;
  }
  return imageData;
}

function drawRaster(canvas, raster) {
  const display = resizeRaster(raster, DISPLAY_MAX);
  canvas.width = display.width;
  canvas.height = display.height;
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!context) {
    throw new Error("This browser cannot draw the image.");
  }
  context.putImageData(rasterToImageData(display), 0, 0);
}

function clearCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}

function fitSize(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function resizeRaster(raster, maxDimension) {
  const size = fitSize(raster.width, raster.height, maxDimension);
  return resizeTo(raster, size.width, size.height);
}

function resizeTo(raster, width, height) {
  if (raster.width === width && raster.height === height) {
    return { width, height, values: raster.values.slice() };
  }
  const source = document.createElement("canvas");
  source.width = raster.width;
  source.height = raster.height;
  const sourceContext = source.getContext("2d", { colorSpace: "srgb" });
  const dest = document.createElement("canvas");
  dest.width = width;
  dest.height = height;
  const destContext = dest.getContext("2d", { colorSpace: "srgb" });
  if (!sourceContext || !destContext) {
    throw new Error("This browser cannot resize the image.");
  }
  sourceContext.putImageData(rasterToImageData(raster), 0, 0);
  destContext.imageSmoothingEnabled = true;
  destContext.imageSmoothingQuality = "high";
  destContext.drawImage(source, 0, 0, width, height);
  return imageDataToRaster(destContext.getImageData(0, 0, width, height));
}

function rasterToPng(raster) {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!context) {
    throw new Error("This browser cannot encode PNG.");
  }
  context.putImageData(rasterToImageData(raster), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PNG encode failed."));
      }
    }, "image/png");
  });
}

async function pngToRaster(bytes) {
  const blob = new Blob([bytes], { type: "image/png" });
  return loadRaster(blob);
}

function formatDimensions(raster) {
  return `${raster.width.toLocaleString()} × ${raster.height.toLocaleString()} px`;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function isCorsFailure(error) {
  return error instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(String(error));
}

function openaiMessage(status) {
  if (status === 401) {
    return "OpenAI rejected the API key.";
  }
  if (status === 403) {
    return "This OpenAI project does not have permission to use the selected model.";
  }
  if (status === 429) {
    return "OpenAI quota or rate limit reached. Check API billing and limits, then retry.";
  }
  if (status >= 500) {
    return `OpenAI request failed (HTTP ${status}). Retry when ready.`;
  }
  return `OpenAI rejected the request (HTTP ${status}).`;
}

async function openaiFetch(url, options, timeoutMs = 90_000) {
  const controller = new AbortController();
  activeRequestController = controller;
  cancelWork.disabled = false;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        cancelRequested
          ? "The OpenAI request was cancelled."
          : "OpenAI did not respond within the time limit. Check the connection and try again.",
      );
    }
    if (isCorsFailure(error)) {
      throw new Error(
        "The browser blocked the OpenAI request (CORS or network). Drop a reference image instead. Match still runs on this device."
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    activeRequestController = null;
    cancelWork.disabled = true;
    cancelRequested = false;
  }
  return response;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

async function writePrompt(png, intent, key) {
  const intentText = intent.trim()
    ? intent.trim()
    : "Make this photograph striking and beautifully finished, with a restrained, natural photographic treatment suited to its actual scene.";
  const imageB64 = await blobToBase64(png);
  const body = {
    model: PROMPT_MODEL,
    store: false,
    max_output_tokens: 4096,
    text: {
      format: {
        type: "json_schema",
        name: "reference_prompt",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "file_name"],
          properties: {
            prompt: { type: "string" },
            file_name: { type: "string" },
          },
        },
      },
    },
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: `You are an expert photographic retoucher. Inspect the supplied photo and write a concise, specific image-editing prompt (under 250 words) and a short human-readable file name for the finished photograph. The file name must be 2 to 5 lowercase words joined by underscores, describing the scene (for example misty_geese_at_river), with no extension, no dates and no camera codes. Identify its light, subject and tonal opportunities. Honor the user's requested mood, color, contrast, and photographic style explicitly; do not omit or soften those requests. Use a restrained, natural treatment only when the user gives no desired look. Stay within these constraints: ${PRESERVATION}`,
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: intentText },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${imageB64}`,
            detail: "high",
          },
        ],
      },
    ],
  };

  let lastMessage = "Prompt writing failed.";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await openaiFetch(`${OPENAI}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (retryableStatus(response.status)) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(60, Math.max(0, retryAfter)) * 1000
        : (2 ** attempt + Math.random() * 0.25) * 1000;
      lastMessage = openaiMessage(response.status);
      setWork(`Retrying prompt in ${Math.ceil(waitMs / 1000)}s · attempt ${attempt + 2} of 4…`);
      await sleep(waitMs);
      continue;
    }
    if (!response.ok) {
      throw new Error(openaiMessage(response.status));
    }
    const json = await response.json();
    if (json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens") {
      body.max_output_tokens = 8192;
      lastMessage = "The prompt reached its output limit.";
      continue;
    }
    if (json.status !== "completed") {
      throw new Error("OpenAI did not complete the reference prompt. Check the requested look and try again.");
    }
    const text = (json.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("OpenAI returned a reference prompt in an unexpected format.");
    }
    const photographic = (payload.prompt || "").trim();
    if (!photographic) {
      throw new Error("OpenAI returned a reference prompt in an unexpected format.");
    }
    const requested = intent.trim();
    const intentSection = requested ? `\n\nUser desired look (verbatim):\n${requested}` : "";
    return `${PRESERVATION}${intentSection}\n\nPhotographic treatment:\n${photographic}`;
  }
  throw new Error(`${lastMessage} Tried 4 times; please retry later.`);
}

async function editImage(png, prompt, key) {
  const form = new FormData();
  form.append("model", IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", "auto");
  form.append("quality", IMAGE_QUALITY);
  form.append("output_format", "png");
  form.append("image[]", png, "photo.png");
  const response = await openaiFetch(`${OPENAI}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  }, 300_000);
  if (!response.ok) {
    throw new Error(openaiMessage(response.status));
  }
  const json = await response.json();
  const encoded = json.data?.[0]?.b64_json;
  if (!encoded) {
    throw new Error("OpenAI returned no usable reference image.");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
