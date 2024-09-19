

export type OutputOnlyStreamCallback = (buffOut: AudioBuffer) => void;

/**
 *
 * Opens an output-only audio stream and provide callbacks to start and stop playback.
 * 
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
 * @param latencyHintFactor
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
export async function openDefaultOutputOnlyStream(
  callback: OutputOnlyStreamCallback,
  sampleRate: number,
  bufferSize: number,
  latencyHintFactor: number=4
) {
  const audioContext = new window.AudioContext({
    latencyHint:bufferSize / sampleRate / latencyHintFactor,
    sampleRate
  });

  try {
    // Check if the browser supports AudioWorklet
    if (audioContext.audioWorklet) {
      // Define an AudioWorklet processor (using JavaScript inline as a fallback)
      const processorCode = `
            class OutputProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.bufferSize = ${bufferSize};
                this.buffer = new Float32Array(this.bufferSize).fill(0);
                this.port.onmessage = (event) => {
                  for(let i = 0; i < this.bufferSize; i++) {
                    this.buffer[i] = event.data[i];
                  }
                };
                this.playHead = 0
              }
    
              process(inputs, outputs, parameters) {
                const output = outputs[0];
                const outputChannel = output[0];
                for (let i = 0; i < outputChannel.length; i++) {
                    outputChannel[i] = this.buffer[this.playHead+i]
                }
                this.playHead += outputChannel.length;

                if(this.playHead >= this.bufferSize) {
                  this.playHead = 0;
                  this.port.postMessage(this.buffer);
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
