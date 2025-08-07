const express = require('express');
const https = require('https');
// Use node-fetch for environments where global fetch is not available (e.g. older Node versions).
let fetchFn;
try {
  // Node 18+ provides a global fetch implementation. Use it if available.
  if (typeof fetch === 'function') {
    fetchFn = fetch;
  }
} catch (e) {
  // no-op
}
// If global fetch is unavailable, load it from node-fetch
if (!fetchFn) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fetchFn = require('node-fetch');
}
const path = require('path');
// Load environment variables from .env if present
require('dotenv').config();

const app = express();
app.use(express.json());

/**
 * Translate an Arabic line to English and provide a romanization (transliteration)
 * using the unofficial Google Translate endpoint. This endpoint does not
 * guarantee long‑term availability but works without an API‑key at the time of writing.
 *
 * @param {string} line Arabic text to translate
 * @returns {Promise<{translation:string, romanization:string}>}
 */
async function translateLine(line) {
  // If an OpenAI API key is present, use it for translation and transliteration
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      // Allow specifying a custom model via environment variable; default to gpt-4o if available
      const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
      // Log which model is being used for debugging (truncated input to avoid logging full text)
      console.log(`Using OpenAI model ${model} for translation. Input snippet: ${line.slice(0, 30)}...`);
      const payload = {
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful translator. For each Arabic input, provide a transliteration using Franco-Arabic numerals (e.g. 3 represents ع, 7 represents ح, 2 represents ء, 5 represents خ) and an English translation. Output a JSON object with keys "franco" and "english" and no additional commentary.',
          },
          {
            role: 'user',
            content: line,
          },
        ],
        temperature: 0.3,
      };
      const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }
      const content = data.choices[0].message.content.trim();
      let translation = '';
      let romanization = '';
      // First try to parse JSON
      try {
        const obj = JSON.parse(content);
        romanization = obj.franco || obj.romanization || obj.transliteration || '';
        translation = obj.english || obj.translation || '';
      } catch (err) {
        // If not JSON, try to extract via regex labels
        const francoMatch = content.match(/franco\s*:\s*([\s\S]+?)\n/i);
        const englishMatch = content.match(/english\s*:\s*([\s\S]+)/i);
        if (francoMatch) romanization = francoMatch[1].trim();
        if (englishMatch) translation = englishMatch[1].trim();
        if (!romanization || !translation) {
          // Fallback: assume the first line is the romanization and the rest is translation
          const parts = content.split(/\n+/);
          if (parts.length >= 2) {
            romanization = parts[0].trim();
            translation = parts.slice(1).join('\n').trim();
          } else {
            translation = content;
          }
        }
      }
      return { translation, romanization };
    } catch (err) {
      // If OpenAI call fails, fall back to Google translation
      console.error('OpenAI translation failed:', err.message);
    }
  }
  // Fallback to Google Translate romanization and translation (free and no API key)
  return new Promise((resolve, reject) => {
    const query = encodeURIComponent(line);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ar&tl=en&dt=t&dt=rm&q=${query}`;
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            const translation = (result[0] && result[0][0] && result[0][0][0]) || '';
            let romanization = '';
            if (result[0] && result[0][0] && result[0][0][3]) romanization = result[0][0][3];
            resolve({ translation, romanization });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

// API endpoint to translate an array of Arabic lines
app.post('/api/translate', async (req, res) => {
  const lines = req.body.lines;
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'Body must contain an array of lines' });
  }
  const results = [];
  for (const line of lines) {
    try {
      const { translation, romanization } = await translateLine(line);
      results.push({ arabic: line, english: translation, franco: romanization });
    } catch (err) {
      results.push({ arabic: line, english: '', franco: '' });
    }
  }
  res.json({ results });
});

// Serve static files from the webapp directory
const staticDir = path.join(__dirname, 'webapp');
app.use(express.static(staticDir));

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});