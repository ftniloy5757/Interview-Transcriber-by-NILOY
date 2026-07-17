document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const apiKeyInput = document.getElementById('apiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const modelSelect = document.getElementById('modelSelect');
  const speakerCountInput = document.getElementById('speakerCount');
  
  const dropZone = document.getElementById('dropZone');
  const fileUploadInput = document.getElementById('fileUploadInput');
  const selectedFileInfo = document.getElementById('selectedFileInfo');
  
  const useGuideCheckbox = document.getElementById('useGuide');
  const guideConfigSection = document.getElementById('guideConfigSection');
  const guideUploadInput = document.getElementById('guideUploadInput');
  const uploadGuideBtn = document.getElementById('uploadGuideBtn');
  const guideFileInfo = document.getElementById('guideFileInfo');
  const guideContentTextarea = document.getElementById('guideContent');
  
  const startBtn = document.getElementById('startBtn');
  
  const progressCard = document.getElementById('progressCard');
  const progressBar = document.getElementById('progressBar');
  const statusBadge = document.getElementById('statusBadge');
  const progressPercent = document.getElementById('progressPercent');
  const statusMessage = document.getElementById('statusMessage');
  
  const editorCard = document.getElementById('editorCard');
  const emptyState = document.getElementById('emptyState');
  const editorGrid = document.getElementById('editorGrid');
  const transcriptTextarea = document.getElementById('transcriptTextarea');
  const speakerInputsContainer = document.getElementById('speakerInputsContainer');
  const applySpeakerNamesBtn = document.getElementById('applySpeakerNamesBtn');
  
  const saveWorkspaceBtn = document.getElementById('saveWorkspaceBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  
  const toast = document.getElementById('toast');

  // Application State
  let selectedUploadFile = null;
  let currentTaskId = null;
  let pollInterval = null;
  let originalFileBasename = 'transcript';

  // 1. Initialize API Key from LocalStorage
  const savedApiKey = localStorage.getItem('gemini_api_key');
  if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
  }

  // Save API key on change
  apiKeyInput.addEventListener('input', () => {
    localStorage.setItem('gemini_api_key', apiKeyInput.value.trim());
  });

  // Toggle API key visibility
  toggleApiKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleApiKeyBtn.textContent = isPassword ? '🙈' : '👁️';
  });

  // 2. Media Upload Drag & Drop Handlers
  dropZone.addEventListener('click', () => fileUploadInput.click());
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileUploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  function handleFileSelected(file) {
    selectedUploadFile = file;
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    selectedFileInfo.textContent = `Selected: ${file.name} (${sizeMb} MB)`;
    showToast(`Media selected: ${file.name}`, 'success');
  }

  // 3. Questionnaire Upload & Toggle
  useGuideCheckbox.addEventListener('change', () => {
    if (useGuideCheckbox.checked) {
      guideConfigSection.classList.remove('disabled');
    } else {
      guideConfigSection.classList.add('disabled');
    }
  });

  uploadGuideBtn.addEventListener('click', () => guideUploadInput.click());

  guideUploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      guideFileInfo.textContent = `Selected Guide: ${file.name}`;
      
      const reader = new FileReader();
      reader.onload = (event) => {
        guideContentTextarea.value = event.target.result;
        showToast('Questionnaire uploaded successfully!', 'success');
      };
      reader.onerror = () => {
        showToast('Error reading questionnaire file.', 'error');
      };
      reader.readAsText(file);
    }
  });

  // 4. Action: Start Transcription
  startBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      showToast('Please enter your Gemini API Key first.', 'error');
      apiKeyInput.focus();
      return;
    }

    if (!selectedUploadFile) {
      showToast('Please select or upload a recording file.', 'error');
      return;
    }

    const speakerCount = parseInt(speakerCountInput.value) || 3;
    const model = modelSelect.value;
    const useGuide = useGuideCheckbox.checked;
    const guideContent = useGuide ? guideContentTextarea.value.trim() : '';

    const formData = new FormData();
    formData.append('model', model);
    formData.append('speakerCount', speakerCount);
    formData.append('guideContent', guideContent);
    formData.append('file', selectedUploadFile);
    
    originalFileBasename = selectedUploadFile.name.substring(0, selectedUploadFile.name.lastIndexOf('.')) || selectedUploadFile.name;

    try {
      startBtn.disabled = true;
      startBtn.textContent = '⏳ Submitting...';
      
      // Reset output editor UI
      emptyState.classList.remove('hidden');
      editorGrid.classList.add('hidden');
      saveWorkspaceBtn.classList.add('hidden');
      downloadBtn.classList.add('hidden');
      
      // Show and reset progress card
      progressCard.classList.remove('hidden');
      updateProgress(0, 'starting', 'Connecting to local server...');

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey
        },
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server error occurred during submission');
      }

      const data = await response.json();
      currentTaskId = data.taskId;
      
      // Start polling
      startPolling(currentTaskId);
      showToast('Transcription job queued successfully!', 'success');

    } catch (err) {
      showToast(`Submission failed: ${err.message}`, 'error');
      startBtn.disabled = false;
      startBtn.textContent = '🚀 Start Transcription';
      progressCard.classList.add('hidden');
    }
  });

  // 5. Polling Progress Status
  function startPolling(taskId) {
    if (pollInterval) clearInterval(pollInterval);
    
    pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/status/${taskId}`);
        if (!response.ok) throw new Error('Failed to retrieve task status');
        
        const task = await response.json();
        
        // Update UI Progress
        updateProgress(task.progress, task.status, task.message);
        
        if (task.status === 'completed') {
          clearInterval(pollInterval);
          handleTaskCompleted(task.transcript);
        } else if (task.status === 'failed') {
          clearInterval(pollInterval);
          handleTaskFailed(task.error);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 4000); // Poll every 4 seconds
  }

  function updateProgress(percent, status, message) {
    progressBar.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    statusBadge.textContent = status;
    statusMessage.textContent = message;

    // Badge styling based on state
    statusBadge.className = 'status-badge'; // reset
    if (status === 'completed') statusBadge.classList.add('success-badge');
    else if (status === 'failed') statusBadge.classList.add('error-badge');
  }

  function handleTaskCompleted(transcript) {
    showToast('Transcription completed successfully!', 'success');
    
    startBtn.disabled = false;
    startBtn.textContent = '🚀 Start Transcription';
    progressCard.classList.add('hidden');
    
    // Display in Editor
    emptyState.classList.add('hidden');
    editorGrid.classList.remove('hidden');
    
    transcriptTextarea.value = transcript;
    
    // Show download/save actions
    saveWorkspaceBtn.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');
    
    // Generate speaker renaming inputs
    generateSpeakerInputs();
  }

  function handleTaskFailed(errorMsg) {
    showToast('Transcription job failed.', 'error');
    
    startBtn.disabled = false;
    startBtn.textContent = '🚀 Start Transcription';
    
    statusMessage.innerHTML = `<span style="color:var(--error); font-weight:600;">Job Failed:</span> ${errorMsg}`;
  }

  // 6. Speaker Renaming Feature
  function generateSpeakerInputs() {
    const speakerCount = parseInt(speakerCountInput.value) || 3;
    speakerInputsContainer.innerHTML = '';
    
    for (let i = 1; i <= speakerCount; i++) {
      const group = document.createElement('div');
      group.className = 'speaker-input-group';
      
      const label = document.createElement('label');
      label.textContent = `Person ${i}`;
      
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `speakerRename${i}`;
      input.placeholder = `Name for Person ${i}`;
      input.value = `Person ${i}`; // default
      
      group.appendChild(label);
      group.appendChild(input);
      speakerInputsContainer.appendChild(group);
    }
  }

  applySpeakerNamesBtn.addEventListener('click', () => {
    let transcript = transcriptTextarea.value;
    const speakerCount = parseInt(speakerCountInput.value) || 3;
    let replacedCount = 0;

    for (let i = 1; i <= speakerCount; i++) {
      const newName = document.getElementById(`speakerRename${i}`).value.trim();
      if (!newName || newName === `Person ${i}`) continue;

      // Replace bold and plain instances
      const oldLabelBold = `**Person ${i}**:`;
      const newLabelBold = `**${newName}**:`;
      const oldLabelPlain = `Person ${i}:`;
      const newLabelPlain = `${newName}:`;

      const regBold = new RegExp(`\\*\\*Person ${i}\\*\\*:`, 'g');
      transcript = transcript.replace(regBold, newLabelBold);

      const regPlain = new RegExp(`Person ${i}:`, 'g');
      transcript = transcript.replace(regPlain, newLabelPlain);
      
      replacedCount++;
    }

    transcriptTextarea.value = transcript;
    
    if (replacedCount > 0) {
      showToast('Speaker names applied throughout transcript!', 'success');
      updateSpeakerSidebarLabels();
    } else {
      showToast('No changes made to speaker names.', 'success');
    }
  });

  function updateSpeakerSidebarLabels() {
    const speakerCount = parseInt(speakerCountInput.value) || 3;
    const labels = speakerInputsContainer.querySelectorAll('label');
    const inputs = speakerInputsContainer.querySelectorAll('input');

    for (let i = 0; i < speakerCount; i++) {
      const currentVal = inputs[i].value.trim();
      if (currentVal) {
        labels[i].textContent = currentVal;
      }
    }
  }

  // 7. Save and Download Operations
  saveWorkspaceBtn.addEventListener('click', async () => {
    const content = transcriptTextarea.value;
    const filename = `${originalFileBasename}_transcript.md`;
    
    try {
      saveWorkspaceBtn.disabled = true;
      saveWorkspaceBtn.textContent = 'Saving...';

      const response = await fetch('/api/save-transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filename, content })
      });

      if (!response.ok) throw new Error('Failed to save file');
      
      showToast(`Saved: ${filename} in workspace!`, 'success');
    } catch (err) {
      showToast(`Save Error: ${err.message}`, 'error');
    } finally {
      saveWorkspaceBtn.disabled = false;
      saveWorkspaceBtn.textContent = '💾 Save in Workspace';
    }
  });

  downloadBtn.addEventListener('click', () => {
    const content = transcriptTextarea.value;
    const filename = `${originalFileBasename}_transcript.md`;
    
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
    const link = document.createElement('a');
    
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast('Download started.', 'success');
  });

  // 8. Toast Utility
  function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 4000);
  }
});
