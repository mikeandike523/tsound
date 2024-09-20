

export type OutputOnlyStreamCallback = (buffOut: AudioBuffer) => void;

/**
 *
 * Opens an output-only audio stream and provide callbacks to start and stop playback.
 * The purpose of the stream is essentially a near-real-time audio player
 * Instead of having to instance new audio players for tiny snippets of audio
 * We instead have a single audio stream with a large internal buffer
 * 
 * (5 or 10 seconds of cachable audio is a good choice depending on the application)
 * 
 * @remarks
 * There are two sources of latency, and potential crackle/pop
 * When interacting with audio worklets:
 * 
 * 1. Hardware latency / hardware buffer size:
 * As mentioned below, in web audio, unlike other environments
 * we do not directly control the hardware buffer size.
 * Instead we use `latencyHint` as mentioned below
 * 
 * 2. Javascript execution and message passing delays
 * Both the time it takes to execute main thread code and audio worklet code
 * affects the max responsiveness of the worklet to newly created audio
 * Message passing can be especially troublesome.
 * From testing earlier in this project, audio worklets tend
 * to need at least (2048/44100) seconds before you
 * can send new audio data over
 * 
 * However that is a liberal estimate. 2048/44100 is the minimum time to avoid
 * popping so bad it sound like a note and ruins your song.
 * At least latency of 4096/44100 is recommended for good quality
 * 
 * This affects things in two ways:
 * 
 * 1. For project playback -- not heavily affected, we tend to cache 5-10 seconds beyond 
 * the current scrub bar which is much, much larger that 2048/44100
 * 2. For midi and audio instrument real time effects
 * 4096/44100 = 92.9ms
 * This is really getting up there. For midi controllers maybe its acceptable but
 * certainly not for live audio effects (such as guitar pedal simulation)
 * 
 * even 2048/44100 = 46.4ms is still pretty bad.
 * 
 * If in the future, I wanted to make real time audio effects, I would do the following:
 * (however I don't have the time right now)
 * 
 * 1. Establish MOSI (and optional MISO) ring buffers using `SharedArrayBuffer`
 * 2. Use thread safe operations on the variables that are the playheads in the ring buffers
 *    THis then allows the accesses of ring buffers to be done without atomics
 *    As in each buffer only one writer and one reader
 * 
 * This is quite tricky though, so its a goal for future versions
 * 
 * 
 * @param sampleRate -
 * A sample rate that is compatible with the hardware.
 * You can get it from querying the hardware device information.
 * 
 * @param maxQueuedContentSeconds - the max amount of audio data that can be held in memory, in seconds 
 * Affected by sample rate
 * Math.ceil() will be applied for decimal quantities, so the result will always have enough and not be 
 * one short
 * 
 * @param requestedLatency -
 * Unlike "PortAudio", we never truly control the underlying auido buffer size
 * in the "process" function. The Web Audio API just doesn't work that way
 * instead, it appears that the Web Audio API computes its buffer size, and
 * other hardware latency setting based on a hint for our desired latency.
 * 
 * Recommendation:
 * Let's say we were in a different environment, using port audio, at sample rate 44100
 * and buffer size 2048
 * To approximate this as best as we can here, we'd use:
 * requestedLatency = bufferSize / sampleRate
 * 
 * For good measure, its often best to reduce the latency by some power of two
 * I think this affects "sub-buffer" size so to speak, i.e. the ratio
 * between our abstract "buffer size" and the size of each buffer passed
 * into the "process" function in the audio worklet.
 * 
 * I recommnend using the factor 4 ( a.k.a 2^2), thus
 * requestedLatency = 2048 / 44100 / 4
 */
export async function createDynamicAuidoPlayer(
  sampleRate: number,
  maxQueuedContentSeconds: number,
  requestedLatency: number,
) {
  const audioContext = new window.AudioContext({
    latencyHint:requestedLatency,
    sampleRate
  });

  const maxQueuedSamples = Math.ceil(maxQueuedContentSeconds * sampleRate)

  try {
    // Check if the browser supports AudioWorklet
    if (audioContext.audioWorklet) {
      // Define an AudioWorklet processor (using JavaScript inline as a fallback)
      const processorCode = `
            class OutputProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.maxQueuedSamples = ${maxQueuedSamples};
                // Prevents infinitely looping old content in the buffer
                // Allows actual silence to be played
                // when no new content has arrived for a while
                this.remainingQueuedContent=0;
                this.buffer = new Float32Array(this.maxQueuedSamples).fill(0);
                this.playHead = 0;
                this.writeHead = 0;
                this.port.onmessage = (event) => {
                  const data = event.data;
                  const numSamples = data.length;
                  if(numSamples > this.maxQueuedSamples) {
                    // Should errors ever be thrown from an audio worklet, even if they are expected 
                    // to never occur?
                    // Should never occur unless the dev made a mistake
                    // and accidentally used different content queue sizes
                    // in different places of a project
                    throw new Error(\`
                    Received too much audio data in a single message. Attempting to play incorporate the daya
                    will cause it to overwrite itself
                    and playback will not behave predictably
                    \`);
                    this.playHead = 0;
                    this.writeHead = 0;
                    this.buffer.fill(0);
                    this.remainingQueuedContent = 0;
                  }
                  for (let i = 0; i < numSamples; i++) {
                    if(this.remainingQueuedContent < this.maxQueuedSamples) {
                      this.buffer[this.indexFromPlayHead(this.remainingQueuedContent)] = data[i];
                      this.remainingQueuedContent++;
                    }
                    else {
                      // This exception is more likely to occur if dev
                      // is not careful about how they break up longer content
                      throw new Error(\`
                      Queued up too much audio data.
                      Be careful how you manage breaking up longer content
                      and queing in

                      See <PUT_LINK_HERE_EVENTUALLY> for tips and tricks
                      \`)
                      this.playHead = 0;
                      this.writeHead = 0;
                      this.buffer.fill(0);
                      this.remainingQueuedContent = 0;
                    }
                    this.buffer[this.indexFromWriteHead(this.remainingQueuedContent+i)] = data[i];
                  }
  
                };
              }

              indexFromPlayHead(index) {
                return (this.playHead + index) % this.maxQueuedSamples
              }

              indexFromWriteHead(index) {
                return (this.writeHead + index) % this.maxQueuedSamples
              }
    
              /**
               * Processes a buffer of an unpredictable size
               * and sends it to the audio output
               * 
               * Usually the size will depend
               * on your value for \`requestedLatency\`
               * but we can never rely on it being constant
               */
              process(inputs, outputs, parameters) {
                const output = outputs[0];
                const outputChannel = output[0];
                const numToProcess = outputChannel.length;
                for (let i = 0; i < numToProcess; i++) {
                    if(this.remainingQueuedContent === 0) {
                      // Typically, unless we have reason
                      // to explicity suspend
                      // or resume the stream
                      // the master output stream
                      // be be on constantly
                      // and we use silence when
                      // there is no remaining queued content
                      outputChannel[i] = 0
                      continue
                    }
                    outputChannel[i] = this.buffer[this.indexFromPlayHead(i)];
                    this.remainingQueuedContent--;
                }
                this.playHead = (this.playHead + numToProcess) % this.maxQueuedSamples;
                // always keep the output on
                // user may explcitily stop and resume the audio worklet if needed, but its unlikely
                // as modern computers have quite a bit of memory and cpu to spare
                return true;
              }
            }
    
            registerProcessor('dynamic-audio-player', OutputProcessor);
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
        "dynamic-audio-player"
      );

      // Connect the worklet node to the audio context destination
      workletNode.connect(audioContext.destination);

      return {
        queueMoreContent:  (contentSamples:Float32Array) => {
          workletNode.port.postMessage(contentSamples)
        }
      };
    } else {
      throw new Error("AudioWorklet is not supported in this browser.");
    }
  } catch (error) {
    console.error("Error opening output stream:", error);
    throw error;
  }
}
