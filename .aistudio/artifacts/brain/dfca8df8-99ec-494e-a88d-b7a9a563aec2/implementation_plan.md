# Implementation Plan - Groq BYOK & Automated Self-Healing Preview Engine

## Proposed Changes

### 1. Groq API Key Client-Side BYOK Settings Integration
- Add a new **Groq BYOK** settings tab in the Settings drawer.
- Allow users to input their Groq API Key (for Llama-3 / Mixtral inference).
- Configure proxy route `/api/groq-chat` and `/api/groq-refine` in `server.ts` to support Groq API calls alongside Gemini.

### 2. Automated Self-Healing Preview Error Detector & Full-Screen Viewer
- Add a **Full-Screen Expand** toggle on the Real-Time Preview frame header in Partition B.
- Implement an **Error Capture & Self-Healing Engine** that intercepts runtime errors / console exceptions in the preview sandbox, captures stack traces, and automatically triggers an AI fix prompt to Devora AI.
- Display a floating "Self-Healing AI Fixing..." banner when an error is captured and resolved.

## Verification Plan
- Verify compilation with `compile_applet`.
- Test Groq API key configuration and prompt refinement.
- Test preview full-screen mode and automatic error self-healing simulation.
