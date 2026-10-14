# Devora // AI IDE Studio Workspace

> **Next-Generation Minimalist Dark Ink AI Workstation with Indic/Multilingual Voice Prompting, BYOK Architecture, and Integrated GitHub Synchronization.**

![Devora Studio Preview](https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=1200&q=80)

---

## ⚡ Overview

**Devora** is a high-performance, distraction-free AI IDE and developer workstation built on an absolute minimalist dark matrix philosophy. Designed for zero-lag client execution, Devora combines an intelligent multilingual voice pipeline with Gemini AI models, source code editing, live sandboxing, and direct GitHub repository controls.

---

## 🚀 Key Features

### 1. Multilingual Voice-to-Code Pipeline
- **Microphone Input**: Speak naturally in **Hindi, Hinglish, Bengali, Tamil, Telugu, Marathi, Gujarati, Spanish, French, or English**.
- **Instant Translation & Intent Parsing**: Automatically detects the spoken language, translates into standard developer English, and deduces the exact engineering goal.
- **Prompt Refinement Engine**: Structures conversational speech into a production-grade prompt with tech stack context, target files, and requirements before executing.
- **Pipeline Flow**: `Microphone Input` ➔ `Translation` ➔ `Refined Developer Prompt` ➔ `Devora AI Engine`.

### 2. The 35/65 Split Matrix Studio (Stage 3)
- **Partition A (35% Viewport) — Chat Terminal Controller**:
  - Real-time AI chat powered by Google Gemini (`gemini-2.5-flash`, `gemini-2.5-pro`).
  - Active workspace context awareness.
  - BYOK status telemetry and live word/token counting.
  - Multi-language voice input with translation status badge.
- **Partition B (65% Viewport) — Code & Digital Preview Stage**:
  - **Source Code View**: Interactive monospaced syntax view, line numbers, file switcher, inline code editing, file additions, and 1-click clipboard copy.
  - **Real-Time Preview**: Interactive sandbox rendering active workspace components in real time.

### 3. Settings Suite (3 Dedicated Modules)
1. **Chat & Models (BYOK)**:
   - Configure custom Gemini API Key (BYOK) or toggle default environment key.
   - Switch AI models between `gemini-2.5-flash` (ultra-fast) and `gemini-2.5-pro` (deep reasoning).
   - Toggle multilingual voice refinement engine.
2. **GitHub Integration**:
   - Connect via GitHub Personal Access Token (PAT).
   - View profile, repositories, and connection status.
   - 1-Click repository creation (Public or Private).
   - Direct push of active workspace files to GitHub with custom commit messages.
3. **Secrets Manager**:
   - Securely manage project environment variables (`.env`).
   - Add, edit, toggle visibility, and delete secrets.
   - 1-Click export to `.env` format.

### 4. Local Discovery & Workspace Router (Stage 2)
- Mount local folder directories via folder selector.
- Pre-packaged templates: `devora-core-engine`, `devora-ui-components`, `devora-neural-matrix`.
- Track recent workspaces history stack.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Motion
- **Backend / Proxy**: Express, Node.js, `@google/genai` SDK
- **AI Models**: Google Gemini 2.5 Flash & Gemini 2.5 Pro
- **Voice**: Web Speech Recognition API + Devora Multilingual Prompt Engine
- **VCS**: GitHub REST API (v3)

---

## 📦 Getting Started

### Prerequisites
- Node.js (v18 or higher)
- NPM or PNPM
- Google Gemini API Key (optional if using BYOK in-app)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/devora-ai-studio.git
   cd devora-ai-studio
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   Add your Gemini API key (or enter it inside the app via Settings):
   ```env
   GEMINI_API_KEY="your_gemini_api_key_here"
   PORT=3000
   ```

4. **Launch Dev Server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ⚙️ How to Connect GitHub in Devora

1. In the Devora Studio top bar, click **⚙ SETTINGS**.
2. Select the **GitHub** tab.
3. Generate a GitHub Personal Access Token with `repo` scope at: [https://github.com/settings/tokens](https://github.com/settings/tokens).
4. Paste the token into Devora and click **Connect GitHub Account**.
5. You can now create new repositories and push your workspace files directly!

---

## 📄 License

Apache-2.0 License. Built for high-efficiency developers.
