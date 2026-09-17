import init, { fit, apply } from "./pkg/pe_web_fit.js";

let ready = false;

async function ensureReady() {
  if (ready) {
    return;
  }
  await init();
  ready = true;
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await ensureReady();
      self.postMessage({ type: "ready" });
      return;
    }
    await ensureReady();
    if (message.type === "fit") {
      const progress = (step) => {
        self.postMessage({ type: "progress", step });
      };
      const recipe = fit(
        message.width,
        message.height,
        message.source,
        message.target,
        progress
      );
      self.postMessage({ type: "recipe", recipe }, [recipe.buffer]);
      return;
    }
    if (message.type === "apply") {
      const values = apply(
        message.width,
        message.height,
        message.source,
        message.recipe,
        message.strength
      );
      self.postMessage(
        {
          type: "image",
          width: message.width,
          height: message.height,
          values,
        },
        [values.buffer]
      );
      return;
    }
    throw new Error(`Unknown worker message ${message.type}`);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
