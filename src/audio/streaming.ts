/**
 *
 * Gets either the built in speakers or external speakers/headphones.
 *
 * @param preferHeadphones -
 * Whether to prefer headphones or external speakers over built in speakers.
 */
export async function getStandardAudioPlaybackDevice(
  preferHeadphones: boolean = false
) {
  // Query the available audio output devices
  const devices = await navigator.mediaDevices.enumerateDevices();

  console.log(devices);

  // Filter out audio output devices
  const audioOutputDevices = devices.filter(
    (device) => device.kind === "audiooutput"
  );

  if (audioOutputDevices.length === 0) {
    console.warn("No audio output devices found.");
    return null;
  }

  // If preferHeadphones is true, try to find a device labeled as headphones or an external speaker
  if (preferHeadphones) {
    const externalDevice = audioOutputDevices.find((device) =>
      /headphone|speaker/i.test(device.label)
    );
    if (externalDevice) {
      return externalDevice;
    }
  }

  // Otherwise, return the first available device (likely the built-in speakers)
  return audioOutputDevices[0];
}

export type OutputOnlyStreamCallback = (buffOut: AudioBuffer) => void;

/**
 *
 * Opens an output-only audio stream and provide callbacks to start and stop playback.
 *
 * @param device -
 * The device to use for playback.
 * @param callback -
 * The function that computes what samples are to be played next.
 * To increase performanc, the callback is a void and a reference to the output buffer is passed directly..
 * @param sampleRate -
 * A sample rate that is compatible with the hardware.
 * You can get it from querying the hardware device information.
 * @param bufferSize -
 * A buffer size that is compatible with the hardware.
 * You can get it from querying the hardware device information.
 * @param latencyHint
 * See https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext#latencyhint
 *
 * @param numPreparedBuffers -
 * In case it takes excessive time to prepare the next buffer,
 * allows the audio stream to cache a few buffers in advance.
 * Experiment with different combinations of `bufferSize` and `numPreparedBuffers` to
 * improve responsiveness and reduce crackle/pop
 * 
 *
 * @remarks
 * Output-only streams are ueful for (live) synths
 * In-Out streams are useful for (live) effects
 */
export async function openOutputOnlyStream(
  device: MediaDeviceInfo,
  callback: OutputOnlyStreamCallback,
  sampleRate: number,
  bufferSize: number,
  latencyHint: "playback" | "balanced" | "interactive" | number="balanced",
  numPreparedBuffers: number = 2
) {
  const audioContext = new window.AudioContext({
    latencyHint,
    sampleRate: sampleRate,
  });

  try {
    // Check if the browser supports AudioWorklet
    if (audioContext.audioWorklet) {
      // Define an AudioWorklet processor (using JavaScript inline as a fallback)
      const processorCode = `
            class OutputProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.processedSamplesSoFar = 0;
                this.bufferSize = ${bufferSize};
                this.numPreparedBuffers = ${numPreparedBuffers};
                this.emptyBuffer = new Float32Array(this.bufferSize);
                this.accruedBuffer = new Float32Array(this.bufferSize*this.numPreparedBuffers);
                this.accruedBufferIndex = 0;
                this.playbackIndex = 0;
                this.port.onmessage = (event) => {
                  const previousIndex = (this.accruedBufferIndex  ) % this.numPreparedBuffers;
                  for(let i = 0; i < this.bufferSize; i++) {
                    this.accruedBuffer[i+this.bufferSize*previousIndex] = event.data[i];
                  }
                  this.accruedBufferIndex = (this.accruedBufferIndex + 1) % this.numPreparedBuffers;
                  };
              }
    
              process(inputs, outputs, parameters) {
                const output = outputs[0];
                const outputChannel = output[0];
                for (let i = 0; i < outputChannel.length; i++) {
                    outputChannel[i] = this.accruedBuffer[i+this.bufferSize*this.playbackIndex+this.processedSamplesSoFar] || 0;
                }
                this.processedSamplesSoFar+=outputChannel.length;
                if(this.processedSamplesSoFar >= this.bufferSize) {
                  this.playbackIndex = (this.playbackIndex + 1) % this.numPreparedBuffers;
                  this.processedSamplesSoFar = 0;
                  this.port.postMessage(this.emptyBuffer);
                }
                return true;
              }
            }
    
            registerProcessor('output-processor', OutputProcessor);
          `;

      // Add the processor code to the AudioWorklet
      const processorBlob = new Blob([processorCode], {
        type: "application/javascript",
      });
      const processorUrl = URL.createObjectURL(processorBlob);
      await audioContext.audioWorklet.addModule(processorUrl);

      // Create the AudioWorkletNode
      const workletNode = new AudioWorkletNode(
        audioContext,
        "output-processor"
      );

      // Set up the callback to fill the buffer
      const buffer = new Float32Array(bufferSize);
      const advance = () => {
        const audioBuffer = audioContext.createBuffer(
          1,
          bufferSize,
          sampleRate
        );
        callback(audioBuffer);

        audioBuffer.copyFromChannel(buffer, 0);
        workletNode.port.postMessage(buffer);
      };

      workletNode.port.onmessage = (event) => {
        advance();
      };

      // Connect the worklet node to the audio context destination
      workletNode.connect(audioContext.destination);

      // Return play and pause functions
      return {
        play: async () => {
          if (audioContext.state === "suspended") {
            await audioContext.resume();
          }
          advance();
        },
        pause: async () => {
          if (audioContext.state === "running") {
            await audioContext.suspend();
          }
        },
      };
    } else {
      throw new Error("AudioWorklet is not supported in this browser.");
    }
  } catch (error) {
    console.error("Error opening output stream:", error);
    throw error;
  }
}
