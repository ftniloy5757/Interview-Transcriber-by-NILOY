const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { setGlobalDispatcher, Agent } = require('undici');

setGlobalDispatcher(new Agent({
  headersTimeout: 600000, // 10 minutes
  bodyTimeout: 600000,    // 10 minutes
  keepAliveTimeout: 60000,
  connections: 20,
}));

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

// Helper: Fetch available models dynamically for given API key
async function getAvailableModels(apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.models || !Array.isArray(data.models)) return [];

    const preferredOrder = [
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash-8b',
      'gemini-flash-latest'
    ];

    const models = data.models
      .filter(m => {
        if (!m.supportedGenerationMethods || !m.supportedGenerationMethods.includes('generateContent')) return false;
        const name = m.name.toLowerCase();
        if (name.includes('tts') || name.includes('embed') || name.includes('imagen') || name.includes('bison') || name.includes('realtime')) return false;
        return true;
      })
      .map(m => ({
        id: m.name.replace(/^models\//, ''),
        displayName: m.displayName || m.name.replace(/^models\//, '')
      }));

    models.sort((a, b) => {
      const idxA = preferredOrder.indexOf(a.id);
      const idxB = preferredOrder.indexOf(b.id);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.id.localeCompare(b.id);
    });

    return models;
  } catch (err) {
    console.error('Error fetching models list:', err);
    return [];
  }
}

// Endpoint: Fetch available models for user's API key
app.get('/api/models', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(400).json({ error: 'Gemini API Key is required.' });
  }
  const models = await getAvailableModels(apiKey);
  res.json({ models });
});

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
    const modelName = req.body.model || 'gemini-1.5-flash';
    const speakerCount = parseInt(req.body.speakerCount) || 2;
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

        // Step 3: Call the model for transcription with fallback support
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // Dynamically fetch supported models for this API Key
        const userModels = await getAvailableModels(apiKey);
        const userModelIds = userModels.map(m => m.id);

        // Build priority candidate list
        const candidateModels = [
          modelName,
          'gemini-1.5-flash',
          'gemini-2.0-flash',
          'gemini-1.5-flash-8b',
          'gemini-1.5-pro',
          'gemini-2.0-flash-lite',
          ...userModelIds.filter(m => m.includes('flash')),
          ...userModelIds,
        ];

        const uniqueCandidates = [...new Set(candidateModels.filter(Boolean))];

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

        let result = null;
        let lastError = null;

        function isAuthError(err) {
          if (!err) return false;
          const msg = (err.message || '').toLowerCase();
          const status = err.status || err.statusCode;
          return (
            status === 401 ||
            status === 403 ||
            msg.includes('api_key_invalid') ||
            msg.includes('api key not valid') ||
            msg.includes('unauthenticated') ||
            msg.includes('permission_denied') ||
            msg.includes('permissiondenied') ||
            msg.includes('invalid api key')
          );
        }

        for (const candidate of uniqueCandidates) {
          let modelAttempts = 0;
          const maxModelAttempts = 2;
          let candidateSuccess = false;

          while (modelAttempts < maxModelAttempts) {
            modelAttempts++;
            try {
              const attemptLabel = modelAttempts > 1 ? ` (Retry ${modelAttempts}/${maxModelAttempts})` : '';
              updateTask(taskId, 'transcribing', 80, `Transcribing with model (${candidate})${attemptLabel}...`);
              console.log(`Attempting transcription with model: ${candidate} (Attempt ${modelAttempts})`);

              const model = genAI.getGenerativeModel({ 
                model: candidate,
                requestOptions: { timeout: 600000 } 
              });

              result = await model.generateContent([
                {
                  fileData: {
                    fileUri: tempUploadedFile.uri,
                    mimeType: tempUploadedFile.mimeType
                  }
                },
                { text: prompt },
              ], { timeout: 600000 });

              if (result && result.response) {
                console.log(`Successfully generated content using model: ${candidate}`);
                candidateSuccess = true;
                break;
              }
            } catch (err) {
              console.error(`Model ${candidate} attempt ${modelAttempts} failed:`, err.message);
              lastError = err;

              if (isAuthError(err)) {
                throw new Error(`Authentication Failed: ${err.message}. Please check your Gemini API Key.`);
              }

              const errStr = err.message.toLowerCase();
              const isTransient = errStr.includes('503') || errStr.includes('service unavailable') || errStr.includes('high demand') || errStr.includes('overloaded') || errStr.includes('500') || errStr.includes('502') || errStr.includes('504') || errStr.includes('429') || errStr.includes('resource_exhausted');

              if (isTransient && modelAttempts < maxModelAttempts) {
                const backoffMs = modelAttempts * 3000;
                updateTask(taskId, 'transcribing', 80, `Model (${candidate}) busy (503/High Demand). Retrying in ${backoffMs/1000}s...`);
                console.log(`Waiting ${backoffMs}ms before retrying ${candidate}...`);
                await new Promise(r => setTimeout(r, backoffMs));
              } else {
                break;
              }
            }
          }

          if (candidateSuccess) {
            break;
          }

          console.log(`Model ${candidate} failed. Retrying with next available model candidate...`);
        }

        if (!result) {
          throw lastError || new Error('All Gemini model candidates failed to transcribe.');
        }

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
