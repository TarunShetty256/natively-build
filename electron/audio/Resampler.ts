/**
 * Central audio resampler utility.
 *
 * Converts Int16LE PCM buffers (any input sample rate / channel count)
 * into mono 16-bit PCM at 16 kHz (Linear16) which is the canonical
 * format used by STT providers in this project.
 */
export function resampleTo16kMonoLinear16(chunk: Buffer, inputSampleRate: number, numChannels: number): Buffer {
  if (!chunk || chunk.length < 2) return Buffer.alloc(0);

  const numSamples = Math.floor(chunk.length / 2);
  const inputS16 = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    inputS16[i] = chunk.readInt16LE(i * 2);
  }

  // Mix down to mono if necessary
  let monoS16: Int16Array;
  if (numChannels && numChannels > 1) {
    const monoLength = Math.floor(inputS16.length / numChannels);
    monoS16 = new Int16Array(monoLength);
    for (let i = 0; i < monoLength; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        sum += inputS16[i * numChannels + c] || 0;
      }
      monoS16[i] = Math.round(sum / numChannels);
    }
  } else {
    monoS16 = inputS16;
  }

  const TARGET_RATE = 16000;
  if (!inputSampleRate || inputSampleRate === TARGET_RATE) {
    // Return raw mono 16-bit PCM buffer
    return Buffer.from(monoS16.buffer);
  }

  // Simple linear nearest-neighbor downsampling (fast, deterministic).
  // This is intentionally lightweight; the native resampler exists for high-quality offline resamples.
  const factor = inputSampleRate / TARGET_RATE;
  const outputLength = Math.max(0, Math.floor(monoS16.length / factor));
  const outputS16 = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    outputS16[i] = monoS16[Math.floor(i * factor)];
  }

  return Buffer.from(outputS16.buffer);
}
