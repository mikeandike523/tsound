import { createDynamicAuidoPlayer } from "./src/audio/streaming.js";

require.config({
  paths: {
    vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs",
  },
});

// Load the Monaco Editor
require(["vs/editor/editor.main"], function () {
  // Create the editor in the div with the id 'editor'
  window.editor = monaco.editor.create(
    document.querySelector("div.CodeEditorContainer"),
    {
      value:
        `

  const semitone = Math.pow(2, 1/12)

  const A = 440
  const C = A * Math.pow(semitone, 3);

  const track1 = new MixerTrack(8192,0.5)
  const track2 = new MixerTrack(8192,0.5)

  const mixer = new Mixer(8192, master)

  mixer.addTrack(track1)
  mixer.addTrack(track2)

  function song(elapsedTime){
    for(let i = 0; i < 8192; i++) {
      const angle1 = 2*Math.PI * (elapsedTime+i/44100) * A;
      const angle2 = 2*Math.PI * (elapsedTime+i/44100) * C;
      track1.data[i] = Math.sin(angle1);
      track2.data[i] = Math.sin(angle2);
    }
    mixer.mix();
    mixer.send()
  }

  const scrubPlayer = new ScrubPlayer(song, 8192, master.sampleRate)

  scrubPlayer.start();

    `.trim() + "\n\n",
      language: "javascript", // Set the language mode
      theme: "vs-dark", // Set the theme (e.g., vs-light, vs-dark)
    }
  );
});

const statusLog = document.querySelector("div.StatusLog");

const scrollElementToBottom = (elem) => {
  elem.scrollTo(0, elem.scrollHeight, {
    behavior: "smooth",
  });
};

window.maxStatusLogs = 50;

window.logStatus = (message) => {
  // Create a new <pre> element
  const preElement = document.createElement("pre");
  preElement.style.whiteSpace = "pre-wrap"; // Set white-space to pre-wrap
  preElement.style.border = "2px dotted black"; // Add border for visual clarity (optional)
  preElement.style.margin = "0"; // Add margin for visual clarity (optional)
  preElement.style.padding = "4px"; // Add padding for visual clarity (optional)

  // Create a <code> element and set its content
  const codeElement = document.createElement("code");
  codeElement.textContent = message;

  // Append the <code> element to the <pre> element
  preElement.appendChild(codeElement);

  // Add the <pre> element to the status log
  statusLog.appendChild(preElement);

  // If the number of children exceeds maxStatusLogs, remove the first child
  while (statusLog.children.length > window.maxStatusLogs) {
    statusLog.removeChild(statusLog.firstChild);
  }

  // Scroll the status log to the bottom
  scrollElementToBottom(statusLog);
};

// test
window.logStatus('Welcome to TSound.\nPress "MASTER ON" to start...');

window.master = {};

window.master.sampleRate = 44100;
window.master.maxQueuedContentSeconds = 10;
window.master.requestedLatency = 1024 / 44100 / 2;
window.master.buffferSize = 1024

/**
 *
 * @param {Float32Array} samples
 */
window.master.pushSamples = (samples) => {
  if (window.master.outputStream) {
    window.master.outputStream.queueMoreContent(samples);
  } else {
    window.logStatus("Master track is not yet ready.");
  }
};

window.workerList = {};

const getRandomString = (chars = 32) => {
  const allowedChars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < chars; i++) {
    result += allowedChars.charAt(
      Math.floor(Math.random() * allowedChars.length)
    );
  }
  return result;
};

window.getUniqueWorkerId = () => {
  const existinWorkerIds = Object.keys(window.workerList);
  let newWorkerId;
  do {
    newWorkerId = getRandomString();
  } while (existinWorkerIds.includes(newWorkerId));
  return newWorkerId;
};

// Runs code in the main thread but non-blocking via Promise
window.runInUniquePromise = (javascriptCode) => {
  const uid = window.getUniqueWorkerId();

  const workerMetadata = {
    kind: "promise",
    killable: false,
    promise: new Promise((resolve, reject) => {
      try {
        const result = eval(javascriptCode);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      console.error(err);
      window.logStatus(`Error in promise ID ${uid}: ${err.message}`);
      if (err.stack) {
        window.logStatus(`Stack trace for error ID ${uid}: ${err.stack}`);
      }
    }),
  };

  window.workerList[uid] = workerMetadata;

  // Logging status
  window.logStatus(`Promise created with ID: ${uid}`);

  // Return the promise and worker ID
  return uid;
};

window.turnMasterOn = async () => {
  window.logStatus("Creating master track monoaudio stream...");

  window.master.outputStream = await createDynamicAuidoPlayer(
    window.master.sampleRate,
    window.master.maxQueuedContentSeconds,
    window.master.requestedLatency
  );

  window.logStatus("Done.");

  window.logStatus("Starting master track monoaudio stream...");

  window.logStatus("Master track monoaudio stream is ON.");

  document.querySelector("button.RunButton").addEventListener("click", () => {
    const monacoCode = window.editor.getValue();
    // for now, lets always use performant
    // const uid = window.runInUniqueThread(monacoCode.trim());
    const uid = window.runInUniquePromise(monacoCode.trim());
    window.logStatus(
      `Started promise with ID: ${uid}. Note that it is not cancellable.`
    );
  });

  document.querySelector("button.MasterOnButton").disabled = true;

  document.querySelector("button.RunButton").disabled = false;
};

document
  .querySelector("button.MasterOnButton")
  .addEventListener("click", () => {
    window
      .turnMasterOn()
      .then(() => {})
      .catch((err) => {
        console.error(err);

        window.logStatus(`Error starting master track: ${err.message}`);
        if (err.stack) {
          window.logStatus(`Stack trace: ${err.stack}`);
        }
      });
  });

class Mixer {
  constructor(bufferSize,target) {
    /**
     * @type {Array<MixerTrack>}
     */
    this.tracks = [];
    this.bufferSize = bufferSize;
    this.data = new Float32Array(bufferSize);
    this.target = target;
  }
  addTrack(track){
    this.tracks.push(track);
  }
  mix(){

      for(let i = 0; i < this.bufferSize; i++){
        let total = 0;
        for(let j = 0; j < this.tracks.length; j++){
          total += this.tracks[j].data[i]*this.tracks[j].volume;
        }
        if(total <-1){
          total = -1;
        }
        if(total > 1){
          total = 1;
        }
        this.data[i] = total;
      }
    
  }
  send(){
    this.target.pushSamples(this.data);
  }
}

class MixerTrack {
   constructor(bufferSize, volume){
      this.volume = volume;
      this.bufferSize = bufferSize;
      this.data = new Float32Array(bufferSize);
   }
   set(samples){
    this.data.set(samples, this.writehead);
   }
}


class ScrubPlayer {
  constructor(callback, bufferSize, sampleRate){
    this.callback = callback;
    this.current = 0;
    this.initial = 0;
    this.running = false;
    this.timeInterval = bufferSize / sampleRate;
  }
  processFrame(){
    if(this.running){
      const now = performance.now()/1000;
      if(now - this.current >= this.timeInterval || this.current === this.initial) {
        this.callback(this.current-this.initial);
        this.current = now;
      }
      window.requestAnimationFrame(this.processFrame.bind(this));
    }
  }
  start(){
    this.running = true;
    this.inital = performance.now()/1000;
    this.current = this.initial;
    this.processFrame();
  }
  stop(){
    this.running = false;
  } 
  scrub(time){
    this.current = time;
  }
}

window.MixerTrack = MixerTrack
window.Mixer = Mixer
window.ScrubPlayer = ScrubPlayer
