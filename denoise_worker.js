import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.bundle.min.mjs";

const MODEL_URL = new URL(
  "./models/scunet_color_real_psnr_single.onnx",
  self.location.href,
).href;
const CORE = 256;
const CONTEXT = 64;

let sessionPromise;

self.onmessage = async (event) => {
  try {
    if (event.data.type !== "denoise") {
      throw new Error(`Unknown denoise worker message: ${event.data.type}`);
    }
    const result = await denoise(
      event.data.width,
      event.data.height,
      event.data.values,
      event.data.strength,
    );
    self.postMessage(
      {
        type: "image",
        width: result.width,
        height: result.height,
        values: result.values,
        backend: result.backend,
      },
      [result.values.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

async function denoise(width, height, source, strength) {
  const session = await getSession();
  const output = new Float32Array(source.length);
  const columns = Math.ceil(width / CORE);
  const rows = Math.ceil(height / CORE);
  const total = columns * rows;
  let completed = 0;

  for (let y = 0; y < height; y += CORE) {
    for (let x = 0; x < width; x += CORE) {
      const x1 = Math.min(width, x + CORE);
      const y1 = Math.min(height, y + CORE);
      const left = Math.max(0, x - CONTEXT);
      const top = Math.max(0, y - CONTEXT);
      const right = Math.min(width, x1 + CONTEXT);
      const bottom = Math.min(height, y1 + CONTEXT);
      const inputWidth = right - left;
      const inputHeight = bottom - top;
      const paddedWidth = roundUp(inputWidth, 8);
      const paddedHeight = roundUp(inputHeight, 8);
      const input = makeTensor(source, width, height, left, top, paddedWidth, paddedHeight);
      const result = await session.run({ [session.inputNames[0]]: input });
      const prediction = result[session.outputNames[0]].data;
      copyCore(
        output,
        source,
        prediction,
        width,
        height,
        x,
        y,
        x1,
        y1,
        left,
        top,
        paddedWidth,
        paddedHeight,
        strength,
      );
      completed += 1;
      self.postMessage({
        type: "progress",
        completed,
        total,
        percent: (completed / total) * 100,
      });
    }
  }
  return { width, height, values: output, backend: session.backend ?? "WebGPU/WASM" };
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = createSession();
  }
  return sessionPromise;
}

async function createSession() {
  self.postMessage({ type: "status", message: "Loading the SCUNet model (about 74 MB, first use only)…" });
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
  try {
    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    });
    session.backend = "WebGPU";
    return session;
  } catch (webgpuError) {
    self.postMessage({
      type: "status",
      message: "WebGPU is unavailable. Trying the WASM fallback…",
    });
    try {
      const session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      session.backend = "WASM";
      return session;
    } catch (wasmError) {
      throw new Error(
        `SCUNet could not start. WebGPU: ${formatError(webgpuError)} WASM: ${formatError(wasmError)}`,
      );
    }
  }
}

function makeTensor(source, width, height, left, top, tensorWidth, tensorHeight) {
  const values = new Float32Array(3 * tensorWidth * tensorHeight);
  const plane = tensorWidth * tensorHeight;
  for (let y = 0; y < tensorHeight; y += 1) {
    const sourceY = Math.min(height - 1, top + y);
    for (let x = 0; x < tensorWidth; x += 1) {
      const sourceX = Math.min(width - 1, left + x);
      const sourceOffset = (sourceY * width + sourceX) * 3;
      const pixel = y * tensorWidth + x;
      values[pixel] = source[sourceOffset];
      values[plane + pixel] = source[sourceOffset + 1];
      values[2 * plane + pixel] = source[sourceOffset + 2];
    }
  }
  return new ort.Tensor("float32", values, [1, 3, tensorHeight, tensorWidth]);
}

function copyCore(
  output,
  source,
  prediction,
  width,
  height,
  x,
  y,
  x1,
  y1,
  left,
  top,
  tensorWidth,
  tensorHeight,
  strength,
) {
  const plane = tensorWidth * tensorHeight;
  for (let outputY = y; outputY < y1; outputY += 1) {
    for (let outputX = x; outputX < x1; outputX += 1) {
      const sourceOffset = (outputY * width + outputX) * 3;
      const predictionOffset =
        (outputY - top) * tensorWidth + (outputX - left);
      const clean = [
        prediction[predictionOffset],
        prediction[plane + predictionOffset],
        prediction[2 * plane + predictionOffset],
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        const originalLinear = srgbDecode(source[sourceOffset + channel]);
        const cleanLinear = srgbDecode(clean[channel]);
        output[sourceOffset + channel] = srgbEncode(
          originalLinear + (cleanLinear - originalLinear) * strength,
        );
      }
    }
  }
}

function roundUp(value, multiple) {
  return Math.ceil(value / multiple) * multiple;
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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
