import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal, Code2, Play, Settings, X, FolderOpen, ArrowLeft, Bug, 
  Send, Key, CheckCircle, RefreshCw, FileCode, Cpu, Layers, HardDrive, 
  Sparkles, AlertCircle, Copy, Check, ChevronRight, Mic, MicOff,
  Github, Shield, Plus, Trash2, Eye, EyeOff, ExternalLink, Globe,
  Download, FilePlus, Save, ArrowUpRight, Search, Laptop, Tablet, 
  Smartphone, RotateCcw, CheckSquare, FileText
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
type SettingsTab = 'CHAT' | 'GITHUB' | 'SECRETS';
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

  // Settings Drawer State (Exact 3 tabs: 1. CHAT, 2. GITHUB, 3. SECRETS)
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('CHAT');
  
  // Settings Tab 1: Chat / BYOK & Models
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [savedApiKey, setSavedApiKey] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('gemini-2.5-flash');
  const [enableVoiceRefinement, setEnableVoiceRefinement] = useState<boolean>(true);
  const [keySavedMessage, setKeySavedMessage] = useState<boolean>(false);
  const [testKeyStatus, setTestKeyStatus] = useState<{ loading: boolean; success?: boolean; latency?: number; message?: string } | null>(null);

  // Settings Tab 2: GitHub Integration
  const [githubToken, setGithubToken] = useState<string>('');
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [isCheckingGithub, setIsCheckingGithub] = useState<boolean>(false);
  const [githubStatusMessage, setGithubStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  
  // GitHub Create Repo & Push
  const [newRepoName, setNewRepoName] = useState<string>('');
  const [newRepoDescription, setNewRepoDescription] = useState<string>('Created with Devora AI IDE Studio');
  const [newRepoPrivate, setNewRepoPrivate] = useState<boolean>(false);
  const [isCreatingRepo, setIsCreatingRepo] = useState<boolean>(false);
  const [targetRepoName, setTargetRepoName] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('Update from Devora AI Studio');
  const [isPushing, setIsPushing] = useState<boolean>(false);
  const [lastPushUrl, setLastPushUrl] = useState<string | null>(null);

  // Settings Tab 3: Secrets Manager
  const [secretsList, setSecretsList] = useState<SecretItem[]>([
    { id: '1', key: 'GEMINI_API_KEY', value: 'AIzaSy_DEVORA_SYSTEM_DEFAULT', visible: false },
    { id: '2', key: 'PORT', value: '3000', visible: true },
    { id: '3', key: 'DEVORA_ENV', value: 'production', visible: true },
    { id: '4', key: 'INFRASTRUCTURE_COST', value: '$0.00', visible: true }
  ]);
  const [newSecretKey, setNewSecretKey] = useState<string>('');
  const [newSecretValue, setNewSecretValue] = useState<string>('');

  // Voice Pipeline State (Mice -> Translation -> Intent Structuring -> Better Prompt)
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechTranscript, setSpeechTranscript] = useState<string>('');
  const [isRefiningVoice, setIsRefiningVoice] = useState<boolean>(false);
  const [refinementStep, setRefinementStep] = useState<string>('');
  const recognitionRef = useRef<any>(null);

  // Chat Terminal State
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      role: 'model',
      content: 'Devora AI Studio initialized. Ready for multilingual voice code generation (Hindi, Hinglish, Bengali, Tamil, etc.), workspace file editing, and direct GitHub synchronization.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [inputPrompt, setInputPrompt] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [totalTokens, setTotalTokens] = useState<number>(48);
  const chatScrollRef = useRef<HTMLDivElement>(null);

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
      recognition.lang = 'hi-IN'; // Indian multilingual recognition handles Hindi, Hinglish, English seamlessly

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

      // Automatically send the refined prompt to Devora Engine!
      handleSendPromptDirectly(refined.refinedPrompt, refined);
    } catch (err: any) {
      console.error('Voice Refinement Error:', err);
      // Fallback: send raw spoken text directly
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

  // Secrets: Add Secret
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

  // Chat Execution
  const handleSendPromptDirectly = async (promptText: string, meta?: any) => {
    if (!promptText.trim() || isGenerating) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: promptText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      refinedMeta: meta
    };

    setMessages(prev => [...prev, userMsg]);
    setIsGenerating(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
          systemInstruction: `You are Devora, an elite AI coding engine in a clean dark minimalist IDE studio. Current workspace: ${selectedWorkspace?.name || 'None'}. Current file: ${selectedWorkspace?.files[activeFileIndex]?.name || 'None'}. Current code:\n\`\`\`\n${selectedWorkspace?.files[activeFileIndex]?.content || ''}\n\`\`\`\nProvide direct, production-grade developer solutions with clean code blocks.`,
          apiKey: savedApiKey || undefined,
          model: selectedModel
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
    if (!inputPrompt.trim()) return;
    const text = inputPrompt;
    setInputPrompt('');
    handleSendPromptDirectly(text);
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Apply code generated by AI directly to active file
  const handleApplyCodeSnippet = (content: string) => {
    const codeMatch = content.match(/```(?:tsx|typescript|jsx|javascript|json|html|css)?\s*([\s\S]*?)```/);
    const codeToApply = codeMatch ? codeMatch[1].trim() : content;
    handleCodeChange(codeToApply);
    setActiveTab('CODE');
    alert(`Applied code changes directly to ${selectedWorkspace?.files[activeFileIndex]?.name}!`);
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

              {/* Large Clean Dropzone CTA (Real Folder Upload!) */}
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
            <div className="w-full md:w-[35%] h-1/2 md:h-full border-r border-neutral-900 flex flex-col bg-black shrink-0">
              
              {/* Terminal Title Bar */}
              <div className="h-10 border-b border-neutral-900 px-4 flex items-center justify-between text-xs text-neutral-300 shrink-0 bg-neutral-950/30">
                <span className="flex items-center gap-2 font-medium">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  Devora Multilingual AI Terminal
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    {selectedModel.replace('gemini-', '')}
                  </span>
                </div>
              </div>

              {/* Scrollable Conversation Canvas */}
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 text-xs font-sans">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-2 mb-1 text-[11px] text-neutral-400">
                      <span className="font-semibold text-neutral-300">{msg.role === 'user' ? 'Developer' : 'Devora Engine'}</span>
                      <span className="text-neutral-600 font-mono text-[10px]">{msg.timestamp}</span>
                    </div>

                    {/* Step-by-Step Voice Translation Pill if applicable */}
                    {msg.refinedMeta && (
                      <div className="mb-1 text-[10px] text-neutral-400 bg-neutral-950 border border-neutral-800 p-2 max-w-[95%] space-y-1">
                        <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                          <Globe className="w-3 h-3" />
                          <span>Voice Pipeline: {msg.refinedMeta.detectedLanguage} ➔ English Refinement</span>
                        </div>
                        <div className="text-neutral-400 font-mono text-[10px]">
                          🎙️ <em>"{msg.refinedMeta.original}"</em>
                        </div>
                      </div>
                    )}

                    <div className={`p-3 max-w-[95%] leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-neutral-900 text-white border border-neutral-800' 
                        : 'bg-neutral-950 text-neutral-200 border border-neutral-900'
                    }`}>
                      <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{msg.content}</pre>
                      
                      {/* If AI message contains code, offer 1-click apply button */}
                      {msg.role === 'model' && msg.content.includes('```') && (
                        <div className="mt-3 pt-2 border-t border-neutral-900 flex justify-end">
                          <button
                            onClick={() => handleApplyCodeSnippet(msg.content)}
                            className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider bg-emerald-950/60 border border-emerald-800 hover:bg-emerald-900 text-emerald-400 transition-all cursor-pointer flex items-center gap-1"
                          >
                            <CheckSquare className="w-3 h-3" />
                            Apply to {selectedWorkspace.files[activeFileIndex]?.name}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Multilingual Voice Pipeline In-Flight Indicator */}
                {isRefiningVoice && (
                  <div className="p-3 border border-emerald-500/40 bg-emerald-950/30 text-xs space-y-1.5 text-emerald-400 animate-pulse">
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
                  <div className="flex items-center gap-2 text-neutral-400 text-xs py-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                    <span>Devora Engine processing code generation...</span>
                  </div>
                )}
              </div>

              {/* Prompt Interaction Inputs Block (Bottom Fixed Stack Area with Microphone) */}
              <div className="p-3 border-t border-neutral-900 bg-neutral-950/50 shrink-0">
                
                {/* Live Mic Listening Visualizer */}
                {isListening && (
                  <div className="mb-2 p-2 border border-red-500/50 bg-red-950/30 flex items-center justify-between text-xs text-red-300 animate-pulse">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                      <span>Listening... Speak in Hindi, Hinglish, or any language</span>
                    </div>
                    <button
                      onClick={toggleListening}
                      className="px-2 py-0.5 border border-red-400 text-[10px] uppercase tracking-wider hover:bg-red-900 cursor-pointer"
                    >
                      Done / Translate
                    </button>
                  </div>
                )}

                <form onSubmit={handleChatSubmit} className="relative mb-2">
                  <div className="flex items-center bg-black border border-neutral-800 focus-within:border-neutral-500 transition-all">
                    
                    {/* Microphone Button (Mice -> Translation -> Better Prompt) */}
                    <button
                      type="button"
                      onClick={toggleListening}
                      title="Speak in your own language (Hindi, Hinglish, etc.) - Auto Translated & Refined"
                      className={`p-2.5 transition-colors cursor-pointer ${
                        isListening 
                          ? 'text-red-400 bg-red-950/50' 
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {isListening ? <MicOff className="w-4 h-4 animate-bounce" /> : <Mic className="w-4 h-4" />}
                    </button>

                    <input
                      type="text"
                      value={inputPrompt}
                      onChange={(e) => setInputPrompt(e.target.value)}
                      placeholder={isListening ? "Listening to your voice..." : "Ask in any language or prompt Devora..."}
                      className="flex-1 bg-transparent text-white text-xs px-2 py-2.5 outline-none font-sans placeholder:text-neutral-500"
                    />

                    <button 
                      type="submit" 
                      disabled={isGenerating || !inputPrompt.trim()}
                      className="text-neutral-400 hover:text-white disabled:opacity-30 cursor-pointer p-2.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </form>

                {/* Telemetry Control Footer */}
                <div className="flex items-center justify-between text-xs text-neutral-400 px-1 font-mono">
                  <button 
                    onClick={() => {
                      setSettingsTab('CHAT');
                      setIsSettingsOpen(true);
                    }}
                    className="hover:text-emerald-400 transition-colors cursor-pointer text-[11px]"
                  >
                    [ BYOK: {savedApiKey ? 'ACTIVE (CUSTOM)' : 'DEFAULT / ACTIVE'} ]
                  </button>
                  <div className="text-[11px] text-neutral-500">
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
                  <div className="flex-1 flex flex-col items-center justify-start p-4 bg-neutral-950/20 overflow-auto">
                    <div className={`w-full border border-neutral-800 bg-black shadow-2xl transition-all duration-300 ${
                      previewViewport === 'tablet' ? 'max-w-[768px]' : previewViewport === 'mobile' ? 'max-w-[375px]' : 'max-w-4xl'
                    }`}>
                      
                      {/* Browser Mock Header */}
                      <div className="h-9 border-b border-neutral-900 px-3 flex items-center justify-between bg-neutral-950">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
                          <div className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
                          <div className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
                        </div>
                        <div className="text-[11px] text-neutral-400 font-mono bg-neutral-900/60 px-3 py-0.5 rounded border border-neutral-800 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          https://devora.local:3000
                        </div>
                        <button 
                          onClick={() => alert('Preview environment reloaded with latest workspace state.')}
                          className="text-neutral-500 hover:text-white cursor-pointer"
                          title="Reload"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
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
          {/* THE SLIDING 40% PARAMETER DRAWER COMPONENT FRAMEWORK (EXACT 3 TABS)         */}
          {/* 1. chat - byok - models                                                   */}
          {/* 2. GitHub                                                                 */}
          {/* 3. secrets                                                                */}
          {/* ========================================================================= */}
          {isSettingsOpen && (
            <div className="absolute inset-y-0 right-0 w-full md:w-[40%] bg-black border-l border-neutral-800 z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
              
              {/* Drawer Header */}
              <div className="h-12 border-b border-neutral-800 px-6 flex items-center justify-between bg-neutral-950 shrink-0">
                <div className="text-xs uppercase tracking-wider text-white font-bold flex items-center gap-2">
                  <Settings className="w-3.5 h-3.5 text-emerald-400" />
                  DEVORA SETTINGS MATRIX
                </div>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="w-7 h-7 flex items-center justify-center border border-neutral-800 hover:border-white text-neutral-400 hover:text-white cursor-pointer transition-all"
                >
                  ✕
                </button>
              </div>

              {/* Exact 3 Tabs HUD: 1. Chat, 2. GitHub, 3. Secrets */}
              <div className="h-11 border-b border-neutral-900 bg-neutral-950/60 px-6 flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setSettingsTab('CHAT')}
                  className={`text-xs px-3 py-1.5 font-medium transition-all cursor-pointer ${
                    settingsTab === 'CHAT'
                      ? 'border-b-2 border-white text-white font-bold'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  1. Chat / BYOK / Models
                </button>
                <button
                  onClick={() => setSettingsTab('GITHUB')}
                  className={`text-xs px-3 py-1.5 font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                    settingsTab === 'GITHUB'
                      ? 'border-b-2 border-white text-white font-bold'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  <Github className="w-3 h-3" />
                  <span>2. GitHub</span>
                </button>
                <button
                  onClick={() => setSettingsTab('SECRETS')}
                  className={`text-xs px-3 py-1.5 font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                    settingsTab === 'SECRETS'
                      ? 'border-b-2 border-white text-white font-bold'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  <Shield className="w-3 h-3" />
                  <span>3. Secrets</span>
                </button>
              </div>

              {/* Drawer Body - Switches Between the 3 Tabs */}
              <div className="flex-1 p-6 overflow-y-auto space-y-6">
                
                {/* ----------------------------------------------------------------- */}
                {/* TAB 1: CHAT - BYOK - MODELS                                       */}
                {/* ----------------------------------------------------------------- */}
                {settingsTab === 'CHAT' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-xs uppercase font-bold text-neutral-200 tracking-wider mb-1">
                        BYOK & AI MODEL SELECTION
                      </h3>
                      <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                        Configure your Gemini API key or switch high-performance AI engines.
                      </p>
                    </div>

                    {/* Model Picker */}
                    <div className="space-y-2">
                      <label className="text-xs uppercase text-neutral-400 tracking-wider block font-medium">
                        Active AI Model Engine
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedModel('gemini-2.5-flash')}
                          className={`p-3 border text-left cursor-pointer transition-all ${
                            selectedModel === 'gemini-2.5-flash'
                              ? 'border-emerald-500 bg-neutral-900 text-white'
                              : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                          }`}
                        >
                          <div className="text-xs font-bold">Gemini 2.5 Flash</div>
                          <div className="text-[10px] text-neutral-500 mt-1">Lightning Fast · Code Gen</div>
                        </button>
                        
                        <button
                          type="button"
                          onClick={() => setSelectedModel('gemini-2.5-pro')}
                          className={`p-3 border text-left cursor-pointer transition-all ${
                            selectedModel === 'gemini-2.5-pro'
                              ? 'border-emerald-500 bg-neutral-900 text-white'
                              : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                          }`}
                        >
                          <div className="text-xs font-bold">Gemini 2.5 Pro</div>
                          <div className="text-[10px] text-neutral-500 mt-1">Deep Reasoning · Complex</div>
                        </button>
                      </div>
                    </div>

                    {/* API Key Form */}
                    <form onSubmit={handleSaveApiKey} className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs uppercase text-neutral-400 tracking-wider block font-medium">
                          PROVIDER API KEY ENDPOINT (BYOK)
                        </label>
                        <input
                          type="password"
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                          placeholder="AIzaSy..."
                          className="w-full bg-neutral-950 border border-neutral-800 focus:border-white text-white text-xs px-3 py-2.5 outline-none font-mono transition-all"
                        />
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          className="flex-1 py-2.5 border border-neutral-700 hover:border-white text-xs font-semibold uppercase tracking-widest transition-all cursor-pointer bg-neutral-950 text-white hover:bg-white hover:text-black"
                        >
                          SAVE & INJECT API TOKEN
                        </button>
                        
                        <button
                          type="button"
                          onClick={handleTestApiKey}
                          disabled={testKeyStatus?.loading}
                          className="px-4 py-2.5 border border-neutral-800 hover:border-neutral-500 text-xs text-neutral-300 hover:text-white uppercase font-mono cursor-pointer disabled:opacity-40"
                        >
                          {testKeyStatus?.loading ? 'Pinging...' : 'Test Key'}
                        </button>
                      </div>
                    </form>

                    {testKeyStatus && (
                      <div className={`p-3 border text-xs flex items-center gap-2 ${
                        testKeyStatus.success
                          ? 'border-emerald-500/50 bg-emerald-950/20 text-emerald-400'
                          : 'border-red-500/50 bg-red-950/20 text-red-400'
                      }`}>
                        {testKeyStatus.success ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{testKeyStatus.message}</span>
                      </div>
                    )}

                    {keySavedMessage && (
                      <div className="p-3 border border-emerald-500/50 bg-emerald-950/20 text-emerald-400 text-xs flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 shrink-0" />
                        <span>API Token and model preferences updated successfully.</span>
                      </div>
                    )}

                    {/* Multilingual Voice Pipeline Toggle */}
                    <div className="border border-neutral-900 p-4 bg-neutral-950 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-white">Indic Voice Refinement Engine</span>
                        <input
                          type="checkbox"
                          checked={enableVoiceRefinement}
                          onChange={(e) => setEnableVoiceRefinement(e.target.checked)}
                          className="cursor-pointer accent-emerald-500"
                        />
                      </div>
                      <p className="text-[11px] text-neutral-400 leading-relaxed font-normal">
                        Automatically translates spoken voice (Hindi, Hinglish, Tamil, Bengali, etc.) into structured English prompts before dispatch.
                      </p>
                    </div>
                  </div>
                )}

                {/* ----------------------------------------------------------------- */}
                {/* TAB 2: GITHUB INTEGRATION                                         */}
                {/* ----------------------------------------------------------------- */}
                {settingsTab === 'GITHUB' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-xs uppercase font-bold text-neutral-200 tracking-wider mb-1">
                        GITHUB SYNC & REPOSITORY CONTROL
                      </h3>
                      <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                        Connect your GitHub account using a Personal Access Token to create repos and push code directly.
                      </p>
                    </div>

                    {/* Token Auth Form */}
                    <form onSubmit={handleValidateGithub} className="space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-xs uppercase text-neutral-400 tracking-wider block font-medium">
                          GitHub Personal Access Token (repo scope)
                        </label>
                        <input
                          type="password"
                          value={githubToken}
                          onChange={(e) => setGithubToken(e.target.value)}
                          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                          className="w-full bg-neutral-950 border border-neutral-800 focus:border-white text-white text-xs px-3 py-2 outline-none font-mono transition-all"
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
                          className="px-4 py-2 border border-neutral-700 hover:border-white text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer bg-white text-black disabled:opacity-40"
                        >
                          {isCheckingGithub ? 'Verifying...' : 'Connect GitHub'}
                        </button>
                      </div>
                    </form>

                    {/* Status Message */}
                    {githubStatusMessage && (
                      <div className={`p-3 border text-xs flex items-center gap-2 ${
                        githubStatusMessage.type === 'success' 
                          ? 'border-emerald-500/50 bg-emerald-950/20 text-emerald-400' 
                          : 'border-red-500/50 bg-red-950/20 text-red-400'
                      }`}>
                        {githubStatusMessage.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{githubStatusMessage.text}</span>
                      </div>
                    )}

                    {/* If Connected: Show User Card, Push Button & Create Repo */}
                    {githubUser && (
                      <div className="space-y-6 pt-2">
                        
                        {/* Profile Info */}
                        <div className="p-3 border border-neutral-800 bg-neutral-950 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <img src={githubUser.avatar_url} alt={githubUser.login} className="w-9 h-9 rounded-full border border-neutral-700" />
                            <div>
                              <div className="text-xs font-bold text-white">{githubUser.name || githubUser.login}</div>
                              <div className="text-[11px] text-neutral-400 font-mono">@{githubUser.login}</div>
                            </div>
                          </div>
                          <span className="text-[10px] text-emerald-400 bg-emerald-950/50 border border-emerald-800 px-2 py-0.5">CONNECTED</span>
                        </div>

                        {/* Push Active Workspace Code */}
                        <div className="border border-neutral-800 p-4 bg-neutral-950/60 space-y-3">
                          <div className="text-xs font-bold uppercase text-white tracking-wider flex items-center gap-2">
                            <UploadIcon className="w-3.5 h-3.5 text-emerald-400" />
                            Push Workspace to Repository
                          </div>
                          
                          <div className="space-y-2">
                            <label className="text-[10px] uppercase text-neutral-400 tracking-wider block">Target Repo</label>
                            <input
                              type="text"
                              value={targetRepoName}
                              onChange={(e) => setTargetRepoName(e.target.value)}
                              placeholder="e.g. devora-app or my-repo"
                              className="w-full bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-mono outline-none"
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="text-[10px] uppercase text-neutral-400 tracking-wider block">Commit Message</label>
                            <input
                              type="text"
                              value={commitMessage}
                              onChange={(e) => setCommitMessage(e.target.value)}
                              placeholder="Commit message..."
                              className="w-full bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-sans outline-none"
                            />
                          </div>

                          <button
                            type="button"
                            onClick={handlePushToGithub}
                            disabled={isPushing || !targetRepoName.trim()}
                            className="w-full py-2.5 border border-emerald-600 bg-emerald-950/40 hover:bg-emerald-600 hover:text-white text-emerald-400 text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer disabled:opacity-40"
                          >
                            {isPushing ? 'Pushing Code to GitHub...' : `Push ${selectedWorkspace?.files.length} Files to GitHub`}
                          </button>

                          {lastPushUrl && (
                            <a 
                              href={lastPushUrl} 
                              target="_blank" 
                              rel="noreferrer" 
                              className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 justify-center pt-1"
                            >
                              <span>View commit on GitHub</span>
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>

                        {/* Create New Repo Form */}
                        <form onSubmit={handleCreateGithubRepo} className="border border-neutral-900 p-4 bg-neutral-950/30 space-y-3">
                          <div className="text-xs font-bold uppercase text-white tracking-wider">
                            Create New Repository
                          </div>

                          <input
                            type="text"
                            placeholder="repository-name"
                            value={newRepoName}
                            onChange={(e) => setNewRepoName(e.target.value)}
                            className="w-full bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-mono outline-none"
                          />

                          <div className="flex items-center justify-between text-xs text-neutral-400">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input 
                                type="checkbox" 
                                checked={newRepoPrivate} 
                                onChange={(e) => setNewRepoPrivate(e.target.checked)} 
                                className="accent-white"
                              />
                              <span>Make Private</span>
                            </label>
                            <button
                              type="submit"
                              disabled={isCreatingRepo || !newRepoName.trim()}
                              className="px-3 py-1.5 border border-neutral-700 hover:border-white text-xs font-medium uppercase transition-all disabled:opacity-40 cursor-pointer"
                            >
                              {isCreatingRepo ? 'Creating...' : '+ Create Repo'}
                            </button>
                          </div>
                        </form>

                      </div>
                    )}
                  </div>
                )}

                {/* ----------------------------------------------------------------- */}
                {/* TAB 3: SECRETS & ENVIRONMENT VARIABLES                            */}
                {/* ----------------------------------------------------------------- */}
                {settingsTab === 'SECRETS' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-xs uppercase font-bold text-neutral-200 tracking-wider mb-1">
                        ENVIRONMENT SECRETS & KEYS
                      </h3>
                      <p className="text-xs text-neutral-400 leading-relaxed font-normal">
                        Store project credentials and environment variables for local execution.
                      </p>
                    </div>

                    {/* Add New Secret Form */}
                    <form onSubmit={handleAddSecret} className="border border-neutral-900 p-4 bg-neutral-950 space-y-3">
                      <div className="text-xs font-bold uppercase text-white tracking-wider">
                        Add New Secret
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          placeholder="KEY_NAME (e.g. STRIPE_KEY)"
                          value={newSecretKey}
                          onChange={(e) => setNewSecretKey(e.target.value)}
                          className="bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-mono outline-none uppercase"
                        />
                        <input
                          type="text"
                          placeholder="value_xxxxxxxx"
                          value={newSecretValue}
                          onChange={(e) => setNewSecretValue(e.target.value)}
                          className="bg-black border border-neutral-800 text-xs px-3 py-2 text-white font-mono outline-none"
                        />
                      </div>

                      <div className="flex justify-end">
                        <button
                          type="submit"
                          disabled={!newSecretKey.trim()}
                          className="px-4 py-1.5 border border-neutral-700 hover:border-white text-xs font-medium uppercase tracking-wider transition-all disabled:opacity-40 cursor-pointer"
                        >
                          + Add Secret
                        </button>
                      </div>
                    </form>

                    {/* Secrets List */}
                    <div className="space-y-2">
                      <div className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">
                        Configured Variables ({secretsList.length})
                      </div>
                      
                      <div className="space-y-1.5">
                        {secretsList.map((sec) => (
                          <div
                            key={sec.id}
                            className="p-3 border border-neutral-800 bg-neutral-950 flex items-center justify-between font-mono text-xs"
                          >
                            <div className="flex-1 mr-2 overflow-hidden">
                              <div className="text-neutral-300 font-semibold">{sec.key}</div>
                              <div className="text-neutral-500 text-[11px] truncate">
                                {sec.visible ? sec.value : '••••••••••••••••••••'}
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => toggleSecretVisibility(sec.id)}
                                className="text-neutral-400 hover:text-white p-1 cursor-pointer"
                                title={sec.visible ? "Hide Value" : "Show Value"}
                              >
                                {sec.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSecret(sec.id)}
                                className="text-neutral-500 hover:text-red-400 p-1 cursor-pointer"
                                title="Delete Secret"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Export .env Button */}
                    <button
                      type="button"
                      onClick={() => {
                        const envContent = secretsList.map(s => `${s.key}="${s.value}"`).join('\n');
                        navigator.clipboard.writeText(envContent);
                        alert('.env formatted secrets copied to clipboard!');
                      }}
                      className="w-full py-2.5 border border-neutral-800 hover:border-neutral-500 text-xs uppercase tracking-wider text-neutral-300 hover:text-white transition-all cursor-pointer bg-neutral-950 font-mono"
                    >
                      Copy .env Export String
                    </button>
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
              <div className="w-full max-w-md border border-neutral-800 bg-neutral-950 p-6 space-y-4 shadow-2xl">
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
                  className="w-full bg-black border border-neutral-800 focus:border-neutral-600 text-white text-xs p-3 outline-none font-sans"
                />
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowBugModal(false)}
                    className="px-4 py-2 border border-neutral-800 hover:border-neutral-600 text-xs uppercase cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDownloadBugReport}
                    className="px-4 py-2 border border-neutral-700 hover:border-white text-xs font-semibold uppercase cursor-pointer bg-neutral-900 text-white flex items-center gap-1.5"
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
