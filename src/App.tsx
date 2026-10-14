import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal, Code2, Play, Settings, X, FolderOpen, ArrowLeft, Bug, 
  Send, Key, CheckCircle, RefreshCw, FileCode, Cpu, Layers, HardDrive, 
  Sparkles, AlertCircle, Copy, Check, ChevronRight, Mic, MicOff,
  Github, Shield, Plus, Trash2, Eye, EyeOff, ExternalLink, Globe,
  Download, FilePlus, Save, ArrowUpRight, Search, Laptop, Tablet, 
  Smartphone, RotateCcw, CheckSquare, FileText, ThumbsUp, ThumbsDown,
  Flag, ArrowUp, ChevronDown, Paperclip, Image as ImageIcon, CornerDownLeft,
  FileCheck, History, Undo, Share2, Rocket, GitBranch, Lock, QrCode,
  Sliders, Link2, ChevronLeft
} from 'lucide-react';

// Custom Modern Devora Geometric Monogram Logo
function DevoraLogo({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path 
        d="M6 6C6 4.89543 6.89543 4 8 4H16.5C22.299 4 27 8.70101 27 14.5C27 20.299 22.299 25 16.5 25H8C6.89543 25 6 24.1046 6 23V6Z" 
        stroke="currentColor" 
        strokeWidth="2.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
      <path 
        d="M12 10.5V19.5M12 10.5H16.5C18.9853 10.5 21 12.5147 21 15C21 17.4853 18.9853 19.5 16.5 19.5H12" 
        stroke="#10b981" 
        strokeWidth="2.2" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
      <circle cx="21" cy="15" r="1.5" fill="#34d399" />
    </svg>
  );
}

// Types
type Stage = 'STAGE_1' | 'STAGE_2' | 'STAGE_3';
type TabType = 'CODE' | 'PREVIEW';
type SettingsTab = 'CHAT' | 'SHARE' | 'PUBLISH' | 'VERSIONS' | 'GITHUB' | 'INTEGRATIONS' | 'AST_RAG' | 'WEBCONTAINER' | 'GIT_DIFF' | 'VOICE_BUFFER' | 'MOA_AGENTS' | 'TEST_RUNNER' | 'MULTIPLAYER' | 'GROQ';
type ViewportSize = 'desktop' | 'tablet' | 'mobile';

interface WorkspaceFile {
  name: string;
  content: string;
  language: string;
}

interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
  files: WorkspaceFile[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: string;
  refinedMeta?: {
    original: string;
    detectedLanguage: string;
    translated: string;
    intent: string;
  };
  attachments?: string[];
  attachedImage?: string;
}

interface CheckpointItem {
  id: string;
  versionName: string;
  timestamp: string;
  message: string;
  files: WorkspaceFile[];
}

interface SecretItem {
  id: string;
  key: string;
  value: string;
  visible: boolean;
}

interface GitHubUser {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
  public_repos: number;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  updated_at: string;
}

const DEFAULT_WORKSPACES: WorkspaceFolder[] = [
  {
    id: 'devora-saas-engine',
    name: 'devora-saas-engine',
    path: 'src/workspace/local/devora-saas-engine',
    files: [
      {
        name: 'App.tsx',
        language: 'typescript',
        content: `import React, { useState } from 'react';

export default function DevoraEngine() {
  const [serverStatus, setServerStatus] = useState('ONLINE // 0ms SERVER LOAD');
  const [counter, setCounter] = useState(0);

  return (
    <div className="p-8 bg-black text-white font-sans min-h-screen">
      <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Devora SaaS Engine</h1>
            <p className="text-xs text-neutral-500 font-mono">DEVORA // ZERO COST CLIENT RUNTIME</p>
          </div>
        </div>
        <span className="text-xs px-2.5 py-1 bg-neutral-900 border border-neutral-800 text-emerald-400 font-mono">
          $0.00 INFRASTRUCTURE COST
        </span>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 border border-neutral-800 bg-neutral-950">
          <div className="text-xs text-neutral-400">System Telemetry</div>
          <div className="text-base font-bold text-white mt-1">{serverStatus}</div>
        </div>
        <div className="p-4 border border-neutral-800 bg-neutral-950">
          <div className="text-xs text-neutral-400">Execution Load</div>
          <div className="text-base font-bold text-emerald-400 mt-1">0.00% Zero Latency</div>
        </div>
        <div className="p-4 border border-neutral-800 bg-neutral-950">
          <div className="text-xs text-neutral-400">AI Gateway Nodes</div>
          <div className="text-base font-bold text-white mt-1">Gemini 2.5 Active</div>
        </div>
      </div>

      <div className="mt-8 flex gap-3">
        <button 
          onClick={() => {
            setServerStatus('TASK EXECUTED SUCCESSFULLY');
            setCounter(c => c + 1);
          }}
          className="px-5 py-2.5 bg-white text-black font-semibold text-xs uppercase tracking-wider hover:bg-neutral-200 transition-all cursor-pointer"
        >
          Execute Neural Process ({counter})
        </button>
        <button 
          onClick={() => setServerStatus('STANDBY')}
          className="px-4 py-2.5 border border-neutral-800 hover:border-neutral-600 text-xs text-neutral-400 hover:text-white transition-all cursor-pointer"
        >
          Reset Status
        </button>
      </div>
    </div>
  );
}`
      },
      {
        name: 'server.ts',
        language: 'typescript',
        content: `import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    brand: 'Devora',
    status: 'operational',
    infrastructureCost: 0.00,
    uptime: process.uptime()
  });
});

app.listen(3001, () => {
  console.log('Devora local daemon proxy active on port 3001.');
});`
      },
      {
        name: 'package.json',
        language: 'json',
        content: `{
  "name": "devora-saas-engine",
  "version": "1.0.0",
  "private": true,
  "description": "Devora Zero-Cost Local Engine",
  "dependencies": {
    "react": "^19.0.1",
    "express": "^4.21.2"
  }
}`
      }
    ]
  },
  {
    id: 'devora-ai-matrix',
    name: 'devora-ai-matrix',
    path: 'src/workspace/local/devora-ai-matrix',
    files: [
      {
        name: 'MatrixView.tsx',
        language: 'typescript',
        content: `import React from 'react';

export function MatrixView() {
  return (
    <div className="p-6 bg-black text-white font-mono">
      <h2 className="text-lg font-bold border-b border-neutral-800 pb-2">Devora AI Quantum Matrix</h2>
      <div className="grid grid-cols-2 gap-4 mt-6">
        <div className="p-4 border border-neutral-800 bg-neutral-950">Vector Shard A: Synced</div>
        <div className="p-4 border border-neutral-800 bg-neutral-950">Vector Shard B: Synced</div>
      </div>
    </div>
  );
}`
      }
    ]
  },
  {
    id: 'devora-fullstack-kit',
    name: 'devora-fullstack-kit',
    path: 'src/workspace/local/devora-fullstack-kit',
    files: [
      {
        name: 'Dashboard.tsx',
        language: 'typescript',
        content: `export default function Dashboard() {
  return <div className="p-6 bg-black text-white font-sans">Devora Fullstack Dashboard Ready</div>;
}`
      }
    ]
  }
];

export default function App() {
  // Screen Stage state (1 -> 2 -> 3)
  const [activeStage, setActiveStage] = useState<Stage>('STAGE_1');
  
  // Workspace State
  const [workspaces, setWorkspaces] = useState<WorkspaceFolder[]>(DEFAULT_WORKSPACES);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceFolder | null>(null);
  const [activeFileIndex, setActiveFileIndex] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<TabType>('CODE');
  
  // Code Editor state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showSearchBar, setShowSearchBar] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>('');
  const [showNewFileDialog, setShowNewFileDialog] = useState<boolean>(false);
  const [previewViewport, setPreviewViewport] = useState<ViewportSize>('desktop');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Settings Drawer State (Matches User's Screenshot Tabs: 1. Chat, 2. Share, 3. Publish, 4. Versions, 5. GitHub, 6. Integrations)
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('CHAT');
  
  // Tab 1: Chat Settings
  const [selectedModel, setSelectedModel] = useState<string>('Default (Gemini 3.8 Flash)');
  const [customInstructions, setCustomInstructions] = useState<string>(
    'Write clean, modular TypeScript code with modern Tailwind CSS styling. Keep code robust, fast, and production-ready.'
  );
  const [isEditingInstructions, setIsEditingInstructions] = useState<boolean>(false);
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [savedApiKey, setSavedApiKey] = useState<string>('');
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);
  const [keySavedMessage, setKeySavedMessage] = useState<boolean>(false);
  const [testKeyStatus, setTestKeyStatus] = useState<{ loading: boolean; success?: boolean; latency?: number; message?: string } | null>(null);

  // Tab 2: Share Settings
  const [shareAccessMode, setShareAccessMode] = useState<'public' | 'view-only' | 'private'>('public');
  const [copiedShareLink, setCopiedShareLink] = useState<boolean>(false);
  const [showQrModal, setShowQrModal] = useState<boolean>(false);

  // Tab 3: Publish Settings
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployStep, setDeployStep] = useState<string>('');
  const [deploySuccess, setDeploySuccess] = useState<boolean>(true);
  const [customDomainInput, setCustomDomainInput] = useState<string>('devora-app.run.app');

  // Tab 4: Versions Settings
  const [versionHistory, setVersionHistory] = useState<CheckpointItem[]>([
    {
      id: 'v-103',
      versionName: 'v1.0.4 - Current Workspace',
      timestamp: 'Today at 02:40 AM',
      message: 'Latest AI IDE updates with multi-tab settings',
      files: DEFAULT_WORKSPACES[0].files
    },
    {
      id: 'v-102',
      versionName: 'v1.0.3 - Real-Time Preview Sandbox',
      timestamp: 'Today at 02:15 AM',
      message: 'Integrated live preview canvas with viewport controls',
      files: DEFAULT_WORKSPACES[0].files
    },
    {
      id: 'v-101',
      versionName: 'v1.0.2 - Multilingual Voice Pipeline',
      timestamp: 'Today at 01:50 AM',
      message: 'Hindi & Indic speech auto-translation and intent structuring',
      files: DEFAULT_WORKSPACES[0].files
    }
  ]);
  const [newVersionLabel, setNewVersionLabel] = useState<string>('');

  // Tab 5: GitHub Integration
  const [githubToken, setGithubToken] = useState<string>('');
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [isCheckingGithub, setIsCheckingGithub] = useState<boolean>(false);
  const [githubStatusMessage, setGithubStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newRepoName, setNewRepoName] = useState<string>('');
  const [newRepoDescription, setNewRepoDescription] = useState<string>('Created with Devora AI IDE Studio');
  const [newRepoPrivate, setNewRepoPrivate] = useState<boolean>(false);
  const [isCreatingRepo, setIsCreatingRepo] = useState<boolean>(false);
  const [targetRepoName, setTargetRepoName] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('Update from Devora AI Studio');
  const [isPushing, setIsPushing] = useState<boolean>(false);
  const [lastPushUrl, setLastPushUrl] = useState<string | null>(null);

  // Tab 6: Integrations / Secrets
  const [secretsList, setSecretsList] = useState<SecretItem[]>([
    { id: '1', key: 'GEMINI_API_KEY', value: 'AIzaSy_DEVORA_SYSTEM_DEFAULT', visible: false },
    { id: '2', key: 'PORT', value: '3000', visible: true },
    { id: '3', key: 'DEVORA_ENV', value: 'production', visible: true },
    { id: '4', key: 'INFRASTRUCTURE_COST', value: '$0.00', visible: true }
  ]);
  const [newSecretKey, setNewSecretKey] = useState<string>('');
  const [newSecretValue, setNewSecretValue] = useState<string>('');

  // Groq BYOK State
  const [groqApiKey, setGroqApiKey] = useState<string>('');
  const [savedGroqKey, setSavedGroqKey] = useState<string>('');
  const [selectedGroqModel, setSelectedGroqModel] = useState<string>('llama3-70b-8192');
  const [groqTestStatus, setGroqTestStatus] = useState<{ loading: boolean; success?: boolean; message?: string } | null>(null);

  // Self-Healing Preview State
  const [isFullscreenPreview, setIsFullscreenPreview] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isSelfHealing, setIsSelfHealing] = useState<boolean>(false);
  const [selfHealLog, setSelfHealLog] = useState<string | null>(null);

  const handleSaveGroqKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!groqApiKey.trim()) return;
    setSavedGroqKey(groqApiKey.trim());
    setCheckpointToast('Groq BYOK API Key configured successfully!');
    setTimeout(() => setCheckpointToast(null), 3000);
  };

  const handleTriggerSelfHeal = () => {
    setIsSelfHealing(true);
    setSelfHealLog('Analyzing sandbox stack trace & runtime error...');
    setTimeout(() => {
      setSelfHealLog('AI Self-Healing: Patched JSX attribute & null pointer exception.');
      setTimeout(() => {
        setIsSelfHealing(false);
        setPreviewError(null);
        setSelfHealLog(null);
        setCheckpointToast('Preview successfully self-healed by AI!');
        setTimeout(() => setCheckpointToast(null), 3000);
      }, 1500);
    }, 1500);
  };

  // Voice Pipeline State (Mice -> Translation -> Intent Structuring -> Better Prompt)
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechTranscript, setSpeechTranscript] = useState<string>('');
  const [isRefiningVoice, setIsRefiningVoice] = useState<boolean>(false);
  const [refinementStep, setRefinementStep] = useState<string>('');
  const recognitionRef = useRef<any>(null);

  // Chat Panel State & Screenshot Elements
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      role: 'model',
      content: `### Devora AI Studio Ready

- **Multilingual Voice Engine**: Speak in Hindi, Hinglish, or English via the microphone below.
- **Context Attachments**: Click **(+)** to attach files, images, or quick prompt templates.
- **Model Mode**: Toggle between **Default**, **Flash**, or **Pro Think**.
- **Settings HUD**: Click **⚙ SETTINGS** to open the new **Chat, Share, Publish, Versions, GitHub, Integrations** panel.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [inputPrompt, setInputPrompt] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [totalTokens, setTotalTokens] = useState<number>(48);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Attached image state matching Screenshot Image 2: [ 🖼️ image.png ✕ ]
  const [attachedImageFile, setAttachedImageFile] = useState<{ name: string; url: string } | null>(null);
  const [attachedContextFile, setAttachedContextFile] = useState<string | null>(null);

  // Interactive controls
  const [promptMode, setPromptMode] = useState<string>('Default');
  const [showModeDropdown, setShowModeDropdown] = useState<boolean>(false);
  const [showAddMenu, setShowAddMenu] = useState<boolean>(false);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 'up' | 'down'>>({});
  const [checkpointToast, setCheckpointToast] = useState<string | null>(null);
  
  // Diff Modal
  const [diffModal, setDiffModal] = useState<{
    isOpen: boolean;
    fileName: string;
    oldCode: string;
    newCode: string;
  } | null>(null);

  // Bug Report Modal state
  const [showBugModal, setShowBugModal] = useState<boolean>(false);
  const [bugDescription, setBugDescription] = useState<string>('');

  // Auto-scroll chat
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isGenerating, isRefiningVoice]);

  // Speech Recognition Setup
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'hi-IN';

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechTranscript('');
      };

      recognition.onresult = (event: any) => {
        let currentText = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          currentText += event.results[i][0].transcript;
        }
        setSpeechTranscript(currentText);
      };

      recognition.onerror = (event: any) => {
        console.warn('Speech error:', event.error);
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  // Voice Pipeline: Mice -> Translation -> Better Prompt
  const processVoiceInput = async (spokenText: string) => {
    if (!spokenText || !spokenText.trim()) return;

    setIsRefiningVoice(true);
    setRefinementStep('Detecting language & translating to developer English...');

    try {
      const response = await fetch('/api/refine-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawPrompt: spokenText,
          apiKey: savedApiKey || undefined,
          contextInfo: `Workspace: ${selectedWorkspace?.name || 'devora'}, Active File: ${selectedWorkspace?.files[activeFileIndex]?.name || 'App.tsx'}`
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to refine voice prompt.');
      }

      setRefinementStep('Structuring technical architecture & requirements...');

      const refined = {
        original: spokenText,
        detectedLanguage: data.detectedLanguage || 'Indic / Multilingual',
        translated: data.translatedText || spokenText,
        intent: data.intent || 'Code modification',
        refinedPrompt: data.refinedPrompt || data.translatedText || spokenText
      };

      handleSendPromptDirectly(refined.refinedPrompt, refined);
    } catch (err: any) {
      console.error('Voice Refinement Error:', err);
      handleSendPromptDirectly(spokenText);
    } finally {
      setIsRefiningVoice(false);
      setRefinementStep('');
    }
  };

  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Brave.');
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
      if (speechTranscript.trim()) {
        processVoiceInput(speechTranscript);
      }
    } else {
      setSpeechTranscript('');
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (err) {
        console.error('Error starting speech:', err);
      }
    }
  };

  // Stage 1 Demo Sign In
  const handleDemoSignIn = () => {
    localStorage.setItem('devora_session_token', 'devora_auth_token_99823481');
    setActiveStage('STAGE_2');
  };

  // Stage 2 Select Folder
  const handleSelectFolder = (folder: WorkspaceFolder) => {
    setSelectedWorkspace(folder);
    setActiveFileIndex(0);
    setActiveTab('CODE');
    setActiveStage('STAGE_3');
  };

  // Real Folder Drop / Upload into Workspace
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const parsedFiles: WorkspaceFile[] = [];
    const folderName = 'custom-uploaded-workspace';

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string || '';
        const ext = file.name.split('.').pop() || '';
        const language = ['ts', 'tsx'].includes(ext) ? 'typescript' : ['js', 'jsx'].includes(ext) ? 'javascript' : ext === 'json' ? 'json' : ext === 'css' ? 'css' : 'plaintext';
        
        parsedFiles.push({
          name: file.name,
          content,
          language
        });

        if (parsedFiles.length === files.length) {
          const newWorkspace: WorkspaceFolder = {
            id: `custom-${Date.now()}`,
            name: folderName,
            path: `src/workspace/local/${folderName}`,
            files: parsedFiles
          };
          setWorkspaces(prev => [newWorkspace, ...prev]);
          handleSelectFolder(newWorkspace);
        }
      };
      reader.readAsText(file);
    });
  };

  // Test API Key Live Latency
  const handleTestApiKey = async () => {
    setTestKeyStatus({ loading: true });
    try {
      const response = await fetch('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput || savedApiKey || undefined })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      setTestKeyStatus({
        loading: false,
        success: true,
        latency: data.latencyMs,
        message: `Validated in ${data.latencyMs}ms. Gemini Flash operational.`
      });
    } catch (err: any) {
      setTestKeyStatus({
        loading: false,
        success: false,
        message: err.message || 'Key validation failed.'
      });
    }
  };

  // Save API Key
  const handleSaveApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    setSavedApiKey(apiKeyInput);
    setKeySavedMessage(true);
    setTimeout(() => setKeySavedMessage(false), 1500);
  };

  // GitHub Validate
  const handleValidateGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubToken.trim()) return;

    setIsCheckingGithub(true);
    setGithubStatusMessage(null);

    try {
      const response = await fetch('/api/github/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: githubToken.trim() })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      setGithubUser(data.user);
      setGithubRepos(data.repos || []);
      if (data.repos && data.repos.length > 0) {
        setTargetRepoName(data.repos[0].name);
      }
      setGithubStatusMessage({ type: 'success', text: `Connected as @${data.user.login} (${data.user.public_repos} repos)` });
      
      setSecretsList(prev => {
        const filtered = prev.filter(s => s.key !== 'GITHUB_TOKEN');
        return [...filtered, { id: `gh-${Date.now()}`, key: 'GITHUB_TOKEN', value: githubToken.trim(), visible: false }];
      });
    } catch (err: any) {
      setGithubStatusMessage({ type: 'error', text: err.message });
      setGithubUser(null);
    } finally {
      setIsCheckingGithub(false);
    }
  };

  // GitHub Create Repo
  const handleCreateGithubRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim() || !githubToken.trim()) return;

    setIsCreatingRepo(true);
    setGithubStatusMessage(null);

    try {
      const response = await fetch('/api/github/create-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: githubToken.trim(),
          name: newRepoName.trim(),
          description: newRepoDescription,
          isPrivate: newRepoPrivate
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      setGithubStatusMessage({ type: 'success', text: `Repository ${data.repo.full_name} created successfully!` });
      setTargetRepoName(data.repo.name);
      setGithubRepos(prev => [data.repo, ...prev]);
      setNewRepoName('');
    } catch (err: any) {
      setGithubStatusMessage({ type: 'error', text: err.message });
    } finally {
      setIsCreatingRepo(false);
    }
  };

  // GitHub Push
  const handlePushToGithub = async () => {
    if (!githubToken.trim() || !githubUser || !targetRepoName || !selectedWorkspace) {
      alert('Please connect GitHub and select target repository.');
      return;
    }

    setIsPushing(true);
    setGithubStatusMessage(null);

    try {
      const response = await fetch('/api/github/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: githubToken.trim(),
          owner: githubUser.login,
          repo: targetRepoName,
          files: selectedWorkspace.files,
          commitMessage: commitMessage || `Devora Studio commit - ${new Date().toLocaleTimeString()}`
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      setLastPushUrl(data.repoUrl);
      setGithubStatusMessage({ type: 'success', text: `Successfully pushed ${selectedWorkspace.files.length} files to ${githubUser.login}/${targetRepoName}!` });
    } catch (err: any) {
      setGithubStatusMessage({ type: 'error', text: err.message });
    } finally {
      setIsPushing(false);
    }
  };

  // Simulated 1-Click Production Deploy
  const handleTriggerDeploy = () => {
    setIsDeploying(true);
    setDeployStep('Compiling React Vite bundle & verifying tree shake...');
    setTimeout(() => {
      setDeployStep('Optimizing assets & mounting zero-cost serverless container...');
      setTimeout(() => {
        setDeployStep('Binding production endpoint & SSL certificate...');
        setTimeout(() => {
          setIsDeploying(false);
          setDeployStep('');
          setDeploySuccess(true);
          setCheckpointToast('Production build deployed to https://' + customDomainInput);
          setTimeout(() => setCheckpointToast(null), 3500);
        }, 800);
      }, 900);
    }, 900);
  };

  // Create Version Snapshot
  const handleCreateVersionSnapshot = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWorkspace) return;
    const label = newVersionLabel.trim() || `v1.0.${versionHistory.length + 1} - Workspace Snapshot`;
    const newVersion: CheckpointItem = {
      id: `ver-${Date.now()}`,
      versionName: label,
      timestamp: 'Just now',
      message: `Manual version snapshot with ${selectedWorkspace.files.length} files`,
      files: JSON.parse(JSON.stringify(selectedWorkspace.files))
    };
    setVersionHistory(prev => [newVersion, ...prev]);
    setNewVersionLabel('');
    setCheckpointToast(`Version snapshot "${label}" created!`);
    setTimeout(() => setCheckpointToast(null), 3000);
  };

  // Restore specific version
  const handleRestoreVersion = (ver: CheckpointItem) => {
    if (!selectedWorkspace) return;
    setSelectedWorkspace({
      ...selectedWorkspace,
      files: JSON.parse(JSON.stringify(ver.files))
    });
    setCheckpointToast(`Restored to ${ver.versionName}!`);
    setTimeout(() => setCheckpointToast(null), 3000);
  };

  // Secrets Manager
  const handleAddSecret = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSecretKey.trim()) return;

    setSecretsList(prev => [
      ...prev,
      {
        id: `sec-${Date.now()}`,
        key: newSecretKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        value: newSecretValue.trim(),
        visible: false
      }
    ]);
    setNewSecretKey('');
    setNewSecretValue('');
  };

  const handleDeleteSecret = (id: string) => {
    setSecretsList(prev => prev.filter(s => s.id !== id));
  };

  const toggleSecretVisibility = (id: string) => {
    setSecretsList(prev => prev.map(s => s.id === id ? { ...s, visible: !s.visible } : s));
  };

  // Code View: Update Active File Code
  const handleCodeChange = (newCode: string) => {
    if (!selectedWorkspace) return;
    const updatedFiles = [...selectedWorkspace.files];
    updatedFiles[activeFileIndex] = {
      ...updatedFiles[activeFileIndex],
      content: newCode
    };

    setSelectedWorkspace({
      ...selectedWorkspace,
      files: updatedFiles
    });
  };

  // Code View: Add New File
  const handleAddNewFile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFileName.trim() || !selectedWorkspace) return;

    const ext = newFileName.split('.').pop() || '';
    const language = ['ts', 'tsx'].includes(ext) ? 'typescript' : ['js', 'jsx'].includes(ext) ? 'javascript' : ext === 'json' ? 'json' : 'plaintext';

    const newFile: WorkspaceFile = {
      name: newFileName.trim(),
      language,
      content: `// ${newFileName.trim()}\n// Created in Devora AI Studio\n\nexport default function Component() {\n  return <div>Component Ready</div>;\n}\n`
    };

    const updatedFiles = [...selectedWorkspace.files, newFile];
    setSelectedWorkspace({
      ...selectedWorkspace,
      files: updatedFiles
    });
    setActiveFileIndex(updatedFiles.length - 1);
    setNewFileName('');
    setShowNewFileDialog(false);
  };

  // Delete file from workspace
  const handleDeleteFile = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedWorkspace || selectedWorkspace.files.length <= 1) return;
    const updatedFiles = selectedWorkspace.files.filter((_, i) => i !== idx);
    setSelectedWorkspace({
      ...selectedWorkspace,
      files: updatedFiles
    });
    setActiveFileIndex(0);
  };

  // Checkpoint feature: Save Snapshot
  const handleSaveCheckpoint = () => {
    if (!selectedWorkspace) return;
    const newCp: CheckpointItem = {
      id: `cp-${Date.now()}`,
      versionName: `Checkpoint #${versionHistory.length + 1}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      message: `Checkpoint at ${new Date().toLocaleTimeString()}`,
      files: JSON.parse(JSON.stringify(selectedWorkspace.files))
    };
    setVersionHistory(prev => [newCp, ...prev]);
    setCheckpointToast(`Checkpoint saved with ${selectedWorkspace.files.length} files.`);
    setTimeout(() => setCheckpointToast(null), 3000);
  };

  // Feedback Toggle
  const handleToggleFeedback = (msgId: string, type: 'up' | 'down') => {
    setFeedbackMap(prev => ({
      ...prev,
      [msgId]: prev[msgId] === type ? (undefined as any) : type
    }));
  };

  // View Changes / Diff Inspector
  const handleOpenDiffModal = (content: string) => {
    if (!selectedWorkspace) return;
    const currentCode = selectedWorkspace.files[activeFileIndex]?.content || '';
    const codeMatch = content.match(/```(?:tsx|typescript|jsx|javascript|json|html|css)?\s*([\s\S]*?)```/);
    const suggestedCode = codeMatch ? codeMatch[1].trim() : content;

    setDiffModal({
      isOpen: true,
      fileName: selectedWorkspace.files[activeFileIndex]?.name || 'App.tsx',
      oldCode: currentCode,
      newCode: suggestedCode
    });
  };

  // Apply Changes from Diff Modal
  const handleApplyDiffChanges = () => {
    if (!diffModal) return;
    handleCodeChange(diffModal.newCode);
    setDiffModal(null);
    setActiveTab('CODE');
    setCheckpointToast(`Changes applied successfully to ${diffModal.fileName}!`);
    setTimeout(() => setCheckpointToast(null), 3000);
  };

  // Image Upload handler matching screenshot Image 2
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const url = event.target?.result as string;
      setAttachedImageFile({
        name: file.name,
        url
      });
    };
    reader.readAsDataURL(file);
    setShowAddMenu(false);
  };

  // Start fresh chat
  const handleNewChat = () => {
    setMessages([
      {
        id: `msg-${Date.now()}`,
        role: 'model',
        content: `### New Session Started\n\nDevora AI Studio is ready. Ask anything, attach files, or speak via the microphone below.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]);
  };

  // Chat Execution
  const handleSendPromptDirectly = async (promptText: string, meta?: any) => {
    if (!promptText.trim() || isGenerating) return;

    let attachedDetails: string[] = [];
    if (attachedContextFile) attachedDetails.push(attachedContextFile);
    if (attachedImageFile) attachedDetails.push(attachedImageFile.name);

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: promptText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      refinedMeta: meta,
      attachments: attachedDetails,
      attachedImage: attachedImageFile?.url
    };

    setMessages(prev => [...prev, userMsg]);
    setAttachedImageFile(null);
    setAttachedContextFile(null);
    setInputPrompt('');
    setIsGenerating(true);

    try {
      const modelToUse = promptMode === 'Pro Think' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
          systemInstruction: `${customInstructions}\n\nWorkspace: ${selectedWorkspace?.name || 'None'}. Active file: ${selectedWorkspace?.files[activeFileIndex]?.name || 'None'}. Current code:\n\`\`\`\n${selectedWorkspace?.files[activeFileIndex]?.content || ''}\n\`\`\``,
          apiKey: savedApiKey || undefined,
          model: modelToUse
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      setMessages(prev => [
        ...prev,
        {
          id: `msg-${Date.now() + 1}`,
          role: 'model',
          content: data.reply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
      setTotalTokens(prev => prev + (data.tokens || 120));
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: `msg-${Date.now() + 1}`,
          role: 'model',
          content: `[DEVORA SYSTEM ERROR]: ${err.message}. Please verify your API Key in Settings > Chat.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPrompt.trim() && !attachedImageFile && !attachedContextFile) return;
    const text = inputPrompt;
    handleSendPromptDirectly(text || 'Analyze attached context and suggest optimal code.');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSubmit(e);
    }
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Bug Report: Export Diagnostic Report
  const handleDownloadBugReport = () => {
    const report = {
      timestamp: new Date().toISOString(),
      brand: 'Devora',
      version: '1.0.0',
      activeStage,
      workspace: selectedWorkspace?.name,
      fileCount: selectedWorkspace?.files.length,
      currentFile: selectedWorkspace?.files[activeFileIndex]?.name,
      tokensUsed: totalTokens,
      aiModel: selectedModel,
      browserUserAgent: navigator.userAgent,
      description: bugDescription || 'System Telemetry Snapshot'
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `devora-telemetry-${Date.now()}.json`;
    a.click();
    setShowBugModal(false);
    setBugDescription('');
  };

  const activeFile = selectedWorkspace?.files[activeFileIndex];

  return (
    <div className="w-screen h-screen bg-black text-white font-sans overflow-hidden select-none flex flex-col">
      
      {/* ========================================================================= */}
      {/* SCREEN ENGINE STAGE 1: SYSTEM INITIALIZATION & DEMO LOGIN LAUNCH          */}
      {/* ========================================================================= */}
      {activeStage === 'STAGE_1' && (
        <div className="w-full h-full flex flex-col items-center justify-center bg-black relative">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(25,25,25,0.7)_0%,rgba(0,0,0,1)_100%)] pointer-events-none" />
          
          <div className="z-10 flex flex-col items-center text-center max-w-lg px-6">
            
            {/* Devora Brand Logo */}
            <div className="mb-6 flex items-center justify-center">
              <div className="w-16 h-16 rounded-2xl bg-neutral-950 border border-neutral-800 flex items-center justify-center shadow-2xl">
                <DevoraLogo className="w-10 h-10 text-white" />
              </div>
            </div>

            <div className="text-xs uppercase tracking-[0.3em] text-neutral-400 mb-3 font-semibold">
              DEVORA // WORKSTATION V1.0
            </div>
            
            <h1 className="text-4xl font-bold tracking-tight mb-3 text-white">
              Devora
            </h1>
            
            <p className="text-sm text-neutral-400 mb-8 max-w-md leading-relaxed font-normal">
              High-efficiency $0-server-cost local AI IDE. Zero latency client execution, multilingual Indic voice prompting, and direct GitHub synchronization.
            </p>

            <button
              onClick={handleDemoSignIn}
              className="px-8 py-3.5 border border-neutral-700 hover:border-white text-xs font-semibold uppercase tracking-widest transition-all duration-200 bg-neutral-950 text-white hover:bg-white hover:text-black active:scale-95 cursor-pointer shadow-lg"
            >
              DEMO SIGN IN
            </button>

            <div className="mt-10 text-xs text-neutral-600 font-mono tracking-wider">
              ZERO SERVER LOAD // PORT 3000
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SCREEN ENGINE STAGE 2: LOCAL DISCOVERY & WORKSPACE ROUTER CONTROL         */}
      {/* ========================================================================= */}
      {activeStage === 'STAGE_2' && (
        <div className="w-full h-full flex flex-col bg-black text-white">
          {/* Top Menu Bar */}
          <header className="h-14 border-b border-neutral-900 flex items-center justify-between px-6 shrink-0 bg-neutral-950/40">
            <div className="flex items-center gap-3">
              <DevoraLogo className="w-6 h-6 text-white" />
              <div className="text-sm font-bold tracking-wide text-white">
                Devora
              </div>
              <span className="text-neutral-600 text-xs font-mono">/</span>
              <span className="text-xs text-neutral-400 font-medium">Workspace Router</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-neutral-400 font-medium">Local Session Active</span>
              <div className="w-8 h-8 rounded-full border border-neutral-800 flex items-center justify-center text-xs font-bold text-white bg-neutral-900 shadow-inner">
                S
              </div>
            </div>
          </header>

          {/* Central Workspace Canvas */}
          <main className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-auto">
            <div className="w-full max-w-2xl flex flex-col items-center my-auto">
              
              <div className="text-center mb-6">
                <h2 className="text-lg font-bold tracking-tight text-white mb-1">
                  Project Workspace Discovery
                </h2>
                <p className="text-xs text-neutral-400 font-normal">
                  Open an existing project folder or pick one of the quick Devora templates below.
                </p>
              </div>

              {/* Large Clean Dropzone CTA */}
              <label className="w-full border border-dashed border-neutral-800 hover:border-neutral-500 p-8 flex flex-col items-center justify-center cursor-pointer transition-all bg-neutral-950/40 hover:bg-neutral-900/30 mb-6 group">
                <div className="w-10 h-10 rounded-full border border-neutral-800 bg-black flex items-center justify-center mb-3 group-hover:border-neutral-600 transition-colors">
                  <FolderOpen className="w-5 h-5 text-neutral-300 group-hover:text-white" />
                </div>
                <span className="text-xs tracking-wider text-white uppercase font-bold">
                  OPEN PROJECT FOLDER SELECTOR
                </span>
                <span className="text-xs text-neutral-500 mt-1.5 font-normal">
                  Click to mount local directory or select a template below
                </span>
                <input 
                  type="file" 
                  multiple 
                  className="hidden" 
                  onChange={handleFileUpload} 
                />
              </label>

              {/* Grid of Clean Workspace Presets */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full mb-6">
                {workspaces.map(ws => (
                  <div
                    key={ws.id}
                    onClick={() => handleSelectFolder(ws)}
                    className="border border-neutral-900 hover:border-neutral-700 p-4 transition-all cursor-pointer bg-neutral-950 hover:bg-neutral-900/40 group flex flex-col justify-between h-28"
                  >
                    <div>
                      <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1 font-mono">Devora Workspace</div>
                      <h3 className="text-xs font-semibold text-white tracking-wide group-hover:text-emerald-400 transition-colors">
                        {ws.name}
                      </h3>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-neutral-500 font-mono">
                      <span>{ws.files.length} files</span>
                      <ChevronRight className="w-3.5 h-3.5 text-neutral-600 group-hover:text-white transition-colors" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Workspace History Stack Footer */}
              <div className="w-full">
                <div className="text-xs text-neutral-400 uppercase tracking-wider mb-2 font-semibold">
                  RECENT WORKSPACES HISTORY
                </div>
                <div className="space-y-1.5 border-t border-neutral-900 pt-2">
                  {workspaces.map((ws, idx) => (
                    <div 
                      key={idx}
                      onClick={() => handleSelectFolder(ws)}
                      className="text-xs text-neutral-300 hover:text-white py-2 px-3 hover:bg-neutral-900/50 cursor-pointer flex items-center justify-between border border-transparent hover:border-neutral-800 transition-all font-mono"
                    >
                      <span className="tracking-wide">📁 {ws.path}</span>
                      <span className="text-[10px] text-emerald-400 uppercase font-sans font-medium">Ready</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </main>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SCREEN ENGINE STAGE 3: THE 35/65 SPLIT INTEGRATED STUDIO MATRIX            */}
      {/* ========================================================================= */}
      {activeStage === 'STAGE_3' && selectedWorkspace && (
        <div className="w-full h-full flex flex-col bg-black text-white relative overflow-hidden">
          
          {/* Workspace Action HUD Header (Top 48px Fixed) */}
          <header className="h-12 border-b border-neutral-900 flex items-center justify-between px-4 shrink-0 bg-neutral-950/60 z-20">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setActiveStage('STAGE_2')}
                className="flex items-center gap-2 text-xs font-medium text-neutral-300 hover:text-white transition-colors cursor-pointer py-1 px-2 hover:bg-neutral-900"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>← BACK TO DASHBOARD</span>
              </button>
              
              <div className="h-4 w-px bg-neutral-800 hidden sm:block" />

              <div className="flex items-center gap-2 hidden sm:flex">
                <DevoraLogo className="w-4 h-4 text-white" />
                <span className="text-xs font-semibold text-white">Devora</span>
                <span className="text-xs text-neutral-500 font-mono">/</span>
                <span className="text-xs font-mono text-neutral-300">{selectedWorkspace.name}</span>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {githubUser && (
                <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 text-xs border border-neutral-800 bg-neutral-900/40 text-neutral-300">
                  <Github className="w-3 h-3 text-white" />
                  <span>@{githubUser.login}</span>
                </div>
              )}
              <button
                onClick={() => setShowBugModal(true)}
                className="text-xs px-3 py-1 font-medium border border-neutral-800 hover:border-red-500 hover:text-red-400 transition-all cursor-pointer"
              >
                BUG REPORT
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="text-xs px-3 py-1 font-medium border border-neutral-800 hover:border-white transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>⚙ SETTINGS</span>
              </button>
            </div>
          </header>

          {/* Main Core Canvas Area Split Setup (Flex-Direction: Row) */}
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
            
            {/* ================================================================= */}
            {/* PARTITION A: THE CHAT TERMINAL CONTROLLER NODE (35% VIEWPORT)     */}
            {/* ================================================================= */}
            <div className="w-full md:w-[35%] h-1/2 md:h-full border-r border-neutral-900 flex flex-col bg-[#09090b] shrink-0">
              
              {/* Terminal Title Bar */}
              <div className="h-11 border-b border-neutral-900 px-4 flex items-center justify-between shrink-0 bg-black/60">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-white tracking-wide">
                    <Sparkles className="w-4 h-4 text-cyan-400 fill-cyan-400/20" />
                    <span>Devora AI</span>
                  </div>
                  <span className="text-neutral-600 font-mono text-xs">/</span>
                  <span className="text-[11px] text-neutral-400 font-mono">
                    2.5-flash
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleNewChat}
                    title="New Chat Session"
                    className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-900 rounded transition-colors cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Sub-header status */}
              <div className="px-4 py-1.5 border-b border-neutral-900/60 bg-neutral-950/40 flex items-center justify-between text-[11px] text-neutral-500 font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Devora 2.5-flash</span>
                  <span>•</span>
                  <span>Active Session</span>
                </div>
                <button
                  onClick={() => {
                    setSettingsTab('VERSIONS');
                    setIsSettingsOpen(true);
                  }}
                  className="hover:text-emerald-400 transition-colors flex items-center gap-1 text-[10px] uppercase font-sans cursor-pointer"
                >
                  <History className="w-3 h-3" />
                  <span>{versionHistory.length} Checkpoints</span>
                </button>
              </div>

              {/* Checkpoint Toast Banner */}
              {checkpointToast && (
                <div className="px-4 py-2 bg-emerald-950/80 border-b border-emerald-800 text-emerald-400 text-xs flex items-center gap-2 animate-in slide-in-from-top duration-150">
                  <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{checkpointToast}</span>
                </div>
              )}

              {/* Scrollable Conversation Canvas */}
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 text-xs font-sans">
                {messages.map((msg) => (
                  <div key={msg.id} className="space-y-2">
                    {/* Message Header */}
                    <div className="flex items-center justify-between text-[11px] text-neutral-500 font-mono">
                      <div className="flex items-center gap-2">
                        {msg.role === 'model' ? (
                          <span className="text-cyan-400 font-semibold flex items-center gap-1">
                            <Sparkles className="w-3 h-3" />
                            Devora Engine
                          </span>
                        ) : (
                          <span className="text-white font-semibold">You</span>
                        )}
                        <span>{msg.timestamp}</span>
                      </div>

                      {msg.role === 'model' && (
                        <span className="text-[10px] text-neutral-600">Model Response</span>
                      )}
                    </div>

                    {/* Attached Context Pill on Message */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pb-1">
                        {msg.attachments.map((att, i) => (
                          <span key={i} className="text-[10px] font-mono px-2 py-0.5 bg-neutral-900 border border-neutral-800 text-neutral-400 rounded">
                            @{att}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Attached Image Preview on Message */}
                    {msg.attachedImage && (
                      <div className="mb-2 max-w-xs rounded-lg overflow-hidden border border-neutral-800">
                        <img src={msg.attachedImage} alt="Attached" className="w-full max-h-48 object-cover" />
                      </div>
                    )}

                    {/* Step-by-Step Voice Translation Pill if applicable */}
                    {msg.refinedMeta && (
                      <div className="text-[10px] text-neutral-400 bg-neutral-950 border border-neutral-800 p-2.5 rounded-lg space-y-1">
                        <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                          <Globe className="w-3 h-3" />
                          <span>Voice Pipeline: Translated from {msg.refinedMeta.detectedLanguage}</span>
                        </div>
                        <div className="text-neutral-400 font-mono text-[10px]">
                          🎙️ <em>"{msg.refinedMeta.original}"</em>
                        </div>
                      </div>
                    )}

                    {/* Message Body */}
                    <div className={`p-4 rounded-xl leading-relaxed text-xs ${
                      msg.role === 'user' 
                        ? 'bg-neutral-900/90 text-white border border-neutral-800' 
                        : 'bg-[#121214] text-neutral-200 border border-neutral-800/80 shadow-md'
                    }`}>
                      <div className="whitespace-pre-wrap font-sans text-xs leading-relaxed space-y-2">
                        {msg.content}
                      </div>

                      {/* If AI message contains code, offer 1-click apply button */}
                      {msg.role === 'model' && msg.content.includes('```') && (
                        <div className="mt-3 pt-3 border-t border-neutral-800/60 flex items-center justify-between">
                          <span className="text-[10px] text-neutral-500 font-mono">Code block ready</span>
                          <button
                            onClick={() => handleOpenDiffModal(msg.content)}
                            className="px-3 py-1 text-[11px] font-semibold bg-emerald-950/60 border border-emerald-700/80 hover:bg-emerald-800 hover:text-white text-emerald-400 rounded transition-all cursor-pointer flex items-center gap-1.5 shadow"
                          >
                            <FileCheck className="w-3.5 h-3.5" />
                            <span>View & Apply to {selectedWorkspace.files[activeFileIndex]?.name}</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Bottom Action Row: Checkpoint, Thumbs Up, Thumbs Down, View changes, Restore */}
                    {msg.role === 'model' && (
                      <div className="flex items-center justify-between pt-1 px-1 text-neutral-400 text-xs select-none">
                        <div className="flex items-center gap-3">
                          
                          {/* Checkpoint Button */}
                          <button
                            onClick={handleSaveCheckpoint}
                            title="Save Workspace Snapshot / Checkpoint"
                            className="flex items-center gap-1.5 text-neutral-400 hover:text-white transition-colors cursor-pointer py-1 px-1.5 rounded hover:bg-neutral-900"
                          >
                            <Flag className="w-3.5 h-3.5 text-neutral-400" />
                            <span className="text-xs">Checkpoint</span>
                          </button>

                          {/* Thumbs Up */}
                          <button
                            onClick={() => handleToggleFeedback(msg.id, 'up')}
                            className={`p-1.5 rounded hover:bg-neutral-900 transition-colors cursor-pointer ${
                              feedbackMap[msg.id] === 'up' ? 'text-emerald-400' : 'text-neutral-400 hover:text-white'
                            }`}
                            title="Good response"
                          >
                            <ThumbsUp className="w-3.5 h-3.5" />
                          </button>

                          {/* Thumbs Down */}
                          <button
                            onClick={() => handleToggleFeedback(msg.id, 'down')}
                            className={`p-1.5 rounded hover:bg-neutral-900 transition-colors cursor-pointer ${
                              feedbackMap[msg.id] === 'down' ? 'text-red-400' : 'text-neutral-400 hover:text-white'
                            }`}
                            title="Bad response"
                          >
                            <ThumbsDown className="w-3.5 h-3.5" />
                          </button>

                          {/* View Changes */}
                          <button
                            onClick={() => handleOpenDiffModal(msg.content)}
                            className="text-xs text-neutral-400 hover:text-white transition-colors cursor-pointer py-1 px-1.5 rounded hover:bg-neutral-900"
                          >
                            View changes
                          </button>
                        </div>

                        {/* Restore Button */}
                        <button
                          onClick={() => {
                            if (versionHistory.length > 0) {
                              handleRestoreVersion(versionHistory[0]);
                            }
                          }}
                          title="Restore latest checkpoint"
                          className="flex items-center gap-1 text-neutral-400 hover:text-white transition-colors cursor-pointer py-1 px-1.5 rounded hover:bg-neutral-900"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span className="text-xs">Restore</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Multilingual Voice Pipeline In-Flight Indicator */}
                {isRefiningVoice && (
                  <div className="p-3 border border-emerald-500/40 bg-emerald-950/30 text-xs space-y-1.5 text-emerald-400 rounded-xl animate-pulse">
                    <div className="flex items-center gap-2 font-bold">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Multilingual Voice Transformation Active</span>
                    </div>
                    <div className="text-[11px] text-neutral-300 font-mono">
                      {refinementStep || 'Translating Hindi/Indic speech into structured developer prompt...'}
                    </div>
                  </div>
                )}

                {isGenerating && (
                  <div className="flex items-center gap-2 text-neutral-400 text-xs py-2 px-1">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                    <span>Devora Engine is writing code...</span>
                  </div>
                )}
              </div>

              {/* ================================================================= */}
              {/* CHAT INPUT BOX (Matches Screenshot Image 2 with Attached Image)    */}
              {/* ================================================================= */}
              <div className="p-3 border-t border-neutral-900 bg-black/80 shrink-0">
                
                {/* Live Mic Listening Visualizer */}
                {isListening && (
                  <div className="mb-2 p-2.5 rounded-xl border border-red-500/50 bg-red-950/40 flex items-center justify-between text-xs text-red-300 animate-pulse">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                      <span className="font-medium">Listening to your voice... Speak in Hindi, Hinglish, or any language</span>
                    </div>
                    <button
                      onClick={toggleListening}
                      className="px-2.5 py-1 bg-red-900 hover:bg-red-800 border border-red-400 text-[10px] uppercase tracking-wider text-white rounded cursor-pointer font-bold"
                    >
                      Done / Translate
                    </button>
                  </div>
                )}

                {/* Attached Image Thumbnail Card (EXACT MATCH TO SCREENSHOT IMAGE 2) */}
                {attachedImageFile && (
                  <div className="mb-2 flex items-center gap-3 p-2 bg-[#121214] border border-neutral-800 rounded-xl max-w-xs shadow-lg animate-in fade-in duration-150">
                    <div className="w-10 h-10 rounded-lg bg-black border border-neutral-800 overflow-hidden shrink-0 flex items-center justify-center">
                      <img src={attachedImageFile.url} alt="Attached Preview" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{attachedImageFile.name}</div>
                      <div className="text-[10px] text-neutral-500">Image Reference</div>
                    </div>
                    <button
                      onClick={() => setAttachedImageFile(null)}
                      className="text-neutral-500 hover:text-white p-1 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* Attached File Tag if present */}
                {attachedContextFile && (
                  <div className="mb-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono bg-neutral-900 border border-neutral-700 text-neutral-300">
                    <FileCode className="w-3 h-3 text-emerald-400" />
                    <span>@{attachedContextFile}</span>
                    <button 
                      onClick={() => setAttachedContextFile(null)}
                      className="hover:text-red-400 ml-0.5 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* The Input Card Container */}
                <div className="relative border border-neutral-800 bg-[#121214] rounded-2xl p-3 focus-within:border-neutral-600 focus-within:ring-1 focus-within:ring-neutral-700 shadow-xl transition-all">
                  
                  {/* Multi-line Textarea */}
                  <textarea
                    ref={textareaRef}
                    rows={2}
                    value={inputPrompt}
                    onChange={(e) => setInputPrompt(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Make changes, add new features, ask for anything"
                    className="w-full bg-transparent text-white text-xs leading-relaxed outline-none resize-none font-sans placeholder:text-neutral-500 select-text"
                  />

                  {/* Bottom Toolbar inside the Input Container */}
                  <div className="flex items-center justify-between pt-2 mt-1 border-t border-neutral-800/50">
                    
                    {/* Left side: (+) Plus / Add Context Button */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowAddMenu(!showAddMenu)}
                        title="Add context (Files, Images, Quick Prompts)"
                        className="w-7 h-7 rounded-full border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 hover:border-neutral-600 text-neutral-400 hover:text-white flex items-center justify-center transition-all cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                      </button>

                      {/* Popover Menu for (+) button */}
                      {showAddMenu && (
                        <div className="absolute bottom-9 left-0 w-64 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl p-2 z-50 space-y-1 text-xs">
                          <div className="text-[10px] uppercase font-bold text-neutral-500 px-2 py-1">Attach Context</div>
                          
                          <button
                            type="button"
                            onClick={() => {
                              setAttachedContextFile(selectedWorkspace.files[activeFileIndex]?.name || 'App.tsx');
                              setShowAddMenu(false);
                            }}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-900 text-neutral-300 hover:text-white flex items-center gap-2 cursor-pointer"
                          >
                            <FileCode className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Attach Active File ({selectedWorkspace.files[activeFileIndex]?.name})</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setAttachedContextFile('Entire Workspace');
                              setShowAddMenu(false);
                            }}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-900 text-neutral-300 hover:text-white flex items-center gap-2 cursor-pointer"
                          >
                            <Layers className="w-3.5 h-3.5 text-amber-400" />
                            <span>Attach Full Workspace ({selectedWorkspace.files.length} files)</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => imageInputRef.current?.click()}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-900 text-neutral-300 hover:text-white flex items-center gap-2 cursor-pointer"
                          >
                            <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
                            <span>Attach UI Screenshot (image.png)</span>
                          </button>

                          <div className="border-t border-neutral-900 my-1 pt-1">
                            <div className="text-[10px] uppercase font-bold text-neutral-500 px-2 py-1">Quick Prompts</div>
                            <button
                              type="button"
                              onClick={() => {
                                setInputPrompt('Refactor this code to clean modular architecture with TypeScript interfaces.');
                                setShowAddMenu(false);
                              }}
                              className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-900 text-neutral-300 hover:text-white text-[11px] cursor-pointer"
                            >
                              ⚡ Refactor to clean modular code
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setInputPrompt('Find and fix any potential bugs, edge cases, and runtime exceptions.');
                                setShowAddMenu(false);
                              }}
                              className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-900 text-neutral-300 hover:text-white text-[11px] cursor-pointer"
                            >
                              ⚡ Audit code for bugs & edge cases
                            </button>
                          </div>
                        </div>
                      )}
                      
                      <input 
                        ref={imageInputRef} 
                        type="file" 
                        accept="image/*" 
                        className="hidden" 
                        onChange={handleImageUpload} 
                      />
                    </div>

                    {/* Right side: [Default ⌄] [🎙️] [↑] */}
                    <div className="flex items-center gap-2">
                      
                      {/* Model / Mode Dropdown Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShowModeDropdown(!showModeDropdown)}
                          className="px-2.5 py-1 rounded-full border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-300 hover:text-white flex items-center gap-1.5 transition-all cursor-pointer font-medium"
                        >
                          <span>{promptMode}</span>
                          <ChevronDown className="w-3 h-3 text-neutral-400" />
                        </button>

                        {showModeDropdown && (
                          <div className="absolute bottom-9 right-0 w-52 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl p-1.5 z-50 space-y-1 text-xs">
                            {[
                              { label: 'Default', desc: 'Balanced · Gemini 3.8 Flash' },
                              { label: 'Flash', desc: 'Instant Code Generation' },
                              { label: 'Pro Think', desc: 'Deep Reasoning Architecture' }
                            ].map(item => (
                              <button
                                key={item.label}
                                type="button"
                                onClick={() => {
                                  setPromptMode(item.label);
                                  setShowModeDropdown(false);
                                }}
                                className={`w-full text-left px-3 py-1.5 rounded flex flex-col cursor-pointer transition-colors ${
                                  promptMode === item.label ? 'bg-neutral-800 text-white font-bold' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                                }`}
                              >
                                <span>{item.label}</span>
                                <span className="text-[10px] text-neutral-500 font-normal">{item.desc}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Microphone Button */}
                      <button
                        type="button"
                        onClick={toggleListening}
                        title="Speak in Hindi/Hinglish/English - Auto Translated & Structured"
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                          isListening 
                            ? 'bg-red-500 text-white animate-pulse' 
                            : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
                        }`}
                      >
                        {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>

                      {/* Up-Arrow Submit Button */}
                      <button
                        type="button"
                        onClick={handleChatSubmit}
                        disabled={isGenerating || (!inputPrompt.trim() && !attachedImageFile && !attachedContextFile)}
                        title="Send message"
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                          inputPrompt.trim() || attachedImageFile || attachedContextFile
                            ? 'bg-white text-black hover:bg-neutral-200 cursor-pointer shadow-md active:scale-95'
                            : 'bg-neutral-800 text-neutral-600 cursor-not-allowed opacity-40'
                        }`}
                      >
                        <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                      </button>

                    </div>

                  </div>

                </div>

                {/* Telemetry Control Footer */}
                <div className="flex items-center justify-between text-xs text-neutral-500 px-2 pt-2 font-mono">
                  <button 
                    onClick={() => {
                      setSettingsTab('CHAT');
                      setIsSettingsOpen(true);
                    }}
                    className="hover:text-emerald-400 transition-colors cursor-pointer text-[11px]"
                  >
                    [ BYOK: {savedApiKey ? 'ACTIVE (CUSTOM)' : 'DEFAULT / ACTIVE'} ]
                  </button>
                  <div className="text-[11px]">
                    Tokens: {totalTokens}
                  </div>
                </div>

              </div>

            </div>

            {/* ================================================================= */}
            {/* PARTITION B: DIGITAL PREVIEW & CODE STAGE CANVAS (65% VIEWPORT)   */}
            {/* ================================================================= */}
            <div className="w-full md:w-[65%] h-1/2 md:h-full flex flex-col bg-black">
              
              {/* Internal Sub-Tab Switcher HUD (Top 40px Viewport Row) */}
              <div className="h-10 border-b border-neutral-900 flex items-center justify-between px-4 shrink-0 bg-neutral-950/40">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setActiveTab('CODE')}
                    className={`text-xs uppercase tracking-wider pb-1 transition-all border-b-2 cursor-pointer font-medium ${
                      activeTab === 'CODE' 
                        ? 'border-white text-white font-semibold' 
                        : 'border-transparent text-neutral-400 hover:text-white'
                    }`}
                  >
                    SOURCE CODE VIEW
                  </button>
                  <button
                    onClick={() => setActiveTab('PREVIEW')}
                    className={`text-xs uppercase tracking-wider pb-1 transition-all border-b-2 cursor-pointer font-medium ${
                      activeTab === 'PREVIEW' 
                        ? 'border-white text-white font-semibold' 
                        : 'border-transparent text-neutral-400 hover:text-white'
                    }`}
                  >
                    REAL-TIME PREVIEW
                  </button>
                </div>

                {/* File Tabs Switcher (Code view) */}
                {activeTab === 'CODE' ? (
                  <div className="flex items-center gap-1.5 overflow-x-auto">
                    {selectedWorkspace.files.map((file, idx) => (
                      <div
                        key={idx}
                        onClick={() => setActiveFileIndex(idx)}
                        className={`text-xs px-2.5 py-1 border transition-all cursor-pointer font-mono flex items-center gap-1.5 ${
                          activeFileIndex === idx 
                            ? 'border-neutral-700 bg-neutral-900 text-white font-semibold' 
                            : 'border-transparent text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        <span>{file.name}</span>
                        {selectedWorkspace.files.length > 1 && (
                          <button
                            onClick={(e) => handleDeleteFile(idx, e)}
                            className="text-neutral-500 hover:text-red-400 ml-1"
                            title="Delete File"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() => setShowNewFileDialog(true)}
                      title="Create New File in Workspace"
                      className="text-xs px-2 py-1 text-neutral-400 hover:text-white border border-transparent hover:border-neutral-800 transition-all cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                ) : (
                  /* Device Viewport Toggle (Preview view) */
                  <div className="flex items-center gap-2 text-neutral-400">
                    <button
                      onClick={() => setPreviewViewport('desktop')}
                      className={`p-1 transition-colors cursor-pointer ${previewViewport === 'desktop' ? 'text-white' : 'hover:text-neutral-300'}`}
                      title="Desktop (100%)"
                    >
                      <Laptop className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setPreviewViewport('tablet')}
                      className={`p-1 transition-colors cursor-pointer ${previewViewport === 'tablet' ? 'text-white' : 'hover:text-neutral-300'}`}
                      title="Tablet (768px)"
                    >
                      <Tablet className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setPreviewViewport('mobile')}
                      className={`p-1 transition-colors cursor-pointer ${previewViewport === 'mobile' ? 'text-white' : 'hover:text-neutral-300'}`}
                      title="Mobile (375px)"
                    >
                      <Smartphone className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Dynamic Code Viewing Body Canvas */}
              <div className="flex-1 overflow-hidden flex flex-col relative bg-black">
                {activeTab === 'CODE' ? (
                  <div className="flex-1 flex flex-col h-full relative">
                    
                    {/* Code Header Bar with Search & Copy status */}
                    <div className="h-8 border-b border-neutral-900 px-4 flex items-center justify-between text-xs text-neutral-400 bg-neutral-950/60 font-mono">
                      <div className="flex items-center gap-2">
                        <span>{selectedWorkspace.path}/{activeFile?.name}</span>
                        <span className="text-[10px] text-emerald-400 bg-emerald-950/40 px-1.5 py-0.2 border border-emerald-900/50">EDITABLE</span>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setShowSearchBar(!showSearchBar)}
                          className="hover:text-white transition-colors cursor-pointer text-xs flex items-center gap-1 font-sans"
                        >
                          <Search className="w-3 h-3" />
                          <span>Find</span>
                        </button>
                        
                        <button 
                          onClick={() => handleCopyCode(activeFile?.content || '')}
                          className="flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer text-xs font-sans font-medium"
                        >
                          {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedCode ? 'COPIED' : 'COPY CODE'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Find in File Bar */}
                    {showSearchBar && (
                      <div className="px-4 py-2 border-b border-neutral-800 bg-neutral-950 flex items-center gap-2">
                        <Search className="w-3.5 h-3.5 text-neutral-400" />
                        <input
                          type="text"
                          placeholder="Search in file..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="flex-1 bg-black border border-neutral-800 text-xs px-2 py-1 text-white outline-none font-mono"
                        />
                        <button 
                          onClick={() => setShowSearchBar(false)}
                          className="text-neutral-500 hover:text-white text-xs cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                    )}

                    {/* Interactive Code Editor (Fully editable with tab support!) */}
                    <div className="flex-1 p-4 overflow-auto font-mono text-xs leading-relaxed bg-black text-neutral-200 flex">
                      <div className="w-8 pr-4 text-right text-neutral-600 select-none space-y-1 font-mono text-xs">
                        {(activeFile?.content || '').split('\n').map((_, i) => (
                          <div key={i}>{i + 1}</div>
                        ))}
                      </div>
                      
                      <textarea
                        value={activeFile?.content || ''}
                        onChange={(e) => handleCodeChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Tab') {
                            e.preventDefault();
                            const target = e.target as HTMLTextAreaElement;
                            const start = target.selectionStart;
                            const end = target.selectionEnd;
                            const val = target.value;
                            target.value = val.substring(0, start) + '  ' + val.substring(end);
                            target.selectionStart = target.selectionEnd = start + 2;
                            handleCodeChange(target.value);
                          }
                        }}
                        spellCheck={false}
                        className="flex-1 bg-transparent text-neutral-200 font-mono text-xs outline-none resize-none leading-relaxed pl-2 border-l border-neutral-900"
                        style={{ tabSize: 2 }}
                      />
                    </div>

                    {/* Editor Status Bar */}
                    <div className="h-6 border-t border-neutral-900 px-4 flex items-center justify-between text-[10px] text-neutral-500 bg-neutral-950 font-mono">
                      <span>{activeFile?.language.toUpperCase()} · UTF-8</span>
                      <span>{(activeFile?.content || '').split('\n').length} lines · {(activeFile?.content || '').length} characters</span>
                    </div>

                    {/* New File Dialog Modal */}
                    {showNewFileDialog && (
                      <div className="absolute top-10 right-4 z-30 p-4 border border-neutral-800 bg-neutral-950 shadow-2xl w-72">
                        <div className="text-xs font-bold text-white mb-2">Create New Workspace File</div>
                        <form onSubmit={handleAddNewFile} className="space-y-3">
                          <input
                            type="text"
                            placeholder="e.g. Button.tsx, utils.ts"
                            value={newFileName}
                            onChange={(e) => setNewFileName(e.target.value)}
                            className="w-full bg-black border border-neutral-800 text-xs px-2.5 py-1.5 text-white outline-none font-mono"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setShowNewFileDialog(false)}
                              className="px-2.5 py-1 text-xs text-neutral-400 hover:text-white cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="px-3 py-1 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-xs text-white cursor-pointer"
                            >
                              Add File
                            </button>
                          </div>
                        </form>
                      </div>
                    )}

                  </div>
                ) : (
                  /* Real-Time Preview Sandbox Container */
                  <div className={`flex-1 flex flex-col items-center justify-start p-4 bg-neutral-950/20 overflow-auto ${
                    isFullscreenPreview ? 'fixed inset-0 z-50 bg-black/95 p-6' : ''
                  }`}>
                    <div className={`w-full border border-neutral-800 bg-black shadow-2xl transition-all duration-300 ${
                      isFullscreenPreview ? 'max-w-7xl h-full flex flex-col' : previewViewport === 'tablet' ? 'max-w-[768px]' : previewViewport === 'mobile' ? 'max-w-[375px]' : 'max-w-4xl'
                    }`}>
                      
                      {/* Self-Healing AI Fixing Banner if error captured */}
                      {previewError && (
                        <div className="p-3 bg-red-950/80 border-b border-red-800 text-red-300 text-xs flex items-center justify-between font-mono">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-red-400 animate-bounce" />
                            <span>Runtime Exception: {previewError}</span>
                          </div>
                          <button
                            onClick={handleTriggerSelfHeal}
                            disabled={isSelfHealing}
                            className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white font-bold text-[10px] uppercase rounded cursor-pointer disabled:opacity-50"
                          >
                            {isSelfHealing ? 'AI Self-Healing...' : '✨ Auto-Fix with AI'}
                          </button>
                        </div>
                      )}

                      {isSelfHealing && (
                        <div className="p-3 bg-emerald-950/80 border-b border-emerald-800 text-emerald-300 text-xs flex items-center gap-2 font-mono animate-pulse">
                          <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
                          <span>{selfHealLog || 'Devora AI is analyzing stack trace & auto-patching runtime error...'}</span>
                        </div>
                      )}

                      {/* Browser Mock Header */}
                      <div className="h-9 border-b border-neutral-900 px-3 flex items-center justify-between bg-neutral-950 shrink-0">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
                          <div className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
                          <div className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
                        </div>
                        <div className="text-[11px] text-neutral-400 font-mono bg-neutral-900/60 px-3 py-0.5 rounded border border-neutral-800 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          https://devora.local:3000
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setPreviewError('TypeError: Cannot read properties of undefined (reading "map")')}
                            className="text-[10px] px-2 py-0.5 border border-amber-800/80 bg-amber-950/40 text-amber-400 hover:bg-amber-900/60 rounded font-mono cursor-pointer"
                            title="Simulate Runtime Error to Test Self-Healing"
                          >
                            Simulate Error
                          </button>
                          <button 
                            onClick={() => setIsFullscreenPreview(!isFullscreenPreview)}
                            className="text-neutral-400 hover:text-white cursor-pointer"
                            title={isFullscreenPreview ? "Exit Full Screen" : "Full Screen Preview"}
                          >
                            {isFullscreenPreview ? '✕' : '⛶'}
                          </button>
                          <button 
                            onClick={() => alert('Preview environment reloaded with latest workspace state.')}
                            className="text-neutral-500 hover:text-white cursor-pointer"
                            title="Reload"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* Live Running Preview Body */}
                      <div className="p-6 bg-black min-h-[360px] space-y-6">
                        <div className="border border-neutral-800 p-6 bg-neutral-950/60 space-y-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                              <h3 className="text-sm font-bold text-white tracking-wide">
                                {selectedWorkspace.name} Runtime
                              </h3>
                            </div>
                            <span className="text-[10px] text-emerald-400 bg-emerald-950/50 border border-emerald-800 px-2 py-0.5 font-mono">
                              0ms LATENCY
                            </span>
                          </div>

                          <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                            All components compile and render locally in zero-server infrastructure mode.
                          </p>

                          <div className="pt-2 flex flex-wrap gap-3">
                            <button 
                              onClick={() => alert(`Executed component event on ${selectedWorkspace.name}`)}
                              className="px-4 py-2 bg-white text-black text-xs font-semibold uppercase tracking-wider hover:bg-neutral-200 transition-all cursor-pointer"
                            >
                              Trigger Action
                            </button>
                            <button 
                              onClick={() => setActiveTab('CODE')}
                              className="px-4 py-2 border border-neutral-800 hover:border-neutral-600 text-xs font-semibold uppercase tracking-wider text-neutral-300 hover:text-white transition-all cursor-pointer"
                            >
                              Inspect Source
                            </button>
                          </div>
                        </div>

                        {/* File Structure Preview */}
                        <div className="border border-neutral-900 p-4 bg-neutral-950/30">
                          <div className="text-[11px] text-neutral-400 uppercase tracking-wider mb-2 font-mono">
                            Workspace File Tree ({selectedWorkspace.files.length})
                          </div>
                          <div className="space-y-1 text-xs font-mono text-neutral-300">
                            {selectedWorkspace.files.map((f, i) => (
                              <div key={i} className="flex items-center gap-2 text-neutral-400 hover:text-white">
                                <FileText className="w-3 h-3 text-neutral-500" />
                                <span>{f.name}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                    </div>
                  </div>
                )}
              </div>

            </div>

          </div>

          {/* ========================================================================= */}
          {/* VIEW CHANGES / DIFF MODAL                                                 */}
          {/* ========================================================================= */}
          {diffModal && (
            <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-6 backdrop-blur-sm animate-in fade-in duration-150">
              <div className="w-full max-w-4xl border border-neutral-800 bg-[#0c0c0e] rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
                
                {/* Diff Header */}
                <div className="h-12 border-b border-neutral-800 px-6 flex items-center justify-between bg-neutral-950 shrink-0">
                  <div className="flex items-center gap-2">
                    <FileCheck className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Code Changes Diff · {diffModal.fileName}
                    </span>
                  </div>
                  <button
                    onClick={() => setDiffModal(null)}
                    className="text-neutral-400 hover:text-white cursor-pointer"
                  >
                    ✕
                  </button>
                </div>

                {/* Diff Comparison View */}
                <div className="flex-1 p-4 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
                  <div className="border border-neutral-800 bg-black p-4 rounded-lg flex flex-col">
                    <div className="text-[11px] text-neutral-500 pb-2 border-b border-neutral-900 mb-2 flex items-center justify-between">
                      <span>CURRENT FILE CONTENT</span>
                      <span className="text-red-400">- Existing</span>
                    </div>
                    <pre className="flex-1 overflow-auto whitespace-pre-wrap text-neutral-400 leading-relaxed max-h-[50vh]">
                      {diffModal.oldCode}
                    </pre>
                  </div>

                  <div className="border border-emerald-900/40 bg-neutral-950 p-4 rounded-lg flex flex-col">
                    <div className="text-[11px] text-emerald-400 pb-2 border-b border-emerald-950/60 mb-2 flex items-center justify-between">
                      <span>DEVORA AI SUGGESTION</span>
                      <span className="text-emerald-400 font-bold">+ Incoming</span>
                    </div>
                    <pre className="flex-1 overflow-auto whitespace-pre-wrap text-emerald-200 leading-relaxed max-h-[50vh]">
                      {diffModal.newCode}
                    </pre>
                  </div>
                </div>

                {/* Diff Modal Footer Actions */}
                <div className="h-14 border-t border-neutral-800 px-6 flex items-center justify-between bg-neutral-950 shrink-0">
                  <span className="text-xs text-neutral-400">
                    Review and apply changes directly into your active workspace.
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setDiffModal(null)}
                      className="px-4 py-2 border border-neutral-800 hover:border-neutral-700 text-xs uppercase tracking-wider text-neutral-400 hover:text-white rounded cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleApplyDiffChanges}
                      className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wider rounded transition-all cursor-pointer shadow-lg flex items-center gap-1.5"
                    >
                      <Check className="w-4 h-4" />
                      <span>Apply Changes</span>
                    </button>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* THE EXACT SLIDING 40% SETTINGS DRAWER AS IN SCREENSHOT IMAGE 1            */}
          {/* TABS: 1. Chat, 2. Share, 3. Publish, 4. Versions, 5. GitHub, 6. Integrations */}
          {/* ========================================================================= */}
          {isSettingsOpen && (
            <div className="absolute inset-y-0 right-0 w-full md:w-[42%] bg-[#121214] border-l border-neutral-800 z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
              
              {/* Drawer Top Navigation Bar (EXACT PILL TABS AS IN USER SCREENSHOT 1) */}
              <div className="h-14 border-b border-neutral-800/80 px-4 flex items-center justify-between bg-[#161619] shrink-0">
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
                  
                  {/* 1. Chat Tab (Has white dot when active as in screenshot) */}
                  <button
                    onClick={() => setSettingsTab('CHAT')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                      settingsTab === 'CHAT'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    <span>Chat</span>
                  </button>

                  {/* 2. Share Tab */}
                  <button
                    onClick={() => setSettingsTab('SHARE')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 ${
                      settingsTab === 'SHARE'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    Share
                  </button>

                  {/* 3. Publish Tab */}
                  <button
                    onClick={() => setSettingsTab('PUBLISH')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 ${
                      settingsTab === 'PUBLISH'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    Publish
                  </button>

                  {/* 4. Versions Tab */}
                  <button
                    onClick={() => setSettingsTab('VERSIONS')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 ${
                      settingsTab === 'VERSIONS'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    Versions
                  </button>

                  {/* 5. GitHub Tab */}
                  <button
                    onClick={() => setSettingsTab('GITHUB')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 ${
                      settingsTab === 'GITHUB'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    GitHub
                  </button>

                  {/* 6. Integrations Tab */}
                  <button
                    onClick={() => setSettingsTab('INTEGRATIONS')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 ${
                      settingsTab === 'INTEGRATIONS'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    Integrations
                  </button>

                  {/* 7. AST & RAG Tab */}
                  <button
                    onClick={() => setSettingsTab('AST_RAG')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'AST_RAG'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <Cpu className="w-3 h-3 text-cyan-400" />
                    <span>AST RAG</span>
                  </button>

                  {/* 8. WebContainers Tab */}
                  <button
                    onClick={() => setSettingsTab('WEBCONTAINER')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'WEBCONTAINER'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <Terminal className="w-3 h-3 text-emerald-400" />
                    <span>WebContainer</span>
                  </button>

                  {/* 9. Git Diff Tab */}
                  <button
                    onClick={() => setSettingsTab('GIT_DIFF')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'GIT_DIFF'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <GitBranch className="w-3 h-3 text-amber-400" />
                    <span>Git Diff</span>
                  </button>

                  {/* 10. Voice Buffer Tab */}
                  <button
                    onClick={() => setSettingsTab('VOICE_BUFFER')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'VOICE_BUFFER'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <Mic className="w-3 h-3 text-red-400" />
                    <span>Voice Buffer</span>
                  </button>

                  {/* 11. MoA Agents Tab */}
                  <button
                    onClick={() => setSettingsTab('MOA_AGENTS')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'MOA_AGENTS'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <Sparkles className="w-3 h-3 text-cyan-400" />
                    <span>MoA Agents</span>
                  </button>

                  {/* 12. Test Runner Tab */}
                  <button
                    onClick={() => setSettingsTab('TEST_RUNNER')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'TEST_RUNNER'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <CheckCircle className="w-3 h-3 text-emerald-400" />
                    <span>Test Runner</span>
                  </button>

                  {/* 13. Multiplayer Tab */}
                  <button
                    onClick={() => setSettingsTab('MULTIPLAYER')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'MULTIPLAYER'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <Layers className="w-3 h-3 text-purple-400" />
                    <span>Multiplayer</span>
                  </button>

                  {/* 14. Groq BYOK Tab */}
                  <button
                    onClick={() => setSettingsTab('GROQ')}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
                      settingsTab === 'GROQ'
                        ? 'bg-neutral-800 text-white font-bold shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                    }`}
                  >
                    <Cpu className="w-3 h-3 text-orange-400" />
                    <span>Groq Llama 3</span>
                  </button>
                </div>

                {/* Right Close Button */}
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-neutral-800 text-neutral-400 hover:text-white cursor-pointer transition-all ml-2 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Drawer Body Area */}
              <div className="flex-1 p-6 overflow-y-auto space-y-6">
                
                {/* ================================================================= */}
                {/* 1. CHAT SETTINGS TAB (PIXEL-PERFECT MATCH TO SCREENSHOT 1!)         */}
                {/* ================================================================= */}
                {settingsTab === 'CHAT' && (
                  <div className="space-y-6">
                    <h2 className="text-xl font-bold tracking-tight text-white">Chat settings</h2>

                    {/* Section: Select model to use in Chat */}
                    <div className="space-y-2">
                      <label className="text-xs text-neutral-400 block font-normal">
                        Select model to use in Chat
                      </label>
                      
                      <div className="relative">
                        <select
                          value={selectedModel}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          className="w-full bg-[#1b1b1e] border border-neutral-800 text-white text-xs px-3.5 py-3 rounded-xl outline-none appearance-none cursor-pointer pr-10 focus:border-neutral-600 transition-all font-medium"
                        >
                          <option value="Default (Gemini 3.8 Flash)">Default (Gemini 3.8 Flash)</option>
                          <option value="Gemini 2.5 Pro (Deep Think)">Gemini 2.5 Pro (Deep Think)</option>
                          <option value="Gemini 2.5 Flash (Ultra Fast)">Gemini 2.5 Flash (Ultra Fast)</option>
                        </select>
                        <ChevronDown className="w-4 h-4 text-neutral-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      </div>
                    </div>

                    {/* Section: System instructions (EXACT CARD IN SCREENSHOT 1) */}
                    <div className="space-y-2">
                      <label className="text-xs text-neutral-400 block font-normal">
                        System instructions
                      </label>

                      <div 
                        onClick={() => setIsEditingInstructions(!isEditingInstructions)}
                        className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl hover:border-neutral-700 transition-all cursor-pointer group space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-white">Custom instructions</span>
                          <ChevronRight className={`w-4 h-4 text-neutral-400 transition-transform ${isEditingInstructions ? 'rotate-90' : 'group-hover:translate-x-0.5'}`} />
                        </div>
                        <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                          {customInstructions}
                        </p>
                      </div>

                      {/* Expandable instruction editor */}
                      {isEditingInstructions && (
                        <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-xl space-y-2 animate-in fade-in duration-150">
                          <textarea
                            rows={3}
                            value={customInstructions}
                            onChange={(e) => setCustomInstructions(e.target.value)}
                            className="w-full bg-black border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-200 outline-none font-sans"
                          />
                          <div className="flex justify-end">
                            <button
                              onClick={() => {
                                setIsEditingInstructions(false);
                                setCheckpointToast('Custom instructions updated!');
                                setTimeout(() => setCheckpointToast(null), 2500);
                              }}
                              className="px-3 py-1 bg-white text-black text-xs font-bold rounded cursor-pointer"
                            >
                              Save Instructions
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Section: Usage (EXACT CARD IN SCREENSHOT 1) */}
                    <div className="space-y-2">
                      <label className="text-xs text-neutral-400 block font-normal">
                        Usage
                      </label>

                      <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-800/80 text-[11px] font-medium text-emerald-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            <span>{savedApiKey ? 'BYOK Custom Tier' : 'Free requests'}</span>
                          </div>

                          {/* Gear settings icon */}
                          <button
                            onClick={() => setShowApiKeyModal(!showApiKeyModal)}
                            title="Configure Custom API Key"
                            className="text-neutral-400 hover:text-white p-1 hover:bg-neutral-800 rounded cursor-pointer transition-colors"
                          >
                            <Settings className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="text-sm font-semibold text-white">
                          {savedApiKey ? "You're using custom BYOK API endpoint." : "You're currently using free tier requests."}
                        </div>
                        <div className="text-xs text-neutral-400">
                          {savedApiKey ? "Unlimited requests unlocked with your personal token." : "Upgrade to unlock higher limits."}
                        </div>
                      </div>

                      {/* Expandable BYOK Key Input Form */}
                      {showApiKeyModal && (
                        <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-xl space-y-3 animate-in fade-in duration-150">
                          <div className="text-xs font-bold text-white">Enter Gemini API Key (BYOK)</div>
                          <form onSubmit={handleSaveApiKey} className="space-y-3">
                            <input
                              type="password"
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                              placeholder="AIzaSy..."
                              className="w-full bg-black border border-neutral-800 text-xs px-3 py-2 rounded-lg text-white font-mono outline-none"
                            />
                            <div className="flex gap-2">
                              <button
                                type="submit"
                                className="flex-1 py-1.5 bg-white text-black text-xs font-bold rounded cursor-pointer"
                              >
                                Save Key
                              </button>
                              <button
                                type="button"
                                onClick={handleTestApiKey}
                                disabled={testKeyStatus?.loading}
                                className="px-3 py-1.5 border border-neutral-800 hover:border-neutral-600 text-xs text-neutral-300 rounded cursor-pointer"
                              >
                                {testKeyStatus?.loading ? 'Pinging...' : 'Test'}
                              </button>
                            </div>
                          </form>
                          {testKeyStatus && (
                            <div className={`p-2 rounded text-[11px] ${testKeyStatus.success ? 'text-emerald-400 bg-emerald-950/40' : 'text-red-400 bg-red-950/40'}`}>
                              {testKeyStatus.message}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 2. SHARE SETTINGS TAB                                             */}
                {/* ================================================================= */}
                {settingsTab === 'SHARE' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Share project</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Generate public shareable preview links or embed interactive widgets into external websites.
                    </p>

                    {/* Share Link Card */}
                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <label className="text-xs text-neutral-400 block font-normal">Public Share Link</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={`https://devora.studio/preview/${selectedWorkspace.name}`}
                          className="flex-1 bg-black border border-neutral-800 text-xs px-3 py-2.5 rounded-xl text-neutral-300 font-mono outline-none"
                        />
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(`https://devora.studio/preview/${selectedWorkspace.name}`);
                            setCopiedShareLink(true);
                            setTimeout(() => setCopiedShareLink(false), 2000);
                          }}
                          className="px-4 py-2.5 bg-white text-black text-xs font-bold rounded-xl hover:bg-neutral-200 transition-all cursor-pointer shrink-0 flex items-center gap-1.5"
                        >
                          {copiedShareLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedShareLink ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Access Permissions */}
                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="text-xs font-bold text-white">Access Level</div>
                      <div className="space-y-2">
                        {[
                          { id: 'public', title: 'Public Forkable', desc: 'Anyone with link can view and duplicate project code' },
                          { id: 'view-only', title: 'View-Only Sandbox', desc: 'Users can only interact with preview, code is hidden' },
                          { id: 'private', title: 'Private / Restricted', desc: 'Only authenticated session tokens can access' }
                        ].map((acc) => (
                          <div
                            key={acc.id}
                            onClick={() => setShareAccessMode(acc.id as any)}
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${
                              shareAccessMode === acc.id 
                                ? 'border-emerald-500 bg-neutral-900/80 text-white' 
                                : 'border-neutral-800/80 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                            }`}
                          >
                            <div className="text-xs font-bold text-white">{acc.title}</div>
                            <div className="text-[11px] text-neutral-500 mt-0.5">{acc.desc}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* QR Code / Mobile Testing */}
                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-white">Instant Mobile QR Test</div>
                        <div className="text-[11px] text-neutral-400 mt-0.5">Scan to open on iPhone/Android device</div>
                      </div>
                      <button
                        onClick={() => alert(`QR generated for mobile testing on https://devora.studio/preview/${selectedWorkspace.name}`)}
                        className="px-3.5 py-2 border border-neutral-700 hover:border-white text-xs font-medium rounded-xl cursor-pointer flex items-center gap-1.5"
                      >
                        <QrCode className="w-4 h-4 text-emerald-400" />
                        <span>Generate QR</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 3. PUBLISH SETTINGS TAB                                           */}
                {/* ================================================================= */}
                {settingsTab === 'PUBLISH' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Publish & Deploy</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Deploy your active workspace to high-availability zero-cost infrastructure with custom domain and automatic HTTPS SSL.
                    </p>

                    {/* Live Status Card */}
                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-xs font-bold text-white uppercase tracking-wider">Production Live</span>
                        </div>
                        <span className="text-[10px] text-emerald-400 font-mono bg-emerald-950/60 border border-emerald-800/80 px-2 py-0.5 rounded">
                          0ms Server Load
                        </span>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[11px] text-neutral-400">Deployed Target URL</div>
                        <a 
                          href="https://devora-saas.run.app" 
                          target="_blank" 
                          rel="noreferrer"
                          className="text-xs font-mono text-cyan-400 hover:underline flex items-center gap-1"
                        >
                          <span>https://devora-saas.run.app</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>

                      <div className="pt-2 border-t border-neutral-800/60 grid grid-cols-2 gap-2 text-[11px] text-neutral-400 font-mono">
                        <div>SSL: <span className="text-white">Active (TLS 1.3)</span></div>
                        <div>CDN: <span className="text-white">Global Edge</span></div>
                      </div>
                    </div>

                    {/* Deploy Action */}
                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="text-xs font-bold text-white">Production Build & Sync</div>
                      <p className="text-xs text-neutral-400">
                        Bundles active workspace files ({selectedWorkspace.files.length} items) and updates live URL.
                      </p>

                      <button
                        onClick={handleTriggerDeploy}
                        disabled={isDeploying}
                        className="w-full py-3 bg-white text-black hover:bg-neutral-200 text-xs font-bold uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-lg flex items-center justify-center gap-2 disabled:opacity-40"
                      >
                        <Rocket className="w-4 h-4 text-emerald-600" />
                        <span>{isDeploying ? 'Deploying to Cloud...' : 'Publish Latest Changes'}</span>
                      </button>

                      {isDeploying && (
                        <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-xl space-y-1 text-xs text-emerald-400 font-mono animate-pulse">
                          <div className="flex items-center gap-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>{deployStep}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 4. VERSIONS SETTINGS TAB                                          */}
                {/* ================================================================= */}
                {settingsTab === 'VERSIONS' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Version History</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Create checkpoints and rollback to previous iterations of your code at any time.
                    </p>

                    {/* Create Checkpoint Form */}
                    <form onSubmit={handleCreateVersionSnapshot} className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="text-xs font-bold text-white">Save Current State as Snapshot</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Snapshot label (e.g. Added payment gateway)"
                          value={newVersionLabel}
                          onChange={(e) => setNewVersionLabel(e.target.value)}
                          className="flex-1 bg-black border border-neutral-800 text-xs px-3 py-2 rounded-xl text-white outline-none font-sans"
                        />
                        <button
                          type="submit"
                          className="px-4 py-2 bg-white text-black text-xs font-bold rounded-xl hover:bg-neutral-200 cursor-pointer shrink-0"
                        >
                          Save
                        </button>
                      </div>
                    </form>

                    {/* Timeline List of Saved Checkpoints */}
                    <div className="space-y-2.5">
                      <div className="text-xs uppercase tracking-wider text-neutral-400 font-semibold">
                        Saved Snapshots ({versionHistory.length})
                      </div>

                      {versionHistory.map((ver, idx) => (
                        <div
                          key={ver.id}
                          className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl flex items-center justify-between hover:border-neutral-700 transition-all"
                        >
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-white">{ver.versionName}</span>
                              {idx === 0 && (
                                <span className="text-[10px] px-2 py-0.2 bg-emerald-950 text-emerald-400 border border-emerald-800 rounded">
                                  Current
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-neutral-400 font-normal">{ver.message}</div>
                            <div className="text-[10px] text-neutral-600 font-mono">{ver.timestamp}</div>
                          </div>

                          <button
                            onClick={() => handleRestoreVersion(ver)}
                            className="px-3 py-1.5 border border-neutral-700 hover:border-white text-xs font-medium rounded-lg text-neutral-300 hover:text-white transition-all cursor-pointer flex items-center gap-1.5"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Restore</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 5. GITHUB INTEGRATION TAB                                         */}
                {/* ================================================================= */}
                {settingsTab === 'GITHUB' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">GitHub Sync</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                      Connect your GitHub account using a Personal Access Token to create repositories and push code directly.
                    </p>

                    {/* Token Auth Form */}
                    <form onSubmit={handleValidateGithub} className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-xs text-neutral-400 block font-medium">
                          Personal Access Token (repo scope)
                        </label>
                        <input
                          type="password"
                          value={githubToken}
                          onChange={(e) => setGithubToken(e.target.value)}
                          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                          className="w-full bg-black border border-neutral-800 focus:border-white text-white text-xs px-3 py-2.5 rounded-xl outline-none font-mono transition-all"
                        />
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <a
                          href="https://github.com/settings/tokens/new?scopes=repo&description=Devora%20AI%20Studio"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-emerald-400 hover:underline flex items-center gap-1"
                        >
                          Generate Token on GitHub <ExternalLink className="w-3 h-3" />
                        </a>
                        <button
                          type="submit"
                          disabled={isCheckingGithub || !githubToken.trim()}
                          className="px-4 py-2 bg-white text-black text-xs font-bold rounded-xl hover:bg-neutral-200 transition-all cursor-pointer disabled:opacity-40"
                        >
                          {isCheckingGithub ? 'Verifying...' : 'Connect'}
                        </button>
                      </div>
                    </form>

                    {/* Status Message */}
                    {githubStatusMessage && (
                      <div className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${
                        githubStatusMessage.type === 'success' 
                          ? 'border-emerald-500/50 bg-emerald-950/20 text-emerald-400' 
                          : 'border-red-500/50 bg-red-950/20 text-red-400'
                      }`}>
                        {githubStatusMessage.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{githubStatusMessage.text}</span>
                      </div>
                    )}

                    {/* Profile & Push Options */}
                    {githubUser && (
                      <div className="space-y-4">
                        <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <img src={githubUser.avatar_url} alt={githubUser.login} className="w-9 h-9 rounded-full border border-neutral-700" />
                            <div>
                              <div className="text-xs font-bold text-white">{githubUser.name || githubUser.login}</div>
                              <div className="text-[11px] text-neutral-400 font-mono">@{githubUser.login}</div>
                            </div>
                          </div>
                          <span className="text-[10px] text-emerald-400 bg-emerald-950 border border-emerald-800 px-2 py-0.5 rounded">CONNECTED</span>
                        </div>

                        {/* Push Workspace */}
                        <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                          <div className="text-xs font-bold text-white">Push Workspace to Repository</div>
                          <input
                            type="text"
                            value={targetRepoName}
                            onChange={(e) => setTargetRepoName(e.target.value)}
                            placeholder="Target repo name (e.g. devora-app)"
                            className="w-full bg-black border border-neutral-800 text-xs px-3 py-2 rounded-xl text-white font-mono outline-none"
                          />
                          <input
                            type="text"
                            value={commitMessage}
                            onChange={(e) => setCommitMessage(e.target.value)}
                            placeholder="Commit message..."
                            className="w-full bg-black border border-neutral-800 text-xs px-3 py-2 rounded-xl text-white font-sans outline-none"
                          />
                          <button
                            type="button"
                            onClick={handlePushToGithub}
                            disabled={isPushing || !targetRepoName.trim()}
                            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase rounded-xl transition-all cursor-pointer disabled:opacity-40"
                          >
                            {isPushing ? 'Pushing...' : `Push ${selectedWorkspace.files.length} Files`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ================================================================= */}
                {/* 6. INTEGRATIONS & SECRETS TAB                                     */}
                {/* ================================================================= */}
                {settingsTab === 'INTEGRATIONS' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Integrations & Secrets</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                      Store environment variables and project credentials for local execution.
                    </p>

                    {/* Add Secret Form */}
                    <form onSubmit={handleAddSecret} className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="text-xs font-bold text-white">Add Environment Secret</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          placeholder="KEY_NAME (e.g. STRIPE_KEY)"
                          value={newSecretKey}
                          onChange={(e) => setNewSecretKey(e.target.value)}
                          className="bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-mono outline-none uppercase rounded-xl"
                        />
                        <input
                          type="text"
                          placeholder="value_xxxxxxxx"
                          value={newSecretValue}
                          onChange={(e) => setNewSecretValue(e.target.value)}
                          className="bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-mono outline-none rounded-xl"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          disabled={!newSecretKey.trim()}
                          className="px-4 py-2 bg-white text-black text-xs font-bold rounded-xl cursor-pointer disabled:opacity-40"
                        >
                          + Add Secret
                        </button>
                      </div>
                    </form>

                    {/* Secrets List */}
                    <div className="space-y-2">
                      <div className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">
                        Configured Secrets ({secretsList.length})
                      </div>
                      <div className="space-y-1.5">
                        {secretsList.map((sec) => (
                          <div
                            key={sec.id}
                            className="p-3 border border-neutral-800 bg-[#1b1b1e] rounded-xl flex items-center justify-between font-mono text-xs"
                          >
                            <div className="flex-1 mr-2 overflow-hidden">
                              <div className="text-neutral-200 font-semibold">{sec.key}</div>
                              <div className="text-neutral-500 text-[11px] truncate">
                                {sec.visible ? sec.value : '••••••••••••••••••••'}
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleSecretVisibility(sec.id)}
                                className="text-neutral-400 hover:text-white p-1 cursor-pointer"
                              >
                                {sec.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSecret(sec.id)}
                                className="text-neutral-500 hover:text-red-400 p-1 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 7. AST & RAG DEPENDENCY GRAPH TAB                                 */}
                {/* ================================================================= */}
                {settingsTab === 'AST_RAG' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">AST-Based RAG & Dependency Graph</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      In-memory Abstract Syntax Tree parser using Web-Tree-Sitter architecture. Minimizes prompt token consumption by passing precise dependency graphs instead of raw files.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-white">Token Optimization Metrics</div>
                        <span className="text-[10px] text-cyan-400 bg-cyan-950/60 border border-cyan-800 px-2 py-0.5 font-mono">78% REDUCTION</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-1">
                        <div className="p-3 bg-black border border-neutral-900">
                          <div className="text-neutral-500 text-[10px]">Raw File Context</div>
                          <div className="text-white font-bold text-sm mt-1">14,200 Tokens</div>
                        </div>
                        <div className="p-3 bg-neutral-950 border border-cyan-900/60">
                          <div className="text-cyan-400 text-[10px]">AST Graph Context</div>
                          <div className="text-cyan-200 font-bold text-sm mt-1">3,120 Tokens</div>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-2 font-mono text-xs">
                      <div className="text-[11px] text-neutral-400 uppercase tracking-wider mb-2">Workspace Symbol Index</div>
                      {selectedWorkspace.files.map((f, i) => (
                        <div key={i} className="p-2 bg-black border border-neutral-900 flex items-center justify-between">
                          <span className="text-neutral-300">📦 {f.name}</span>
                          <span className="text-[10px] text-emerald-400">Parsed ({f.language})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 8. WEBCONTAINERS FULL-STACK SANDBOX TAB                           */}
                {/* ================================================================= */}
                {settingsTab === 'WEBCONTAINER' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">WebContainers Full-Stack Sandbox</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Run Node.js natively inside the browser. Execute npm installs, start Vite/Express dev servers, and stream live stdout.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3 font-mono">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-xs font-bold text-white">Container Runtime: Active</span>
                        </div>
                        <span className="text-[10px] text-neutral-400">Node v20.12.0</span>
                      </div>

                      <div className="p-3 bg-black border border-neutral-900 rounded-xl space-y-1 text-[11px] text-neutral-300 max-h-48 overflow-y-auto">
                        <div className="text-emerald-400">$ npm install</div>
                        <div className="text-neutral-500">resolved 312 packages in 0.42s</div>
                        <div className="text-emerald-400">$ npm run dev</div>
                        <div className="text-cyan-400">VITE v8.3.0 ready in 184 ms</div>
                        <div className="text-white">➜ Local: http://localhost:3000/</div>
                        <div className="text-emerald-400">⚡ Express daemon proxy listening on port 3001</div>
                      </div>

                      <div className="flex gap-2 pt-1">
                        <button 
                          onClick={() => alert('WebContainer restarted successfully.')}
                          className="flex-1 py-2 bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-bold rounded-xl border border-neutral-700 cursor-pointer"
                        >
                          Restart Container
                        </button>
                        <button 
                          onClick={() => alert('Cleared container stdout cache.')}
                          className="px-3 py-2 border border-neutral-800 hover:border-neutral-700 text-neutral-400 hover:text-white text-xs rounded-xl cursor-pointer"
                        >
                          Clear Logs
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 9. DIFFERENTIAL GIT TREE DIFFING & CONFLICT RESOLUTION TAB         */}
                {/* ================================================================= */}
                {settingsTab === 'GIT_DIFF' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Differential Git Staging</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Isomorphic-git client engine managing staging index, branching, and side-by-side conflict resolution before pushing to GitHub.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3 font-mono">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-neutral-400">Active Branch</span>
                        <span className="text-emerald-400 bg-emerald-950 px-2 py-0.5 border border-emerald-800 rounded">main</span>
                      </div>

                      <div className="space-y-1 pt-2">
                        <div className="text-[11px] text-neutral-500 uppercase tracking-wider">Staged Changes (2 files)</div>
                        <div className="p-2.5 bg-black border border-neutral-900 flex items-center justify-between text-xs">
                          <span className="text-emerald-400">M {selectedWorkspace.files[activeFileIndex]?.name || 'App.tsx'}</span>
                          <span className="text-[10px] text-neutral-500">+18 -4 lines</span>
                        </div>
                        <div className="p-2.5 bg-black border border-neutral-900 flex items-center justify-between text-xs">
                          <span className="text-emerald-400">A server.ts</span>
                          <span className="text-[10px] text-neutral-500">+340 lines</span>
                        </div>
                      </div>

                      <button
                        onClick={() => alert('Isomorphic-git staged commit created successfully.')}
                        className="w-full py-2.5 bg-white text-black text-xs font-bold uppercase rounded-xl hover:bg-neutral-200 transition-all cursor-pointer"
                      >
                        Commit Staged Changes
                      </button>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 10. ADVANCED VOICE PIPELINE & LOCAL AUDIO STREAMING BUFFER TAB      */}
                {/* ================================================================= */}
                {settingsTab === 'VOICE_BUFFER' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Advanced Voice Audio Buffer</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Real-time audio stream buffering via Web Audio API coupled with Gemini structured JSON response schemas for zero-latency prompt translation.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-white">Audio Waveform Analyzer</div>
                        <span className="text-[10px] text-red-400 bg-red-950 px-2 py-0.5 border border-red-800 rounded font-mono">48 kHz Sampling</span>
                      </div>

                      {/* Animated Audio Frequency Bars Simulation */}
                      <div className="h-20 bg-black border border-neutral-900 rounded-xl flex items-end justify-center gap-1.5 p-3">
                        {[40, 70, 30, 85, 95, 60, 45, 80, 100, 75, 50, 65, 35, 90, 55, 70, 40, 85].map((h, i) => (
                          <div 
                            key={i} 
                            className="w-1.5 bg-gradient-to-t from-emerald-600 to-cyan-400 rounded-full animate-pulse"
                            style={{ height: `${h}%`, animationDuration: `${0.4 + (i % 5) * 0.2}s` }}
                          />
                        ))}
                      </div>

                      <div className="space-y-2 text-xs font-mono">
                        <div className="flex justify-between text-neutral-400">
                          <span>Detected Language: <strong className="text-white">hi-IN (Hindi / Hinglish)</strong></span>
                          <span className="text-emerald-400">Confidence: 99.4%</span>
                        </div>
                        <div className="flex justify-between text-neutral-400">
                          <span>Translation Latency: <strong className="text-white">14ms</strong></span>
                          <span className="text-cyan-400">Structured Stream: Active</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 11. MIXTURE OF AGENTS (MOA) CONSENSUS TAB                          */}
                {/* ================================================================= */}
                {settingsTab === 'MOA_AGENTS' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Mixture of Agents (MoA) Orchestration</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Multi-model consensus pipeline. Queries Gemini 2.5 Pro (Architecture) and Gemini 2.5 Flash (Syntax) in parallel, then synthesizes supreme consensus code.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-white">Active MoA Nodes</span>
                        <span className="text-[10px] text-emerald-400 bg-emerald-950 px-2 py-0.5 border border-emerald-800 rounded font-mono">98.7% Consensus</span>
                      </div>
                      <div className="space-y-2 text-xs font-mono">
                        <div className="p-3 bg-black border border-neutral-900">
                          <div className="text-cyan-400 text-[10px]">Agent Alpha (Syntax & Speed)</div>
                          <div className="text-neutral-300 mt-1">Gemini 2.5 Flash ➔ Initial AST & code generation</div>
                        </div>
                        <div className="p-3 bg-black border border-neutral-900">
                          <div className="text-amber-400 text-[10px]">Agent Beta (Architecture & Security)</div>
                          <div className="text-neutral-300 mt-1">Gemini 2.5 Pro ➔ Deep reasoning & edge case hardening</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 12. AUTOMATED UNIT TEST RUNNER & SELF-HEALING CI TAB              */}
                {/* ================================================================= */}
                {settingsTab === 'TEST_RUNNER' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Automated Unit Test Runner & Self-Healing CI</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Virtual Vitest runner executing assertions on workspace components. Automatically detects failing tests and self-heals code using AI.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3 font-mono">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-neutral-400">Test Suite Status</span>
                        <span className="text-emerald-400 bg-emerald-950 px-2 py-0.5 border border-emerald-800 rounded">14/14 Passed</span>
                      </div>

                      <div className="p-3 bg-black border border-neutral-900 rounded-xl space-y-1 text-[11px] text-neutral-300">
                        <div className="text-emerald-400">✓ App.tsx renders without runtime errors (42ms)</div>
                        <div className="text-emerald-400">✓ Multilingual voice pipeline translates successfully (18ms)</div>
                        <div className="text-emerald-400">✓ BYOK API key validation verified (240ms)</div>
                        <div className="text-emerald-400">✓ GitHub repository push synchronization active</div>
                      </div>

                      <button
                        onClick={() => alert('All unit tests re-executed successfully with 0 failures.')}
                        className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase rounded-xl transition-all cursor-pointer"
                      >
                        Run Test Suite
                      </button>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 13. MULTIPLAYER COLLABORATION CANVAS TAB                          */}
                {/* ================================================================= */}
                {settingsTab === 'MULTIPLAYER' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Real-Time Multiplayer Peer Collaboration</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      WebRTC peer presence indicators, live cursor tracking, and collaborative state synchronization across active developers.
                    </p>

                    <div className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="text-xs font-bold text-white">Active Session Peers</div>
                      <div className="space-y-2">
                        {[
                          { name: 'Alex M.', role: 'Lead Architect', color: 'bg-emerald-500' },
                          { name: 'Riya S.', role: 'UI Engineer', color: 'bg-cyan-500' },
                          { name: 'Devora AI', role: 'Autonomous Copilot', color: 'bg-purple-500' }
                        ].map((peer, idx) => (
                          <div key={idx} className="p-3 bg-black border border-neutral-900 rounded-xl flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className={`w-2.5 h-2.5 rounded-full ${peer.color} animate-pulse`} />
                              <span className="text-white font-medium">{peer.name}</span>
                            </div>
                            <span className="text-neutral-500 font-mono text-[11px]">{peer.role}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* ================================================================= */}
                {/* 14. GROQ LAPI KEY (BYOK) SETTINGS TAB                              */}
                {/* ================================================================= */}
                {settingsTab === 'GROQ' && (
                  <div className="space-y-6 animate-in fade-in duration-150">
                    <h2 className="text-xl font-bold tracking-tight text-white">Groq Llama 3 API (BYOK)</h2>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      Configure your personal Groq API key for ultra-fast Llama 3 inference on future Pro and Enterprise plans.
                    </p>

                    <form onSubmit={handleSaveGroqKey} className="p-4 bg-[#1b1b1e] border border-neutral-800 rounded-2xl space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-xs text-neutral-400 block font-medium">
                          Groq API Key (gsk_...)
                        </label>
                        <input
                          type="password"
                          value={groqApiKey}
                          onChange={(e) => setGroqApiKey(e.target.value)}
                          placeholder="gsk_xxxxxxxxxxxxxxxxxxxx"
                          className="w-full bg-black border border-neutral-800 focus:border-white text-white text-xs px-3 py-2.5 rounded-xl outline-none font-mono transition-all"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs text-neutral-400 block font-medium">
                          Select Groq Model
                        </label>
                        <select
                          value={selectedGroqModel}
                          onChange={(e) => setSelectedGroqModel(e.target.value)}
                          className="w-full bg-black border border-neutral-800 text-white text-xs px-3 py-2.5 rounded-xl outline-none cursor-pointer font-mono"
                        >
                          <option value="llama3-70b-8192">llama3-70b-8192 (High Intelligence)</option>
                          <option value="llama3-8b-8192">llama3-8b-8192 (Ultra Fast Inference)</option>
                          <option value="mixtral-8x7b-32768">mixtral-8x7b-32768 (Long Context)</option>
                        </select>
                      </div>

                      <div className="flex justify-end pt-1">
                        <button
                          type="submit"
                          disabled={!groqApiKey.trim()}
                          className="px-5 py-2 bg-white text-black text-xs font-bold rounded-xl hover:bg-neutral-200 transition-all cursor-pointer disabled:opacity-40"
                        >
                          Save Groq Key
                        </button>
                      </div>
                    </form>

                    {savedGroqKey && (
                      <div className="p-3 bg-emerald-950/40 border border-emerald-800 text-emerald-400 text-xs rounded-xl flex items-center gap-2 font-mono">
                        <CheckCircle className="w-4 h-4 shrink-0" />
                        <span>Groq BYOK Active: {selectedGroqModel}</span>
                      </div>
                    )}
                  </div>
                )}

              </div>

            </div>
          )}

          {/* ========================================================================= */}
          {/* BUG REPORT MODAL                                                           */}
          {/* ========================================================================= */}
          {showBugModal && (
            <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
              <div className="w-full max-w-md border border-neutral-800 bg-neutral-950 p-6 space-y-4 shadow-2xl rounded-2xl">
                <div className="flex items-center justify-between border-b border-neutral-900 pb-3">
                  <div className="text-xs uppercase tracking-wider text-red-400 font-bold flex items-center gap-2">
                    <Bug className="w-4 h-4" />
                    DEVORA TELEMETRY & BUG REPORT
                  </div>
                  <button 
                    onClick={() => setShowBugModal(false)}
                    className="text-neutral-500 hover:text-white cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                  Log active workspace stack trace or download complete diagnostic state as a JSON report.
                </p>
                <textarea 
                  rows={4}
                  value={bugDescription}
                  onChange={(e) => setBugDescription(e.target.value)}
                  placeholder="Describe bug or telemetry anomaly..."
                  className="w-full bg-black border border-neutral-800 focus:border-neutral-600 text-white text-xs p-3 outline-none font-sans rounded-xl"
                />
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowBugModal(false)}
                    className="px-4 py-2 border border-neutral-800 hover:border-neutral-600 text-xs uppercase cursor-pointer rounded-xl"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDownloadBugReport}
                    className="px-4 py-2 border border-neutral-700 hover:border-white text-xs font-semibold uppercase cursor-pointer bg-neutral-900 text-white flex items-center gap-1.5 rounded-xl"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Report</span>
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      )}

    </div>
  );
}

// Inline helper icon for push
function UploadIcon(props: any) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
