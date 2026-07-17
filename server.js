const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
const PORT = process.env.PORT || 3000;

// Set up storage for uploaded files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

// Configure multer to accept both audio and video files
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const isAudio = file.mimetype.startsWith('audio/');
    const isVideo = file.mimetype.startsWith('video/');
    if (isAudio || isVideo) {
      cb(null, true);
    } else {
      cb(new Error('Only audio (MP3, WAV, M4A, etc.) and video (MOV, MP4, etc.) files are allowed!'));
    }
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global state to track active transcription tasks
const activeTasks = {};

// Highly optimized low-memory FFmpeg audio extraction command
// -threads 1: force single-thread execution to save RAM on Render
// -vn: ignore video tracks (huge RAM and CPU savings)
// -ar 22050 -ac 1 -ab 64k: downsample to mono 22kHz at 64kbps (speech optimized)
// -v error: reduce logging verbosity
function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${inputPath}" -vn -acodec libmp3lame -ar 22050 -ac 1 -ab 64k -threads 1 -v error "${outputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        return reject(error);
      }
      resolve(outputPath);
    });
  });
}

// Endpoint: Get task status
app.get('/api/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = activeTasks[taskId];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Endpoint: Transcribe uploaded video/audio file
app.post('/api/transcribe', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    const taskId = Date.now().toString();
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(400).json({ error: 'Gemini API Key is required. Please set it in the settings.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No recording file was uploaded.' });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const modelName = req.body.model || 'gemini-3.5-flash';
    const speakerCount = parseInt(req.body.speakerCount) || 3;
    const guideContent = req.body.guideContent || '';

    // Initialize task progress
    activeTasks[taskId] = {
      id: taskId,
      fileName: originalName,
      status: 'starting',
      progress: 0,
      message: 'Starting transcription job...',
      error: null,
      transcript: null
    };

    // Send taskId back immediately so the client can poll status
    res.json({ taskId });

    // Run the heavy lifting asynchronously
    (async () => {
      let audioPath = '';
      let tempUploadedFile = null;
      let isVideo = req.file.mimetype.startsWith('video/');

      try {
        // Step 1: Extract audio if it is a video file, otherwise use the audio file directly
        if (isVideo) {
          updateTask(taskId, 'extracting', 15, 'Extracting audio track from video (Optimized low-memory)...');
          audioPath = path.join(uploadDir, `${taskId}-extracted.mp3`);
          await extractAudio(filePath, audioPath);
          updateTask(taskId, 'extracting', 35, 'Audio extraction completed.');
        } else {
          audioPath = filePath;
          updateTask(taskId, 'extracting', 35, 'Audio file detected, skipping extraction.');
        }

        // Step 2: Upload only the audio to Gemini File API
        updateTask(taskId, 'uploading', 45, 'Uploading audio track to Gemini File API...');
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResult = await fileManager.uploadFile(audioPath, {
          mimeType: 'audio/mp3',
          displayName: `Audio-${originalName}`,
        });
        tempUploadedFile = uploadResult.file;
        updateTask(taskId, 'uploading', 65, 'Upload complete. Processing file on Gemini servers...');

        // Wait for the file to be processed by Gemini (active state)
        let fileState = await fileManager.getFile(tempUploadedFile.name);
        let retries = 0;
        while (fileState.state === 'PROCESSING' && retries < 30) {
          await new Promise(r => setTimeout(r, 5000));
          fileState = await fileManager.getFile(tempUploadedFile.name);
          retries++;
          updateTask(taskId, 'uploading', 65 + Math.min(retries, 10), 'Waiting for Gemini to process audio file...');
        }

        if (fileState.state === 'FAILED') {
          throw new Error('Gemini failed to process the uploaded audio file.');
        }

        updateTask(taskId, 'transcribing', 80, 'Transcribing and labeling speakers using Gemini AI...');

        // Step 3: Call the model for transcription
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // Request options with a 10-minute timeout for large transcriptions
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          requestOptions: { timeout: 600000 } 
        });

        let prompt = `You are an expert transcriber. Your task is to transcribe the provided audio recording in native Bangla.
The audio consists of a conversation with exactly ${speakerCount} speakers.
`;

        if (guideContent) {
          prompt += `\nHere is the interview guide/questionnaire that was used in this interview for reference (it helps with understanding the structure, the questions asked, and specialized terminology like Kahf Browser, VPN, Incognito, privacy features, etc.):\n---Reference Questionnaire---\n${guideContent}\n---End of Reference Questionnaire---\n`;
        }

        prompt += `
Instructions:
1. Label the speakers as "Person 1", "Person 2", "Person 3", etc. up to "Person ${speakerCount}".
2. Put the timestamp at the beginning of each turn in brackets, e.g. [00:15] or [12:34] if you can detect timestamps. If precise timestamps are unavailable, estimate them based on progress, or omit them if impossible.
3. Transcribe in native Bangla. If speakers switch to English terms (e.g. "browser", "VPN", "privacy"), transcribe the English words in English or Bengali script depending on pronunciation, keeping the natural flow.
4. Output the result in markdown format. For example:
**Person 1**: [00:12] আসসালামু আলাইকুম।
**Person 2**: [00:14] ওয়ালাইকুম আসসালাম। কেমন আছেন?
**Person 3**: [00:18] হ্যাঁ, ভালো।
5. Capture everything accurately, including pauses or natural conversational remarks.
6. Make sure to identify and label all ${speakerCount} speakers properly throughout the entire duration of the audio.
`;

        const result = await model.generateContent([
          {
            fileData: {
              fileUri: tempUploadedFile.uri,
              mimeType: tempUploadedFile.mimeType
            }
          },
          { text: prompt },
        ]);

        const transcriptText = result.response.text();

        // Step 4: Complete
        updateTask(taskId, 'completed', 100, 'Transcription finished successfully!', transcriptText);

        // Clean up local files
        try {
          // Delete extracted audio file (if we created one)
          if (isVideo && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
          }
          // Delete original uploaded file (video or audio)
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          console.error('Error cleaning up local files:', err);
        }

        // Clean up Gemini File API file to save storage
        try {
          await fileManager.deleteFile(tempUploadedFile.name);
        } catch (err) {
          console.error('Error deleting file from Gemini FileManager:', err);
        }

      } catch (error) {
        console.error('Task error:', error);
        updateTask(taskId, 'failed', 100, `Error: ${error.message}`);
        
        // Clean up local temp files on failure
        try {
          if (isVideo && audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
          if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {}
      }
    })();
  });
});

// Endpoint: Save transcript back to workspace
app.post('/api/save-transcript', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'Filename and content are required' });
  }

  const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const filePath = path.join(__dirname, safeFilename);

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ message: `Transcript saved successfully to ${safeFilename}`, filePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function updateTask(taskId, status, progress, message, transcript = null) {
  if (activeTasks[taskId]) {
    activeTasks[taskId].status = status;
    activeTasks[taskId].progress = progress;
    activeTasks[taskId].message = message;
    if (transcript) {
      activeTasks[taskId].transcript = transcript;
    }
    if (status === 'failed') {
      activeTasks[taskId].error = message;
    }
  }
}

const server = app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

// Set server request timeout to 10 minutes (600,000ms)
server.timeout = 600000;
