// Match the model catalog in the pinned Moonshine WASM release.
export const SPEECH_MODEL = "moonshine-medium-streaming-en";
export const SPEECH_REVISION = "quantized_26_07_30";
export const SPEECH_RUNTIME = "0.1.5";
export const MODEL_PATH = `/models/${SPEECH_MODEL}/${SPEECH_REVISION}`;
export const RUNTIME_PATH = `/speech/moonshine-${SPEECH_RUNTIME}`;
export const MODEL_URL = `https://download.moonshine.ai/model/medium-streaming-en/${SPEECH_REVISION}`;
export const MODEL_FILES = {
  "adapter.ort": 3651296,
  "cross_kv.ort": 11643776,
  "decoder_kv.ort": 146972408,
  "encoder.ort": 94705376,
  "frontend.ort": 47467576,
  "streaming_config.json": 513,
  "tokenizer.bin": 249974,
} as const;
