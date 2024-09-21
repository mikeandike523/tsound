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
  requestedLatency: number
) {
  const audioContext = new window.AudioContext({
    latencyHint: requestedLatency,
    sampleRate,
  });

  const maxQueuedSamples = Math.ceil(maxQueuedContentSeconds * sampleRate);

  const sbaredArrayBuffer = new SharedArrayBuffer(
    maxQueuedSamples * Int32Array.BYTES_PER_ELEMENT
  );
  const sharedArray = new Int32Array(sbaredArrayBuffer);
  const varMap = {
    playhead: 0,
    writeHead: 1,
    numQueuedSamples: 2,
    contentMutexIsLocked: 3,
  } as const;
  const numVars = Object.keys(varMap).length;
  const sharedArrayBufferMachineState = new SharedArrayBuffer(
    numVars * Uint32Array.BYTES_PER_ELEMENT
  );
  const sharedArrayMachineState = new Uint32Array(
    sharedArrayBufferMachineState
  );
  const setMachineVarAtomic = (varName: keyof typeof varMap, value: number) => {
    const mappedIndex = varMap[varName];
    Atomics.store(sharedArrayMachineState, mappedIndex, value);
  };
  const getMachineVarAtomic = (varName: keyof typeof varMap) => {
    const mappedIndex = varMap[varName];
    return Atomics.load(sharedArrayMachineState, mappedIndex);
  };
  setMachineVarAtomic("playhead", 0);
  setMachineVarAtomic("writeHead", 0);
  setMachineVarAtomic("numQueuedSamples", 0);
  setMachineVarAtomic("contentMutexIsLocked", 0);
  const setPlayheadAtomic = (value: number) => {
    setMachineVarAtomic("playhead", value);
  };
  const getPlayheadAtomic = () => {
    return getMachineVarAtomic("playhead");
  };
  const setWriteHeadAtomic = (value: number) => {
    setMachineVarAtomic("writeHead", value);
  };
  const getWriteHeadAtomic = () => {
    return getMachineVarAtomic("writeHead");
  };
  const setNumQueuedSamplesAtomic = (value: number) => {
    setMachineVarAtomic("numQueuedSamples", value);
  };
  const getNumQueuedSamplesAtomic = () => {
    return getMachineVarAtomic("numQueuedSamples");
  };
  const setContentMutexIsLockedAtomic = (value: number) => {
    setMachineVarAtomic("contentMutexIsLocked", value);
  };
  const getContentMutexIsLockedAtomic = () => {
    return getMachineVarAtomic("contentMutexIsLocked");
  };
  try {
    // Check if the browser supports AudioWorklet
    if (audioContext.audioWorklet) {
      // Define an AudioWorklet processor (using JavaScript inline as a fallback)
      const processorCode = `
            class OutputProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.varMap = null
                this.maxQueuedSamples = ${maxQueuedSamples};
                this.sharedArrayBuffer = null
                this.sharedBuffer = null;
                this.sharedArrayBufferMachineState = null
                this.sharedArrayMachineState = null;

                // Any helper functions i do NOT want to rewrite
                this.sharedHelpesr = null

                this.port.onmessage = (event) => {
                  const { sharedHelpers,varMap, sharedArrayBuffer,sharedArrayBufferMachineState} = event.data;
                  this.sharedArrayBuffer = sharedArrayBuffer;
                  this.sharedArray = new Int32Array(this.sharedArrayBuffer);
                  this.sharedArrayBufferMachineState = sharedArrayBufferMachineState;
                  this.sharedArrayMachineState = new Uint32Array(this.sharedArrayBufferMachineState);
                  this.varMap = varMap;
                  this.sharedHelpers = sharedHelpers;
                }
                
              }

              getSharedHelper(helperName) {
                if(this.sharedHelpesr === null) {
                  return null
                }
                if(this.sharedHelpesr[helperName] === undefined) {
                  return null
                }
              }

              setMachineVarAtomic(varName,value) {
                if(this.varMap === null) {
                  return
                }
                if(this.sharedArrayMachineState === null) {
                  return
                }
                const mappedIndex = this.varMap[varName]
                Atomics.store(this.sharedArrayMachineState,mappedIndex, value)
              }

              getMachineVarAtomic(varName) {
                if(this.varMap === null) {
                  return null
                }
                if(this.sharedArrayMachineState === null) {
                  return
                }
                const mappedIndex = this.varMap[varName]
                return Atomics.load(this.sharedArrayMachineState, mappedIndex)
              }

              setPlayheadAtomic(value){
                return this.setMachineVarAtomic("playhead", value)
              }

              getPlayheadAtomic(){
                return this.getMachineVarAtomic("playhead")
              }

              setWriteHeadAtomic(value){
                return this.setMachineVarAtomic("writeHead", value)
              }

              getWriteHeadAtomic(){
                return this.getMachineVarAtomic("writeHead")
              }

              setNumQueuedSamplesAtomic(value){
                return this.setMachineVarAtomic("numQueuedSamples", value)
              }

              getNumQueuedSamplesAtomic(){
                return this.getMachineVarAtomic("numQueuedSamples")
              }

              setContentMutexIsLockedAtomic(value){
                this.setMachineVarAtomic("contentMutexIsLocked", value)
              }

              getContentMutexIsLockedAtomic(){
                return this.getMachineVarAtomic("contentMutexIsLocked")
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
                if(!this.sharedArrayBuffer) {
                  return true
                }
                if(!this.sharedArrayBufferMachineState) {
                 return true
                }
                if(!this.varMap) {
                  return true
                }
                if(this.getContentMutexIsLockedAtomic()===1) {
                  return true
                }
                const output = outputs[0];
                const outputChannel = output[0];
                const INT32_MIN = -2147483648;
                const INT32_MAX = 2147483647;

                const samplesLeft = this.getNumQueuedSamplesAtomic()??0
                const numToFill = Math.min(outputChannel.length,samplesLeft)
                const playhead = this.sharedArrayMachineState[this.varMap["playhead"]]??0
                for(let i = 0; i < numToFill; i++) {
                  // As far as I reaclly, atomic reads are NOT needed here
                  // And will slow things down
                  const int32value = this.sharedArrayMachineState[(playhead + i) % this.maxQueuedSamples]
                  const t = (int32value-INT32_MIN) / (INT32_MAX - INT32_MIN)
                  outputChannel[i] = t * 2 - 1;
                }
                for (let i = numToFill; i < outputChannel.length; i++) {
                    outputChannel[i] = 0
                }
                // Not sure if the main thread really needs to know where the playhead is
                // Might be useful in the future
                // I think that maybe if we want a DAW like scrub function
                // then its useful if main thread knows it
                this.setPlayheadAtomic((playhead + numToFill) % this.maxQueuedSamples)
                this.setNumQueuedSamplesAtomic(Math.max(0, samplesLeft - outputChannel.length))
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

      workletNode.port.postMessage({
        sbaredArrayBuffer,
        sharedArrayBufferMachineState,
        varMap,
      });

      return {
        queueMoreContent: (contentSamples: Float32Array) => {
          const numAlreadyQueuedSamples = getNumQueuedSamplesAtomic();
          if(numAlreadyQueuedSamples === 0) {
            setWriteHeadAtomic(getPlayheadAtomic())

            
          }
          setContentMutexIsLockedAtomic(1);
          const writeHead = getWriteHeadAtomic()

          const subBufferSize = contentSamples.length;

          const INT32_MIN = -2147483648;
          const INT32_MAX = 2147483647;

          for (let i = 0; i < subBufferSize; i++) {
            const sample = contentSamples[i];
            const t = (1 + sample) / 2;
            const tInt = Math.floor(t * (INT32_MAX - INT32_MIN));
            const int32Value = tInt + INT32_MIN;
            const targetIndex = (writeHead + i) % maxQueuedSamples;
            sharedArray[targetIndex] = int32Value;
          }
          setContentMutexIsLockedAtomic(0);
          setNumQueuedSamplesAtomic(numAlreadyQueuedSamples + subBufferSize);
          setWriteHeadAtomic((writeHead + subBufferSize) % maxQueuedSamples);
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
