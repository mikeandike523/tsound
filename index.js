import { openDefaultOutputOnlyStream } from "./src/audio/streaming.js";

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
// Javascript Code
// Will be \`eval\` inside a promise
// must be synchronous and CommonJS
// But you may define async functions or use IIFE to use async/await
// (this is because Javascript does indeed allow promises to be spawned from within other promises)
// Behaves similarly to running code snippets in the browser console

// Play the C Major Scale

const semitone = Math.pow(2, 1 / 12)

const middleC = 220 * Math.pow(semitone, 3)

const majorScale = [
      0,
      2,
      2,
      1,
      2,
      2,
      2,
      1
]

let f = middleC;

const freqs = []

majorScale.forEach((interval) => {
  f = f * Math.pow(semitone, interval)
  freqs.push(f)
});

const delay = (ms)=>{
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async ()=>{
  
  for(let i = 0; i < freqs.length; i++) {
    const freq = freqs[i];
    masterTrack.pushSamples(
      new Array(Math.round(0.5*44100)).fill(0).map((_,i)=>{
        return Math.cos(2*Math.PI*i/44100*freq);  
      })
    )
    await delay(500)
  }
  
})();


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

window.masterTrack = {};

window.masterTrack.sampleRate = 44100;
window.masterTrack.engineBufferSize = 1024;
window.masterTrack.maxQueuedSamples = 44100*10;
window.masterTrack.latencyHintFactor = 1;
window.masterTrack.playHead = 0;
window.masterTrack.bufferMono = new Float32Array(
  window.masterTrack.maxQueuedSamples
).fill(0);
window.masterTrack.preloadedSampleCount = 0;

window.masterTrack.advancePlayHead = (samples) => {
  window.masterTrack.playHead =
    (window.masterTrack.playHead + samples) %
    window.masterTrack.maxQueuedSamples;
};

window.masterTrack.indexFromPlayHead = (offset) => {
  return (
    (window.masterTrack.playHead + offset) % window.masterTrack.maxQueuedSamples
  );
};

window.masterTrack.engineCallback = (audioBuffer) => {
  const bufferLength = audioBuffer.getChannelData(0).length;
  for (let i = 0; i < bufferLength; i++) {
    audioBuffer.getChannelData(0)[i] = 0;

    if (window.masterTrack.preloadedSampleCount === 0) {
      continue;
    }
    const sample =
      window.masterTrack.bufferMono[window.masterTrack.indexFromPlayHead(i)];
    audioBuffer.getChannelData(0)[i] = sample;
    window.masterTrack.advancePlayHead(1);
    window.masterTrack.preloadedSampleCount = Math.max(
      window.masterTrack.preloadedSampleCount - 1,
      0
    );
  }
};

window.masterTrack.pushSamples = (samples) => {
  for (let i = 0; i < samples.length; i++) {
    const putIndex = window.masterTrack.indexFromPlayHead(
      window.masterTrack.preloadedSampleCount + i
    );
    window.masterTrack.bufferMono[putIndex] = samples[i];
  }
  window.masterTrack.preloadedSampleCount += samples.length;
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

// Runs code in a new web worker for performance
window.runInUniqueThread = (javascriptCode) => {
  const uid = window.getUniqueWorkerId();
  const blob = new Blob([`onmessage = function(event) { ${javascriptCode} }`], {
    type: "application/javascript",
  });
  const worker = new Worker(URL.createObjectURL(blob));

  const workerMetadata = {
    kind: "thread",
    killable: true,
    worker,
  };

  window.workerList[uid] = workerMetadata;

  // Logging status
  window.logStatus(`Worker created with ID: ${uid}`);

  // Return the worker ID for external reference
  return uid;
};

// Runs code in a new web worker for performance
window.runInUniqueThread = (javascriptCode) => {
  const uid = window.getUniqueWorkerId();
  const blob = new Blob(
    [
      `onmessage = function(event) { 
   
       ${javascriptCode};
    
    }`,
    ],
    {
      type: "application/javascript",
    }
  );
  const worker = new Worker(URL.createObjectURL(blob));

  const workerMetadata = {
    kind: "thread",
    killable: true,
    worker,
  };

  window.workerList[uid] = workerMetadata;

  // Logging status
  window.logStatus(`Worker created with ID: ${uid}`);

  // Return the worker ID for external reference
  return uid;
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

// Runs code in unique interval and uses clearInterval for termination
window.runInUniqueInterval = (javascriptCode, ms) => {
  const uid = window.getUniqueWorkerId();

  const intervalId = setInterval(() => {
    try {
      eval(javascriptCode);
    } catch (err) {
      window.logStatus(`Error in interval ID ${uid}: ${err.message}`);
    }
  }, ms);

  const workerMetadata = {
    kind: "interval",
    killable: true,
    intervalId,
    ms,
  };

  window.workerList[uid] = workerMetadata;

  // Logging status
  window.logStatus(`Interval created with ID: ${uid} and interval: ${ms}ms`);

  return uid;
};

// Kills a worker by its unique ID
window.killUniqueWorker = (uid) => {
  const workerMetadata = window.workerList[uid];

  if (!workerMetadata) {
    throw new Error(`Worker with id ${uid} does not exist.`);
  }

  if (!workerMetadata.killable) {
    throw new Error(`Worker with id ${uid} is not killable.`);
  }

  // Kill based on type
  if (workerMetadata.kind === "thread") {
    workerMetadata.worker.terminate();
    window.logStatus(`Terminated worker with ID: ${uid}`);
  } else if (workerMetadata.kind === "interval") {
    clearInterval(workerMetadata.intervalId);
    window.logStatus(`Cleared interval with ID: ${uid}`);
  }

  // Remove the worker from the list
  delete window.workerList[uid];
};

window.turnMasterOn = async () => {
  window.logStatus("Creating master track monoaudio stream...");

  window.masterTrack.audioStreamMono = await openDefaultOutputOnlyStream(
    window.masterTrack.engineCallback,
    window.masterTrack.sampleRate,
    window.masterTrack.engineBufferSize,
    window.masterTrack.latencyHintFactor

  );

  window.logStatus("Done.");

  window.logStatus("Starting master track monoaudio stream...");

  await window.masterTrack.audioStreamMono.play();

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
        window.logStatus(`Error starting master track: ${err.message}`);
      });
  });
