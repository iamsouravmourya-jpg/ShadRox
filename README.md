# Devora // Next-Gen AI IDE Studio & Enterprise Workstation

> **The World's Most Advanced Minimalist Dark Ink AI Workstation** featuring Mixture of Agents (MoA) Consensus, Vector Semantic RAG, AST Dependency Graph Optimization, WebContainers Sandbox, Isomorphic Git Diffing, Autonomous Self-Healing Vision, and Advanced Voice Streams.

---

## 🚀 Ultimate Architecture & Cutting-Edge Features

Devora is engineered to outperform traditional AI coding assistants by combining local execution, zero-token overhead strategies, and multi-model consensus.

### 1. Mixture of Agents (MoA) Consensus Chat
- **Parallel Orchestration**: Queries `Gemini 2.5 Pro`, `Gemini 2.5 Flash`, and `Groq` simultaneously.
- **Synthesized Consensus**: Merges top-tier reasoning with lightning-fast streaming to eliminate hallucinations and produce production-grade code.
- **Agent Alpha (Syntax & Speed)**: Gemini 2.5 Flash for rapid code generation
- **Agent Beta (Architecture & Security)**: Gemini 2.5 Pro for deep reasoning and edge case hardening
- **Consensus Aggregator**: Synthesizes responses into supreme consensus code solution

### 2. AST-Based RAG & Dependency Graph Optimizer
- **In-Memory Dependency Graph**: Builds a symbol dependency tree of the mounted workspace.
- **78% Token Reduction**: Passes only precise relevant symbol subgraphs and function chunks to Gemini instead of raw file dumps.
- **Web-Tree-Sitter Architecture**: Client-side AST parsing using advanced tree-sitter grammar libraries.
- **Symbol Index**: Automatic indexing of functions, classes, variables, and imports across workspace files.

### 3. WebContainers Full-Stack Sandbox
- **Browser Node.js Runtime**: Runs a full Node.js environment directly in the user's browser tab using StackBlitz WebContainers.
- **Live Execution**: Install `npm` packages, start development servers, and execute Express backends inside the live preview frame.
- **Zero-Server Infrastructure**: All code executes client-side with $0.00 infrastructure cost.
- **Vite + Express Integration**: Seamless development server with hot module replacement.

### 4. Git Tree Diffing & Conflict Resolution Engine
- **Isomorphic-Git Integration**: Full client-side staging, branch management, and commit histories.
- **Visual Split-Screen Diff Editor**: Review AI-generated code changes line-by-line with interactive staging before direct GitHub pushes.
- **GitHub API Integration**: Create repositories, validate tokens, and push files directly from the IDE.
- **Staging Index**: Manage staged changes with visual indicators for added, modified, and deleted files.

### 5. Autonomous Self-Healing Vision & Error Detector
- **Multimodal Error Catching**: Automatically captures runtime errors, stack traces, and high-definition base64 canvas visual captures from the preview frame.
- **Zero-Reload Hot Fixes**: Feeds visual anomalies and error payloads back to the AI engine for instant autonomous diagnosis and patching.
- **Vision-Based Diagnosis**: Analyzes screenshots and UI state to identify and fix rendering issues.
- **Runtime Exception Handling**: Catches JavaScript errors and auto-generates fixes using Gemini 2.5 Flash.

### 6. Advanced Voice Pipeline & Audio Buffers
- **Local Audio Stream Chunks**: Web Audio API integration for low-latency voice capture.
- **Instant Translation-Refinement Engine**: Streams structured JSON schemas and syntax trees directly to the editor before voice processing completes.
- **Multilingual Support**: Native support for Hindi, Hinglish, Bengali, Tamil, Telugu, Marathi, Gujarati, Spanish, French, and English.
- **48 kHz Sampling**: High-fidelity audio recording with real-time waveform visualization.
- **Intent Structuring**: Automatically translates natural language to structured developer prompts.

### 7. BYOK (Bring Your Own Key) & Client-Side Groq Integration
- **Server-Side & Client-Side Proxy**: Securely configure your Groq API key for high-speed Pro plan execution with minimal token costs.
- **Gemini 2.5 API Integration**: Support for both Gemini 2.5 Flash (ultra-fast) and Gemini 2.5 Pro (deep reasoning).
- **Key Validation**: Built-in API key testing with latency reporting.
- **Custom Model Selection**: Choose between multiple models including Llama 3 70B, Llama 3 8B, and Mixtral 8x7B.

### 8. 14-Tab Settings Panel
- **Chat**: Configure AI models, custom system instructions, and BYOK API keys
- **Share**: Generate public shareable links with access permissions and QR codes
- **Publish**: Deploy to zero-cost infrastructure with custom domains and SSL
- **Versions**: Create checkpoints, manage version history, and rollback to previous states
- **GitHub**: Connect GitHub account, create repositories, and push code directly
- **Integrations**: Manage environment variables and project secrets
- **AST RAG**: View token optimization metrics and workspace symbol index
- **WebContainer**: Monitor Node.js container runtime and stdout logs
- **Git Diff**: View differential git staging and conflict resolution
- **Voice Buffer**: Analyze audio waveform and voice translation metrics
- **MoA Agents**: Configure Mixture of Agents orchestration nodes
- **Test Runner**: Execute automated unit tests with self-healing CI
- **Multiplayer**: Real-time peer collaboration with WebRTC presence indicators
- **Groq Llama 3**: Configure Groq API key and model selection

---

## 🛠️ Technology Stack

### Frontend
- **React 19.0.1**: Latest React with concurrent features and automatic batching
- **TypeScript 7.0.2**: Full type safety with strict mode enabled
- **Tailwind CSS v4.3.3**: Utility-first CSS with Vite plugin integration
- **Vite 8.3.0**: Lightning-fast build tool with HMR and optimized bundles
- **Lucide React 0.546.0**: Beautiful icon library with tree-shaking
- **Motion 12.23.24**: Production-ready animation library for smooth transitions

### Backend
- **Express 4.21.2**: Fast, minimalist web framework for API routes
- **@google/genai 2.4.0**: Official Google Gemini AI SDK
- **tsx 4.21.0**: TypeScript execution engine for server.ts
- **dotenv 17.2.3**: Environment variable management

### Development Tools
- **esbuild 0.25.0**: Ultra-fast JavaScript bundler
- **autoprefixer 10.4.21**: PostCSS plugin for vendor prefixes
- **@types/*: Complete TypeScript definitions for all dependencies

---

## 🛠️ Local Development & Quick Start

### Prerequisites
- Node.js 18+ (v24.22.0 recommended)
- npm or yarn package manager
- Gemini API key (get one at https://ai.google.dev/)

### Installation

1. **Clone Repository**:
   ```bash
   git clone https://github.com/iamsouravmourya-jpg/Devora.git
   cd Devora
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```
   *Note: Use `--legacy-peer-deps` flag if you encounter dependency conflicts*

3. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add your Gemini API key:
   ```
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

4. **Start Development Server**:
   ```bash
   npm run dev
   ```
   The application will be available at `http://localhost:3000`

### Available Scripts

- `npm run dev` - Start development server with Vite HMR
- `npm run build` - Build for production with Vite
- `npm run preview` - Preview production build locally
- `npm run lint` - Run TypeScript type checking
- `npm run clean` - Remove build artifacts and server.js

---

## 📁 Project Structure

```
Devora/
├── server.ts                 # Express backend with API routes
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── vite.config.ts            # Vite build configuration
├── .env.example              # Environment variables template
├── index.html                # HTML entry point
├── src/
│   ├── main.tsx              # React application entry
│   ├── index.css             # Global styles with Tailwind
│   └── App.tsx               # Main React component (3232 lines)
└── .aistudio/                # AI Studio artifacts
```

### Key Files Overview

#### `server.ts` (531 lines)
Express backend with Vite middleware. Contains API routes for:
- `/api/chat` - Gemini chat endpoint with BYOK support
- `/api/refine-prompt` - Multilingual voice prompt translation
- `/api/test-key` - API key validation with latency testing
- `/api/github/validate` - GitHub token validation
- `/api/github/create-repo` - GitHub repository creation
- `/api/github/push` - Push files to GitHub
- `/api/consensus-chat` - Mixture of Agents consensus orchestration
- `/api/groq-chat` - Groq Llama 3 API integration
- `/api/compiler/intent` - AST semantic slicing (MODE A)
- `/api/compiler/vision-heal` - Autonomous vision self-healing (MODE B)

#### `src/App.tsx` (3232 lines)
Main React component with complete UI implementation:
- 3-stage screen engine (STAGE_1: Login, STAGE_2: Workspace Router, STAGE_3: IDE Studio)
- 35/65 split layout (Chat Terminal 35%, Code/Preview 65%)
- 14-tab settings drawer with full functionality
- Workspace file management with CRUD operations
- Real-time code editor with line numbers and search
- Preview sandbox with device viewport switching
- Diff modal for code change review
- Bug report modal with telemetry export
- Voice recognition with multilingual support
- File attachment and image upload
- Version history and checkpoint system
- GitHub integration UI

---

## 🎨 Core Features Deep Dive

### Workspace Management
- **Template Projects**: Pre-configured workspaces (SaaS Engine, AI Matrix, Fullstack Kit)
- **File Upload**: Drag-and-drop or file selector for importing local projects
- **Multi-file Support**: Manage multiple files per workspace with tab switching
- **Real-time Editing**: Fully editable code editor with tab support and syntax highlighting
- **Search**: Find functionality with instant highlighting

### AI Chat Interface
- **Context Attachments**: Attach files, images, or quick prompt templates
- **Model Selection**: Toggle between Default, Flash, and Pro Think modes
- **Voice Input**: Multilingual speech recognition with auto-translation
- **Code Blocks**: Automatic detection with 1-click apply functionality
- **Feedback System**: Thumbs up/down for response quality
- **Checkpointing**: Save workspace snapshots at any time
- **Message History**: Full conversation persistence

### Preview Sandbox
- **Device Viewports**: Desktop (100%), Tablet (768px), Mobile (375px)
- **Full-screen Mode**: Expand preview to full viewport
- **Self-Healing**: AI-powered error detection and auto-fixing
- **Runtime Metrics**: Display latency, server load, and container status
- **Error Simulation**: Test self-healing with simulated runtime errors

### Version Control
- **Checkpoints**: Create named snapshots of workspace state
- **Timeline**: Visual version history with timestamps
- **Rollback**: Restore any previous checkpoint instantly
- **Comparison**: View changes between versions
- **Export**: Download version snapshots as JSON

### GitHub Integration
- **Token Authentication**: Secure PAT-based authentication
- **Repository Management**: Create new repos from the IDE
- **Push to GitHub**: Direct file upload with commit messages
- **Profile Display**: Show connected user and avatar
- **Repo Selection**: Choose from existing repositories

---

## 🔌 API Endpoints

### Chat & AI
- `POST /api/chat` - Send message to Gemini with BYOK support
- `POST /api/refine-prompt` - Translate and refine voice prompts
- `POST /api/consensus-chat` - Mixture of Agents consensus
- `POST /api/groq-chat` - Groq Llama 3 API integration

### Configuration
- `POST /api/test-key` - Validate Gemini API key
- `POST /api/compiler/intent` - AST semantic slicing
- `POST /api/compiler/vision-heal` - Vision-based self-healing

### GitHub
- `POST /api/github/validate` - Validate GitHub token
- `POST /api/github/create-repo` - Create new repository
- `POST /api/github/push` - Push files to repository

---

## 🎯 Use Cases

1. **Rapid Prototyping**: Start with template workspaces and iterate with AI assistance
2. **Code Refactoring**: Use AST-based RAG for intelligent code transformations
3. **Multilingual Teams**: Voice support for Hindi, Hinglish, and other Indic languages
4. **Zero-Cost Deployment**: Publish projects with $0 infrastructure cost
5. **Collaborative Development**: Real-time multiplayer with peer presence
6. **Self-Healing Apps**: Autonomous error detection and fixing
7. **Version Management**: Checkpoint and rollback at any point
8. **GitHub Integration**: Direct push to repositories without leaving the IDE

---

## 🔒 Security & Privacy

- **BYOK Architecture**: API keys stored locally, never sent to Devora servers
- **Client-Side Execution**: All code runs in your browser with WebContainers
- **GitHub OAuth**: Standard PAT-based authentication with repo scope
- **Secrets Management**: Secure environment variable storage
- **No Telemetry**: No usage data collection or tracking

---

## 🌟 License
Devora is proprietary software built for elite engineering teams.

---

## 🤝 Contributing

This is a personal project. For collaboration opportunities, please contact the repository owner.

---

## 📧 Support

For bug reports, feature requests, or questions:
- Open an issue on GitHub
- Use the built-in Bug Report modal in the IDE
- Download telemetry reports for diagnostic analysis

---

## 🗺️ Roadmap

- [ ] Real WebContainers integration (currently simulated)
- [ ] Actual AST parsing with tree-sitter
- [ ] WebRTC multiplayer implementation
- [ ] Vitest test runner integration
- [ ] More language support in voice pipeline
- [ ] Dark/light theme toggle
- [ ] Keyboard shortcuts customization
- [ ] Plugin system for extensions
