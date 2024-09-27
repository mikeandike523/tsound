import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import mime from "mime";

const app = express();

const __dirname = path.dirname(
  import.meta.url
    .toString()
    .slice("file://".length)
    .slice(process.platfrom === "win32" ? 1 : 0)
);

// Middleware to set custom headers for COEP and COOP
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// Set the directory where your files are located
const distDir = path.join(__dirname, "dist");
const allowedFiles = [];

// Allowed extensions are html, js, and css
const permittedExtensions = ["html", "js", "css"];

// Function to recursively list the files in dist and place them in allowedFiles
function listFiles(dir) {
  fs.readdirSync(dir).forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      listFiles(filePath); // Recurse into subdirectories
    } else {
      const ext = path.extname(file).substring(1); // Get file extension without the dot
      if (permittedExtensions.includes(ext)) {
        allowedFiles.push(filePath);
      }
    }
  });
}

// Run the file listing
listFiles(distDir);

// Function to check for bad characters
function getBadCharacters(input) {
  const allowedCharactersRegexSource = /^[a-zA-Z0-9\.\-\/]+$/;
  const badCharacters = new Set();
  if (!allowedCharactersRegexSource.test(input)) {
    for (let char of input) {
      if (!/[a-zA-Z0-9\.\-\/]/.test(char)) {
        badCharacters.add(char);
      }
    }
  }
  return badCharacters;
}

app.get("/", (req, res) => {
  const sanitizedFilePath = path.join(distDir, "index.html");
  const fileStat = fs.statSync(sanitizedFilePath);
  const fileBuffer = fs.readFileSync(sanitizedFilePath);
  const md5Hash = crypto.createHash("md5").update(fileBuffer).digest("hex");
  const lastModified = fileStat.mtime;

  console.log(`Requested file: ${sanitizedFilePath}`);
  console.log(`MD5 Hash: ${md5Hash}`);
  console.log(`Last Modified: ${lastModified}`);

  // Set response headers and send the file
  res.setHeader("Content-Type", mime.getType(sanitizedFilePath));
  res.setHeader("Last-Modified", lastModified.toUTCString());
  res.setHeader("ETag", md5Hash);

  // Send the file
  res.sendFile(sanitizedFilePath);
});

// Handle full requested file path
app.get("/*", (req, res) => {
  const requestedFile = (req.params[0] || "").trim();

  if (requestedFile === "") {
    return res.status(404).end();
  }

  const badCharacters = getBadCharacters(requestedFile);
  if (badCharacters.size > 0) {
    return res.status(401).json({
      message: `Requested file path is invalid. Bad characters: ${[
        ...badCharacters,
      ].join(", ")}`,
    });
  }

  if (requestedFile.includes("..")) {
    return res.status(401).json({
      message: "Requested file cannot contain ..",
    });
  }

  // Condense slashes and trim leading/trailing slashes
  const sanitizedFilePath = path.join(
    distDir,
    requestedFile.replace(/\/+/g, "/").replace(/^\//, "").replace(/\/$/, "")
  );

  if (!allowedFiles.includes(sanitizedFilePath)) {
    return res.status(404).json({
      message: "File not allowed",
    });
  }

  // File exists and is allowed, log details
  const fileStat = fs.statSync(sanitizedFilePath);
  const fileBuffer = fs.readFileSync(sanitizedFilePath);
  const md5Hash = crypto.createHash("md5").update(fileBuffer).digest("hex");
  const lastModified = fileStat.mtime;

  console.log(`Requested file: ${sanitizedFilePath}`);
  console.log(`MD5 Hash: ${md5Hash}`);
  console.log(`Last Modified: ${lastModified}`);

  // Set response headers and send the file
  res.setHeader("Content-Type", mime.getType(sanitizedFilePath));

  res.setHeader("Last-Modified", lastModified.toUTCString());
  res.setHeader("ETag", md5Hash);

  // Send the file
  res.sendFile(sanitizedFilePath);
});

// Start the server
const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
