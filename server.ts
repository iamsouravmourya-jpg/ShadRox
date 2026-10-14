import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // API Route for Gemini Chat / Code Generation with dynamic model & BYOK
  app.post('/api/chat', async (req, res) => {
    try {
      const { messages, systemInstruction, apiKey, model: requestedModel } = req.body;
      const keyToUse = apiKey || process.env.GEMINI_API_KEY;

      if (!keyToUse) {
        return res.status(400).json({ 
          error: 'Gemini API key is not configured. Please provide your BYOK API key in Settings > Chat or set GEMINI_API_KEY.' 
        });
      }

      const ai = new GoogleGenAI({ apiKey: keyToUse });
      const model = requestedModel || 'gemini-2.5-flash';

      const userMessage = messages && messages.length > 0 ? messages[messages.length - 1].content : '';
      const previousHistory = messages && messages.length > 1 ? messages.slice(0, -1) : [];

      const chatHistory = previousHistory.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));

      const chat = ai.chats.create({
        model,
        history: chatHistory,
        config: {
          systemInstruction: systemInstruction || 'You are Devora, an elite AI coding engine inside an ultra-clean minimalist IDE studio workspace. Help the developer write clean, robust code, debug quickly, and build applications.'
        }
      });

      const result = await chat.sendMessage({
        message: userMessage
      });

      const responseText = result.text || 'No response generated.';
      const tokensCount = Math.round((userMessage.length + responseText.length) / 4);

      res.json({
        reply: responseText,
        tokens: tokensCount
      });
    } catch (error: any) {
      console.error('Gemini API Error:', error);
      res.status(500).json({ error: error.message || 'Internal server error during AI generation.' });
    }
  });

  // API Route for Voice Prompt Pipeline: Input in any Indian/Global Language -> Translation -> Refined Structured Prompt
  app.post('/api/refine-prompt', async (req, res) => {
    try {
      const { rawPrompt, apiKey, contextInfo } = req.body;
      if (!rawPrompt || !rawPrompt.trim()) {
        return res.status(400).json({ error: 'Prompt text is required for refinement.' });
      }

      const keyToUse = apiKey || process.env.GEMINI_API_KEY;
      if (!keyToUse) {
        return res.status(400).json({ 
          error: 'Gemini API key is required. Please set your key in Settings > Chat.' 
        });
      }

      const ai = new GoogleGenAI({ apiKey: keyToUse });
      const model = 'gemini-2.5-flash';

      const instruction = `You are the Devora Multilingual Prompt Refinement & Engineering Engine.
The user speaks or types in any language (Hindi, Hinglish, Bengali, Tamil, Telugu, Marathi, Gujarati, Spanish, French, or English).
Your task is a 3-step pipeline:
1. Identify the input language and transcribe/translate it into clear, accurate developer English.
2. Analyze the true developer intent (what feature, fix, component, or logic the user actually wants).
3. Transform it into an optimal, high-context, structured prompt for Devora AI Coding Engine. Include context: ${contextInfo || 'React/TypeScript workspace'}.

Respond strictly in valid JSON with this exact schema:
{
  "detectedLanguage": "string (e.g. Hindi, Hinglish, Tamil, English)",
  "translatedText": "string (direct English translation)",
  "intent": "string (concise summary of developer intent)",
  "refinedPrompt": "string (structured, high-clarity developer prompt ready for code generation)"
}`;

      const response = await ai.models.generateContent({
        model,
        contents: rawPrompt,
        config: {
          systemInstruction: instruction,
          responseMimeType: 'application/json'
        }
      });

      let parsedResult;
      try {
        parsedResult = JSON.parse(response.text || '{}');
      } catch (e) {
        parsedResult = {
          detectedLanguage: 'Auto-detected',
          translatedText: rawPrompt,
          intent: 'Code modification',
          refinedPrompt: rawPrompt
        };
      }

      res.json(parsedResult);
    } catch (error: any) {
      console.error('Refine Prompt Error:', error);
      res.status(500).json({ error: error.message || 'Error refining voice prompt.' });
    }
  });

  // API Route: Test Gemini API Key and report latency
  app.post('/api/test-key', async (req, res) => {
    const startTime = Date.now();
    try {
      const { apiKey } = req.body;
      const keyToUse = apiKey || process.env.GEMINI_API_KEY;

      if (!keyToUse) {
        return res.status(400).json({ error: 'No API key provided or configured in environment.' });
      }

      const ai = new GoogleGenAI({ apiKey: keyToUse });
      const testResult = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: 'ping',
      });

      const latencyMs = Date.now() - startTime;
      res.json({
        success: true,
        latencyMs,
        message: 'Key validated successfully. Gemini 2.5 Flash operational.'
      });
    } catch (error: any) {
      console.error('Test Key Error:', error);
      res.status(500).json({ 
        success: false,
        error: error.message || 'Key validation failed. Please check key validity.' 
      });
    }
  });

  // API Route: GitHub Token Validation
  app.post('/api/github/validate', async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: 'GitHub personal access token is required.' });
      }

      const ghResponse = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Devora-AI-Studio'
        }
      });

      if (!ghResponse.ok) {
        const errorData = await ghResponse.json().catch(() => ({}));
        return res.status(ghResponse.status).json({ 
          error: errorData.message || 'Invalid GitHub token. Please verify permissions (repo scope required).' 
        });
      }

      const userData = await ghResponse.json();

      // Fetch user repos
      const reposResponse = await fetch('https://api.github.com/user/repos?sort=updated&per_page=10', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Devora-AI-Studio'
        }
      });

      const repos = reposResponse.ok ? await reposResponse.json() : [];

      res.json({
        user: {
          login: userData.login,
          name: userData.name || userData.login,
          avatar_url: userData.avatar_url,
          html_url: userData.html_url,
          public_repos: userData.public_repos
        },
        repos: repos.map((r: any) => ({
          name: r.name,
          full_name: r.full_name,
          html_url: r.html_url,
          private: r.private,
          updated_at: r.updated_at
        }))
      });
    } catch (error: any) {
      console.error('GitHub Validate Error:', error);
      res.status(500).json({ error: error.message || 'Failed to authenticate with GitHub.' });
    }
  });

  // API Route: Create GitHub Repository
  app.post('/api/github/create-repo', async (req, res) => {
    try {
      const { token, name, description, isPrivate } = req.body;
      if (!token || !name) {
        return res.status(400).json({ error: 'GitHub token and repository name are required.' });
      }

      const response = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Devora-AI-Studio'
        },
        body: JSON.stringify({
          name: name.trim().replace(/\s+/g, '-'),
          description: description || 'Created with Devora AI IDE Studio',
          private: !!isPrivate,
          auto_init: true
        })
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: data.message || 'Failed to create repository.' });
      }

      res.json({
        success: true,
        repo: {
          name: data.name,
          full_name: data.full_name,
          html_url: data.html_url,
          clone_url: data.clone_url,
          private: data.private
        }
      });
    } catch (error: any) {
      console.error('Create Repo Error:', error);
      res.status(500).json({ error: error.message || 'Error creating repository on GitHub.' });
    }
  });

  // API Route: Push Files to GitHub Repository
  app.post('/api/github/push', async (req, res) => {
    try {
      const { token, owner, repo, files, commitMessage } = req.body;
      if (!token || !owner || !repo || !files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Missing required parameters (token, owner, repo, files).' });
      }

      const results = [];
      const message = commitMessage || `Update from Devora AI Studio - ${new Date().toISOString()}`;

      for (const file of files) {
        // Check if file exists to get SHA for update
        const getFileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${file.name}`;
        let sha: string | undefined = undefined;

        const checkRes = await fetch(getFileUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Devora-AI-Studio'
          }
        });

        if (checkRes.ok) {
          const checkData = await checkRes.json();
          sha = checkData.sha;
        }

        const encodedContent = Buffer.from(file.content || '').toString('base64');

        const putRes = await fetch(getFileUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Devora-AI-Studio'
          },
          body: JSON.stringify({
            message,
            content: encodedContent,
            ...(sha ? { sha } : {})
          })
        });

        const putData = await putRes.json();
        results.push({
          file: file.name,
          status: putRes.ok ? 'success' : 'failed',
          error: putRes.ok ? null : putData.message
        });
      }

      res.json({
        success: true,
        results,
        repoUrl: `https://github.com/${owner}/${repo}`
      });
    } catch (error: any) {
      console.error('GitHub Push Error:', error);
      res.status(500).json({ error: error.message || 'Error pushing code to GitHub.' });
    }
  });

  // Create Vite server in middleware mode
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Devora Engine server running on http://localhost:${port}`);
  });
}

startServer();
