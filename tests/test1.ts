import {
  OutputOnlyStreamCallback,
  getStandardAudioPlaybackDevice,
  openOutputOnlyStream,
} from "../src/audio/streaming.js";
import asyncDelay from "../src/timing/asyncDelay.js";

function createSineWaveInstrument(
  sampleRate: number,
  frequency: number
): OutputOnlyStreamCallback {
  const radianFrequency = 2 * Math.PI * frequency;
  let elapsedSamples = 0;

  const sineWaveInstrument: OutputOnlyStreamCallback = (buffer) => {
    const outChannel = buffer.getChannelData(0); // assuming mono output
    for (let i = 0; i < buffer.length; i++) {
      const elapsedAngle =
        radianFrequency * ((elapsedSamples + i) / sampleRate);
      outChannel[i] = Math.sin(elapsedAngle); // fill the buffer with audio samples
    }
    elapsedSamples += buffer.length; // update the elapsed time counter
  };
  return sineWaveInstrument;
}

async function main(f: number) {
  const sineWaveInstrument = createSineWaveInstrument(44100, f);
  const device = await getStandardAudioPlaybackDevice(true); // prefer headphones if present
  if (device === null) {
    throw new Error(
      `
            No audio playback device found.
            This is strange as this means your internal speakers are also not detected.
            `
    );
  }
  console.log(device);
  const stream = await openOutputOnlyStream(
    device,
    sineWaveInstrument,
    44100,
    256, // The industry standard minimum latency,
         // applications that use 128 or less are looking for trouble
         // 256/44100 = 5.8ms
    "interactive",
    8 // Might be overkill. Queue up to 8 buffers in advance
  );
  console.log("Playing...");
  await stream.play();
  await asyncDelay(1);
  await stream.pause();
  console.log("Done");
}

const majorSemitoneSteps = [2, 2, 1, 2, 2, 2];

const factors = majorSemitoneSteps.map((value) => Math.pow(2, value / 12));

const factorsAcc: number[] = [1];

for (const factor of factors) {
  factorsAcc.push(factorsAcc[factorsAcc.length - 1] * factor);
}

factorsAcc.push(2);

// It seems audio worklets need a distinct name for their communication ports
// hopefully garbage collection on loop iteration frees it up
// After some tesitng it appears that this is the case, not sure but it seems to work

for (const factor of factorsAcc) {
  await main(440 * factor);
  // just enough to flush a few buffers
  // Dont want the silence to be percieved
  await asyncDelay(0.050);
}
